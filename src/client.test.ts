import { describe, expect, it } from "bun:test"

import type { AuthResult } from "./auth.ts"
import { fakeNetworkClient, sseResponse } from "./client.fixtures.ts"
import { type Message, sendMessageFull } from "./client.ts"
import { buildSystemPrompt, SYSTEM_PROMPT } from "./headers.ts"

describe("client", () => {
  describe("request body shape", () => {
    it("SYSTEM_PROMPT has 3 blocks: billing, identity, instructions", () => {
      expect(SYSTEM_PROMPT.length).toBeGreaterThanOrEqual(3)
      expect(SYSTEM_PROMPT[0].text).toContain("x-anthropic-billing-header")
      expect(SYSTEM_PROMPT[0].text).toContain("cc_version=2.1.154")
      expect(SYSTEM_PROMPT[1].text).toBe(
        "You are Claude Code, Anthropic's official CLI for Claude.",
      )
      // cache_control is on system[2] (instructions), NOT system[1] (identity)
      expect(SYSTEM_PROMPT[1]).not.toHaveProperty("cache_control")
      expect(SYSTEM_PROMPT[2].cache_control).toEqual({
        type: "ephemeral",
        ttl: "1h",
        scope: "global",
      })
    })

    it("buildSystemPrompt with session context produces 4 blocks", () => {
      const blocks = buildSystemPrompt({ sessionContext: "test context" })
      expect(blocks).toHaveLength(4)
      expect(blocks[3].text).toBe("test context")
      // system[3] now carries cache_control (ttl:"1h", no scope) per 2.1.118
      expect(blocks[3].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    })

    describe("buildSystemPrompt — tool-use loop safety paragraph", () => {
      it("default config appends a reflection-checkpoint paragraph to system[2] (and OMITS the emergency-cap section since the default cap is Infinity)", () => {
        const blocks = buildSystemPrompt()
        const sys2 = blocks[2].text
        // Section heading and the soft-checkpoint contract are present.
        expect(sys2).toContain("# Tool-use loop safety")
        expect(sys2).toContain("no fixed turn cap by default")
        // The default cadence and cooldown make it into the prose with
        // concrete numbers so the model sees the actual config it's
        // running under (not just symbolic placeholders).
        expect(sys2).toContain("every 50 tool rounds")
        expect(sys2).toContain("60-second wall-clock cooldown")
        // Ack/silence opt-out is documented next to the cadence so a
        // model that skipped earlier prose still finds the syntax.
        expect(sys2).toContain('`<ma::agent::reflection-ack silence-for="K" reason="..." />`')
        // Default cap is Infinity, so the emergency-cap paragraph MUST
        // be absent : we don't want the model to think a hard stop
        // exists when none does.
        expect(sys2).not.toContain("emergency hard cap")
        expect(sys2).not.toContain("emergency-cap-triggered")
      })

      it("finite maxToolRounds adds the emergency-cap paragraph with the configured number", () => {
        const blocks = buildSystemPrompt({ maxToolRounds: 200 })
        const sys2 = blocks[2].text
        expect(sys2).toContain("emergency hard cap is configured at 200 rounds")
        expect(sys2).toContain('`<ma::agent::emergency-cap-triggered round="200" />`')
        // The reflection paragraph still leads (cap is the SECOND
        // layer; the reflection checkpoint is the primary device).
        const checkpointIdx = sys2.indexOf("reflection checkpoint")
        const capIdx = sys2.indexOf("emergency hard cap")
        expect(checkpointIdx).toBeGreaterThan(-1)
        expect(capIdx).toBeGreaterThan(checkpointIdx)
      })

      it("reflectionInterval=0 omits the reflection paragraph (checkpoint disabled)", () => {
        const blocks = buildSystemPrompt({ reflectionInterval: 0, maxToolRounds: 100 })
        const sys2 = blocks[2].text
        // Cap still mentioned (it was opt-in).
        expect(sys2).toContain("emergency hard cap is configured at 100 rounds")
        // But the cadence prose is gone : nothing fires every N rounds.
        expect(sys2).not.toContain("every 0 tool rounds")
        expect(sys2).not.toContain("reflection checkpoint fires every")
      })

      it("reflectionCooldownMs=0 keeps the checkpoint but describes it as paused-free", () => {
        const blocks = buildSystemPrompt({ reflectionCooldownMs: 0 })
        const sys2 = blocks[2].text
        expect(sys2).toContain("every 50 tool rounds")
        // No cooldown clause when ms=0.
        expect(sys2).not.toContain("wall-clock cooldown")
        // The attachment is still mentioned with cooldown=0 baked in.
        expect(sys2).toContain('cooldown-applied-seconds="0"')
      })

      it("everything off produces no safety paragraph at all (instructions are pristine)", () => {
        const blocks = buildSystemPrompt({
          reflectionInterval: 0,
          maxToolRounds: Number.POSITIVE_INFINITY,
        })
        const sys2 = blocks[2].text
        expect(sys2).not.toContain("# Tool-use loop safety")
        expect(sys2).not.toContain("reflection")
      })
    })

    describe("buildSystemPrompt — tool output conventions paragraph", () => {
      it("default config OMITS the raw-output conventions paragraph (legacy prompt shape)", () => {
        const blocks = buildSystemPrompt()
        const sys2 = blocks[2].text
        expect(sys2).not.toContain("# Tool output conventions")
        expect(sys2).not.toContain("<ma::agent::raw-output")
      })

      it("blobStoreEnabled=true appends a one-paragraph conventions section", () => {
        const blocks = buildSystemPrompt({ blobStoreEnabled: true })
        const sys2 = blocks[2].text
        expect(sys2).toContain("# Tool output conventions")
        expect(sys2).toContain('<ma::agent::raw-output path="<abs-path>"')
        expect(sys2).toContain('`Read({file_path: "..."})`')
        // The blurb mentions what triggers persistence: large OR clamped.
        expect(sys2).toMatch(/large or got clamped/i)
        // Section comes AFTER the loop-safety paragraph (loop safety is
        // higher priority, conventions are reference material).
        const safetyIdx = sys2.indexOf("# Tool-use loop safety")
        const convIdx = sys2.indexOf("# Tool output conventions")
        expect(safetyIdx).toBeGreaterThan(-1)
        expect(convIdx).toBeGreaterThan(safetyIdx)
      })

      it("blobStoreEnabled=false (explicit) matches the default-off case byte-for-byte", () => {
        const a = buildSystemPrompt({ blobStoreEnabled: false })[2].text
        const b = buildSystemPrompt()[2].text
        expect(a).toBe(b)
      })
    })

    it("conversation request body matches 2.1.118 wire shape", async () => {
      // Empirical verification of tasks #3-#7: capture the actual JSON body
      // sent to /v1/messages and assert it carries (a) cache_control with
      // ttl:"1h" on system[2] and system[3], (b) a rolling cache_control on
      // the trailing message block, (c) top-level context_management, and
      // (d) output_config.effort defaulting to "medium" for opus.
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const sysCtx = "x".repeat(2000) // non-empty session context
      const messages: Message[] = [
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: "last block" },
          ],
        },
      ]

      let capturedBody: string | null = null
      const networkClient = fakeNetworkClient((req) => {
        capturedBody = String(req.body ?? "")
        return sseResponse([
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ])
      })

      // withRollingCacheBreakpoint lives in agent.ts but we replicate its
      // marking here by passing pre-marked messages; the same effect.
      const { withRollingCacheBreakpoint } = await import("./agent.ts")
      const sys = buildSystemPrompt({ sessionContext: sysCtx })
      await sendMessageFull({
        auth,
        messages: withRollingCacheBreakpoint(messages),
        model: "claude-opus-4-7",
        system: sys,
        stream: true,
        networkClient,
      })

      expect(capturedBody).not.toBeNull()
      const body = JSON.parse(capturedBody!)

      // (a) system[2] and system[3] both carry cache_control with ttl:"1h"
      expect(body.system[2].cache_control).toEqual({
        type: "ephemeral",
        ttl: "1h",
        scope: "global",
      })
      expect(body.system[3].cache_control).toEqual({
        type: "ephemeral",
        ttl: "1h",
      })

      // (b) trailing message has cache_control on the LAST block only
      const tail = body.messages[body.messages.length - 1].content
      expect(tail[tail.length - 1].cache_control).toEqual({
        type: "ephemeral",
        ttl: "1h",
      })
      // earlier blocks of the trailing message do NOT carry cache_control
      expect(tail[0].cache_control).toBeUndefined()

      // (c) context_management is present (default for "conversation")
      expect(body.context_management).toEqual({
        edits: [{ type: "clear_thinking_20251015", keep: "all" }],
      })

      // (d) output_config.effort defaults to "medium" for opus
      expect(body.output_config).toEqual({ effort: "medium" })

      // (e) total active cache_control breakpoints stays ≤ 4
      const countBreakpoints = (obj: unknown): number => {
        let n = 0
        const walk = (v: unknown) => {
          if (!v || typeof v !== "object") return
          if (Array.isArray(v)) return v.forEach(walk)
          for (const [k, val] of Object.entries(v)) {
            if (k === "cache_control" && val) n++
            else walk(val)
          }
        }
        walk(obj)
        return n
      }
      const total = countBreakpoints(body)
      expect(total).toBeLessThanOrEqual(4)
      expect(total).toBe(3) // sys[2], sys[3], rolling tail
    })

    it("omits context_management.clear_thinking for haiku (thinking disabled)", async () => {
      // Regression: clear_thinking_20251015 requires `thinking` to be enabled
      // or adaptive. Haiku has no thinking, so the API rejects the request
      // with a 400 if we send the strategy. Verify we drop it.
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      let capturedBody: string | null = null
      const networkClient = fakeNetworkClient((req) => {
        capturedBody = String(req.body ?? "")
        return sseResponse([
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ])
      })

      await sendMessageFull({
        auth,
        messages,
        model: "claude-haiku-4-5-20251001",
        stream: true,
        networkClient,
      })

      const body = JSON.parse(capturedBody!)
      // Haiku: no `thinking` field, and therefore no context_management
      expect(body.thinking).toBeUndefined()
      expect(body.context_management).toBeUndefined()
    })

    it("drops speed:fast (body + beta header) when the model has no fast tier", async () => {
      // Capability gate regression test (fable-5 class of bug): a sticky
      // --fast / MINIMAL_AGENT_FAST=1 must NOT reach the wire for a model
      // whose registry entry says speedFast:false — the server 429s
      // ("Usage credits are required for fast mode."). Uses a synthetic
      // registry entry so this test doesn't depend on plugin bootstrap.
      const { registerModel } = await import("./llm/model-registry.ts")
      const { defaultCapabilities } = await import("./llm/capabilities.ts")
      registerModel({
        id: "test-model-no-fast",
        providerId: "anthropic",
        surfaceId: "anthropic-messages",
        displayName: "Test (no fast tier)",
        capabilities: { ...defaultCapabilities(), speedFast: false },
        pricing: {
          inputUSD: 1,
          outputUSD: 5,
          cacheWriteUSD: 1.25,
          cacheReadUSD: 0.1,
          webSearchPerCallUSD: 0.01,
        },
      })

      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      let capturedBody: string | null = null
      let capturedHeaders: Record<string, string> | null = null
      const networkClient = fakeNetworkClient((req) => {
        capturedBody = String(req.body ?? "")
        capturedHeaders = (req.headers ?? {}) as Record<string, string>
        return sseResponse([
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
        ])
      })

      await sendMessageFull({
        auth,
        messages,
        model: "test-model-no-fast",
        speed: "fast",
        stream: true,
        networkClient,
      })

      const body = JSON.parse(capturedBody!)
      expect(body.speed).toBeUndefined()
      expect(capturedHeaders!["anthropic-beta"] ?? "").not.toContain("fast-mode-2026-02-01")
    })

    it("keeps speed:fast (body + beta header) for a speedFast-capable model", async () => {
      const { registerModel } = await import("./llm/model-registry.ts")
      const { defaultCapabilities } = await import("./llm/capabilities.ts")
      registerModel({
        id: "test-model-fast-ok",
        providerId: "anthropic",
        surfaceId: "anthropic-messages",
        displayName: "Test (fast tier)",
        capabilities: { ...defaultCapabilities(), speedFast: true },
        pricing: {
          inputUSD: 5,
          outputUSD: 25,
          cacheWriteUSD: 6.25,
          cacheReadUSD: 0.5,
          webSearchPerCallUSD: 0.01,
        },
      })

      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      let capturedBody: string | null = null
      let capturedHeaders: Record<string, string> | null = null
      const networkClient = fakeNetworkClient((req) => {
        capturedBody = String(req.body ?? "")
        capturedHeaders = (req.headers ?? {}) as Record<string, string>
        return sseResponse([
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
        ])
      })

      await sendMessageFull({
        auth,
        messages,
        model: "test-model-fast-ok",
        speed: "fast",
        stream: true,
        networkClient,
      })

      const body = JSON.parse(capturedBody!)
      expect(body.speed).toBe("fast")
      expect(capturedHeaders!["anthropic-beta"] ?? "").toContain("fast-mode-2026-02-01")
    })

    it("suppresses context_management when MINIMAL_AGENT_NO_CLEAR_THINKING=1", async () => {
      // Escape hatch to bypass the server-side clear_thinking edit that is the
      // prime suspect for the "thinking/redacted_thinking blocks cannot be
      // modified" 400 on large interleaved-thinking conversations.
      const prev = process.env.MINIMAL_AGENT_NO_CLEAR_THINKING
      process.env.MINIMAL_AGENT_NO_CLEAR_THINKING = "1"
      try {
        const auth: AuthResult = { type: "oauth", token: "test-token" }
        const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
        let capturedBody: string | null = null
        const networkClient = fakeNetworkClient((req) => {
          capturedBody = String(req.body ?? "")
          return sseResponse([
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
          ])
        })
        await sendMessageFull({
          auth,
          messages,
          model: "claude-opus-4-8",
          stream: true,
          networkClient,
        })
        const body = JSON.parse(capturedBody!)
        // thinking stays enabled, but the context-management edit is gone.
        expect(body.thinking).toBeDefined()
        expect(body.context_management).toBeUndefined()
      } finally {
        if (prev === undefined) delete process.env.MINIMAL_AGENT_NO_CLEAR_THINKING
        else process.env.MINIMAL_AGENT_NO_CLEAR_THINKING = prev
      }
    })

    it("includes context_management.clear_thinking when thinking is set (opus/sonnet)", async () => {
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      let capturedBody: string | null = null
      const networkClient = fakeNetworkClient((req) => {
        capturedBody = String(req.body ?? "")
        return sseResponse([
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ])
      })

      await sendMessageFull({
        auth,
        messages,
        model: "claude-opus-4-7",
        stream: true,
        networkClient,
      })

      const body = JSON.parse(capturedBody!)
      expect(body.thinking).toEqual({ type: "adaptive" })
      expect(body.context_management).toEqual({
        edits: [{ type: "clear_thinking_20251015", keep: "all" }],
      })
    })
  })
})
