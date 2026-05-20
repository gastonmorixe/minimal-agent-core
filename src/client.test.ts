import { describe, expect, it } from "bun:test"
import { type AuthResult, getAuth } from "./auth.ts"
import {
  checkQuota,
  type Message,
  sendMessage,
  sendMessageFull,
  sendMessageOnce,
  sendMessageSync,
} from "./client.ts"
import { getDiagnosticBus, isErrorDiagEmitted, type LogEvent, Severity } from "./diagnostic-bus.ts"
import { buildSystemPrompt, SYSTEM_PROMPT } from "./headers.ts"
import {
  NetworkClient,
  type NetworkRequest,
  NetworkResponse,
  type NetworkTransport,
} from "./network/index.ts"
import { clearLastRateLimits } from "./quota-cache.ts"
import { GLOBAL_STATUS_BUS } from "./status.ts"

type FakeHandler = (req: NetworkRequest) => NetworkResponse | Promise<NetworkResponse>

function fakeNetworkClient(handler: FakeHandler): NetworkClient {
  const transport: NetworkTransport = {
    id: "fake",
    request: async (req) => handler(req),
  }
  return new NetworkClient({ primary: transport })
}

function sseResponse(events: unknown[]): NetworkResponse {
  const encoder = new TextEncoder()
  return new NetworkResponse({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    transport: { id: "fake", protocol: "h2" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n`))
        }
        controller.enqueue(encoder.encode("data: [DONE]\n"))
        controller.close()
      },
    }),
  })
}

describe("client", () => {
  describe("request body shape", () => {
    it("SYSTEM_PROMPT has 3 blocks: billing, identity, instructions", () => {
      expect(SYSTEM_PROMPT.length).toBeGreaterThanOrEqual(3)
      expect(SYSTEM_PROMPT[0].text).toContain("x-anthropic-billing-header")
      expect(SYSTEM_PROMPT[0].text).toContain("cc_version=2.1.118")
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
        expect(sys2).toContain('`<ma::reflection-ack silence-for="K" reason="..." />`')
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
        expect(sys2).toContain('`<ma::emergency-cap-triggered round="200" />`')
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

    it("publishes request lifecycle labels to the global status bus while streaming", async () => {
      const auth: AuthResult = {
        type: "oauth",
        token: "test-token",
      }
      const messages: Message[] = [
        { role: "user", content: [{ type: "text", text: "Reply with exactly: PONG" }] },
      ]
      const seen: Array<string | null> = []

      GLOBAL_STATUS_BUS.reset()
      const unsubscribe = GLOBAL_STATUS_BUS.subscribe((label) => {
        seen.push(label)
      })

      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "PONG" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ]),
      )

      try {
        const response = await sendMessageFull({
          auth,
          messages,
          model: "claude-haiku-4-5-20251001",
          maxTokens: 32,
          stream: true,
          networkClient,
        })

        expect(response.text).toBe("PONG")
        // Adjacent-dedupe before asserting: Layer 4 (May 2026) added live
        // `recvTokens` updateActivity() emits during text streaming, which
        // re-fire the bus listener with the SAME label ("Writing response")
        // because StatusBus.emit() always sends the current label. The
        // duplicate emits are correct (the listener is meant to be a
        // "something changed" signal), but the lifecycle-LABEL semantic
        // this test cares about is only meaningful when adjacent dupes are
        // collapsed.
        const dedupedSeen = seen.filter((label, i) => i === 0 || label !== seen[i - 1])
        expect(dedupedSeen).toEqual([
          null,
          "Sending request",
          "Waiting for response",
          "Receiving stream",
          "Writing response",
          null,
        ])
      } finally {
        unsubscribe()
        GLOBAL_STATUS_BUS.reset()
      }
    })

    it("streams native thinking chunks through callbacks and preserves them in blocks", async () => {
      const auth: AuthResult = {
        type: "oauth",
        token: "test-token",
      }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "think" }] }]
      const thinkingChunks: string[] = []
      const thinkingEvents: string[] = []
      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "", signature: "sig-a" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "plan " },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "step" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "sig-b" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "content_block_start",
            index: 1,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "text_delta", text: "answer" },
          },
          { type: "content_block_stop", index: 1 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ]),
      )

      const response = await sendMessageFull({
        auth,
        messages,
        model: "claude-opus-4-7",
        stream: true,
        networkClient,
        onThinkingStart: () => {
          thinkingEvents.push("start")
        },
        onThinkingDelta: (chunk) => {
          thinkingChunks.push(chunk)
        },
        onThinkingStop: () => {
          thinkingEvents.push("stop")
        },
      })

      expect(thinkingEvents).toEqual(["start", "stop"])
      expect(thinkingChunks).toEqual(["plan ", "step"])
      expect(response.text).toBe("answer")
      expect(response.blocks).toEqual([
        { type: "thinking", thinking: "plan step", signature: "sig-asig-b" },
        { type: "text", text: "answer" },
      ])
    })

    it("publishes detailed status updates for tool_use streaming with hint extraction", async () => {
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "edit" }] }]
      const seen: Array<string | null> = []

      GLOBAL_STATUS_BUS.reset()
      const unsubscribe = GLOBAL_STATUS_BUS.subscribe((label) => {
        seen.push(label)
      })

      // Build a Write input split across many input_json_delta events so the
      // throttle has a chance to fire and the hint extractor sees partial JSON.
      const inputJson = JSON.stringify({
        file_path: "/tmp/example.txt",
        content: "x".repeat(4096),
      })
      const chunks: string[] = []
      for (let i = 0; i < inputJson.length; i += 256) {
        chunks.push(inputJson.slice(i, i + 256))
      }

      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          { type: "message_start", message: { usage: {} } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tu_1", name: "Write", input: {} },
          },
          ...chunks.map((partial) => ({
            type: "content_block_delta" as const,
            index: 0,
            delta: { type: "input_json_delta" as const, partial_json: partial },
          })),
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
          },
        ]),
      )

      try {
        const response = await sendMessageFull({
          auth,
          messages,
          model: "claude-opus-4-7",
          stream: true,
          networkClient,
        })

        expect(response.blocks).toHaveLength(1)
        const tu = response.blocks[0] as {
          type: string
          name: string
          input: Record<string, unknown>
        }
        expect(tu.type).toBe("tool_use")
        expect(tu.input.file_path).toBe("/tmp/example.txt")

        // Status flow expectations:
        expect(seen).toContain("Sending request")
        expect(seen).toContain("Waiting for response")
        expect(seen).toContain("Receiving stream")
        // Initial tool_use status
        expect(seen.some((l) => l === "Calling Write: streaming input")).toBe(true)
        // At least one delta-driven update with the parsed file_path hint
        expect(
          seen.some(
            (l) =>
              typeof l === "string" &&
              l.includes("Calling Write:") &&
              l.includes("/tmp/example.txt"),
          ),
        ).toBe(true)
        // Dispatch + finalize
        expect(seen).toContain("Calling Write: dispatching")
        // Cleared at the end
        expect(seen[seen.length - 1]).toBeNull()
      } finally {
        unsubscribe()
        GLOBAL_STATUS_BUS.reset()
      }
    })

    it("publishes recvTokens estimate (chars/3.5) during text_delta streaming", async () => {
      // Layer 4: while the model is streaming text, the SSE loop should
      // throttle-publish a recvTokens estimate to the status bus so the
      // activity infix can show `~N tok · M tok/s`. Without this, the
      // status row would have no live token signal during "Writing
      // response" — bytes only, no per-second tokens.
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      const activities: Array<number | undefined> = []

      GLOBAL_STATUS_BUS.reset()
      const unsubscribe = GLOBAL_STATUS_BUS.subscribe(() => {
        const snap = GLOBAL_STATUS_BUS.currentStatus()
        activities.push(snap?.activity?.recvTokens)
      })

      // Build text deltas totaling ~700 chars → ~200 tok estimate.
      // 7 deltas of 100 chars each, throttle is 100ms → enough emits to
      // see at least one mid-stream publish.
      const longText = "Hello world! ".repeat(70) // 910 chars (close enough)
      const deltas: string[] = []
      for (let i = 0; i < longText.length; i += 100) deltas.push(longText.slice(i, i + 100))

      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          { type: "message_start", message: { usage: {} } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          ...deltas.map((text) => ({
            type: "content_block_delta" as const,
            index: 0,
            delta: { type: "text_delta" as const, text },
          })),
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ]),
      )

      try {
        await sendMessageFull({
          auth,
          messages,
          model: "claude-opus-4-7",
          stream: true,
          networkClient,
        })

        // At least one snapshot must carry a positive recvTokens estimate.
        // The fake transport delivers ALL deltas in one synchronous burst,
        // so the 100ms throttle gates everything after the first publish —
        // we see exactly ONE estimate (the first delta's chars/3.5). Real
        // network delivery is paced over the actual SSE stream and would
        // produce many intermediate estimates, but unit-testing that needs
        // an async-pacing transport. The contract that matters here is
        // "tokens get published live, not just at the end" — pinning the
        // first publish is sufficient evidence.
        const tokenSnaps = activities.filter((t): t is number => typeof t === "number" && t > 0)
        expect(tokenSnaps.length).toBeGreaterThan(0)
        // First delta is 100 chars → Math.round(100 / 3.5) = 29.
        // Allow a tight range since the math is deterministic.
        const firstEstimate = tokenSnaps[0]
        expect(firstEstimate).toBeGreaterThanOrEqual(20)
        expect(firstEstimate).toBeLessThanOrEqual(400)
      } finally {
        unsubscribe()
        GLOBAL_STATUS_BUS.reset()
      }
    })

    it("swaps recvTokens estimate for real value from message_delta.usage.output_tokens", async () => {
      // Layer 4 finalize: when the server ships the authoritative
      // `output_tokens` count in `message_delta`, that value overwrites
      // our estimate. This means the row settles on the BILLED count
      // for the trailing moment before the request clears.
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      const allSnapshots: Array<number | undefined> = []

      GLOBAL_STATUS_BUS.reset()
      const unsubscribe = GLOBAL_STATUS_BUS.subscribe(() => {
        allSnapshots.push(GLOBAL_STATUS_BUS.currentStatus()?.activity?.recvTokens)
      })

      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          { type: "message_start", message: { usage: {} } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "Hello world." }, // ~3 tok estimate
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: 999 }, // sentinel — real value the renderer should land on
          },
        ]),
      )

      try {
        await sendMessageFull({
          auth,
          messages,
          model: "claude-opus-4-7",
          stream: true,
          networkClient,
        })

        // The sentinel 999 must appear in the snapshot stream — that's
        // the message_delta swap firing. The estimate (~3) may or may
        // not appear depending on throttle timing; what's guaranteed is
        // that the real value lands.
        expect(allSnapshots).toContain(999)
      } finally {
        unsubscribe()
        GLOBAL_STATUS_BUS.reset()
      }
    })

    it("publishes recvTokens estimate during thinking_delta streaming (mirrors text_delta)", async () => {
      // Layer 4 follow-up (May 2026): "Thinking" status row was the only
      // streaming phase NOT publishing token estimates after the initial
      // Layer 4 landed — text_delta and input_json_delta both fed
      // outputChars, but thinking_delta was overlooked. User reported
      // the gap with `think very very hard for 1 minute or 3000 words`:
      // status showed `↓ 1.2 KB · 147 B/s · api.anthropic.com:h2 (8s)`
      // — bytes and rate present, no `~N tok` segment despite thousands
      // of tokens of hidden reasoning. Symmetric fix mirrors the
      // text_delta accumulator + throttle.
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "think" }] }]
      const tokenSnaps: number[] = []

      GLOBAL_STATUS_BUS.reset()
      const unsubscribe = GLOBAL_STATUS_BUS.subscribe(() => {
        const t = GLOBAL_STATUS_BUS.currentStatus()?.activity?.recvTokens
        if (typeof t === "number" && t > 0) tokenSnaps.push(t)
      })

      const longThinking = "Reasoning step. ".repeat(50) // ~800 chars → ~228 tok
      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          { type: "message_start", message: { usage: {} } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: longThinking },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ]),
      )

      try {
        await sendMessageFull({
          auth,
          messages,
          model: "claude-opus-4-7",
          stream: true,
          networkClient,
        })
        // At least one token estimate published during thinking streaming.
        // Without the fix, tokenSnaps stays empty because thinking_delta
        // never touched outputChars or lastTokenPublishAt.
        expect(tokenSnaps.length).toBeGreaterThan(0)
        // The first publish should reflect the 800-char thinking
        // delta → ~228 tok estimate. Allow a wide range to absorb
        // throttle timing.
        const firstEstimate = tokenSnaps[0]
        expect(firstEstimate).toBeGreaterThanOrEqual(100)
      } finally {
        unsubscribe()
        GLOBAL_STATUS_BUS.reset()
      }
    })

    it("publishes recvTokens estimate during tool_use input_json_delta streaming", async () => {
      // Layer 4 parity: tool_use input streaming also feeds the token
      // estimate, so the activity infix shows tok/s even during
      // `Calling Write: streaming input` phase (not just text phase).
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "edit" }] }]
      const tokenSnaps: number[] = []

      GLOBAL_STATUS_BUS.reset()
      const unsubscribe = GLOBAL_STATUS_BUS.subscribe(() => {
        const t = GLOBAL_STATUS_BUS.currentStatus()?.activity?.recvTokens
        if (typeof t === "number" && t > 0) tokenSnaps.push(t)
      })

      const inputJson = JSON.stringify({
        file_path: "/tmp/example.txt",
        content: "x".repeat(2048),
      })
      const chunks: string[] = []
      for (let i = 0; i < inputJson.length; i += 256) chunks.push(inputJson.slice(i, i + 256))

      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          { type: "message_start", message: { usage: {} } },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "tu_1", name: "Write", input: {} },
          },
          ...chunks.map((partial) => ({
            type: "content_block_delta" as const,
            index: 0,
            delta: { type: "input_json_delta" as const, partial_json: partial },
          })),
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "tool_use", stop_sequence: null },
          },
        ]),
      )

      try {
        await sendMessageFull({
          auth,
          messages,
          model: "claude-opus-4-7",
          stream: true,
          networkClient,
        })

        // At least one token estimate published during tool_use streaming.
        expect(tokenSnaps.length).toBeGreaterThan(0)
        // The final estimate before content_block_stop should be in the
        // ballpark of inputJson.length / 3.5 ≈ 590 tok.
        const finalEstimate = tokenSnaps[tokenSnaps.length - 1]
        expect(finalEstimate).toBeGreaterThanOrEqual(100) // way more than zero
      } finally {
        unsubscribe()
        GLOBAL_STATUS_BUS.reset()
      }
    })

    it("forwards SendOptions.signal to networkClient.request", async () => {
      let captured: NetworkRequest | null = null
      const networkClient = fakeNetworkClient((req) => {
        captured = req
        return sseResponse([
          { type: "message_start", message: { id: "x", model: "claude", usage: {} } },
          { type: "message_stop" },
        ])
      })
      const ac = new AbortController()
      const auth: AuthResult = { type: "api-key", token: "tok", refresh: undefined }
      await sendMessageFull({
        auth,
        messages: [{ role: "user", content: "hi" }],
        networkClient,
        signal: ac.signal,
      })
      expect(captured).not.toBeNull()
      // The captured network request must carry the SAME signal instance
      // we passed in — cancellation has to walk all the way through to
      // the fetch/http2 transport for Esc/Ctrl+C abort to actually tear
      // down the in-flight HTTP/2 stream.
      expect((captured as unknown as NetworkRequest).signal).toBe(ac.signal)
    })

    // -----------------------------------------------------------------
    // Regression: the live-area `quota-status` slot's deadlock fix.
    //
    // Before this plumbing landed, `checkQuota` ignored its caller's
    // abort signal entirely — which meant the scheduler's
    // `AbortController` could fire its `abort` event, but the in-flight
    // network request would keep waiting on a TCP socket that died
    // during macOS sleep/wake (or any other transport stall). The
    // slot's `inFlight` flag stayed `true` forever, deadlocking BOTH
    // the heartbeat AND the `quota.headersReceived` bus path.
    //
    // The two assertions below pin the contract:
    //  - `checkQuota(auth, networkClient, signal)` must walk the
    //    `signal` argument all the way down to `networkClient.request`
    //    (so the transport can tear down the dead socket).
    //  - When that signal is already aborted before the request lands,
    //    the transport throws `AbortError`, `checkQuota` catches it and
    //    returns `{ok: false}` rather than hanging.
    // -----------------------------------------------------------------
    describe("checkQuota — signal propagation (deadlock regression)", () => {
      it("forwards the caller's AbortSignal to networkClient.request", async () => {
        // Without rate-limit headers in the response, the broadcast
        // helper is a no-op — keeps the cache module untouched.
        clearLastRateLimits()
        let captured: NetworkRequest | null = null
        const networkClient = fakeNetworkClient((req) => {
          captured = req
          return new NetworkResponse({
            status: 200,
            headers: { "content-type": "application/json" },
            transport: { id: "fake" },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(`{"id":"x"}`))
                controller.close()
              },
            }),
          })
        })
        const ac = new AbortController()
        const auth: AuthResult = { type: "api-key", token: "tok", refresh: undefined }
        const result = await checkQuota(auth, networkClient, ac.signal)
        expect(result.ok).toBe(true)
        expect(captured).not.toBeNull()
        // SAME instance — abort propagation only works if the transport
        // listens on the exact AbortSignal the scheduler owns.
        expect((captured as unknown as NetworkRequest).signal).toBe(ac.signal)
      })

      it("returns {ok: false} (not a hang) when the signal is already aborted", async () => {
        clearLastRateLimits()
        // Real fetch-transport-style behavior: throw AbortError when the
        // signal is aborted before the response body arrives. The user's
        // bug was that this throw never propagated because the signal
        // wasn't plumbed in — the request stayed pending indefinitely.
        const networkClient = fakeNetworkClient((req) => {
          if (req.signal?.aborted) {
            const err = new Error("AbortError") as Error & { name: string }
            err.name = "AbortError"
            throw err
          }
          // Defensive default — this branch shouldn't run if the signal
          // is wired correctly.
          return sseResponse([])
        })
        const ac = new AbortController()
        ac.abort()
        const auth: AuthResult = { type: "api-key", token: "tok", refresh: undefined }
        const result = await checkQuota(auth, networkClient, ac.signal)
        expect(result).toEqual({ ok: false })
      })

      it("works without a signal (back-compat: existing callers don't break)", async () => {
        clearLastRateLimits()
        let captured: NetworkRequest | null = null
        const networkClient = fakeNetworkClient((req) => {
          captured = req
          return new NetworkResponse({
            status: 200,
            headers: { "content-type": "application/json" },
            transport: { id: "fake" },
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(`{"id":"x"}`))
                controller.close()
              },
            }),
          })
        })
        const auth: AuthResult = { type: "api-key", token: "tok", refresh: undefined }
        const result = await checkQuota(auth, networkClient)
        expect(result.ok).toBe(true)
        // No signal passed → undefined forwarded to the transport, which
        // is a no-op (every transport accepts `signal?: AbortSignal`).
        expect((captured as unknown as NetworkRequest).signal).toBeUndefined()
      })
    })

    // -----------------------------------------------------------------
    // Regression: multi-process keychain-first 401 recovery (May 2026).
    //
    // Cause: with N agents sharing one keychain entry, server-side
    // refresh-token rotation makes each successful refresh invalidate
    // the access tokens cached by the OTHER N-1 processes. They each
    // 401 next, refresh, invalidate the previous one, and the cycle
    // never settles. Net-dbg trace from session c0ab6ba6 showed 24/105
    // requests in a 5-min window returning 401, with 22 refreshes
    // (one of which outright failed `invalid_grant`).
    //
    // Fix: on 401, re-read the keychain BEFORE calling auth.refresh().
    // If another process already wrote a fresher access token, use
    // that directly — no oauth round-trip, no rotation. The refresh()
    // closure remains the fallback when WE are the freshest cache
    // holder.
    //
    // We exercise the path indirectly: an auth.refresh that throws
    // (server-side rejection) PROVES we hit the refresh fallback.
    // A successful retry without auth.refresh being called PROVES the
    // keychain-first path won.
    // -----------------------------------------------------------------
    describe("401 retry — keychain-first multi-process race mitigation", () => {
      it("calls auth.refresh as the fallback when 401 persists (no keychain rotation)", async () => {
        // No real keychain entry on the test path → readKeychain returns
        // null → keychain-first branch is a no-op → refresh fallback runs.
        let refreshCalls = 0
        let messageReqs = 0
        const networkClient = fakeNetworkClient((req) => {
          messageReqs++
          // First message call → 401 (stale token).
          // Second message call (after refresh) → 200.
          if (messageReqs === 1) {
            return new NetworkResponse({
              status: 401,
              headers: { "content-type": "application/json" },
              transport: { id: "fake" },
              body: new ReadableStream<Uint8Array>({
                start(c) {
                  c.enqueue(
                    new TextEncoder().encode(
                      `{"type":"error","error":{"type":"authentication_error","message":"Invalid"}}`,
                    ),
                  )
                  c.close()
                },
              }),
            })
          }
          // Sanity: confirm the retry uses the fresh refreshed token, not stale.
          const authHeader = req.headers?.authorization ?? ""
          expect(authHeader).toBe("Bearer fresh-from-refresh")
          return sseResponse([
            { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null } },
          ])
        })

        const auth: AuthResult = {
          type: "oauth",
          token: "stale-token",
          refresh: async () => {
            refreshCalls++
            return { type: "oauth", token: "fresh-from-refresh" }
          },
        }

        await sendMessageFull({
          auth,
          messages: [{ role: "user", content: "hi" }],
          networkClient,
        })

        // The 401 fired the refresh fallback exactly once.
        expect(refreshCalls).toBe(1)
        // auth.token was mutated in place so future calls reuse it.
        expect(auth.token).toBe("fresh-from-refresh")
      })

      it("checkQuota's 401 path also uses keychain-first then refresh fallback", async () => {
        let refreshCalls = 0
        let reqs = 0
        const networkClient = fakeNetworkClient((req) => {
          reqs++
          if (reqs === 1) {
            return new NetworkResponse({
              status: 401,
              headers: { "content-type": "application/json" },
              transport: { id: "fake" },
              body: new ReadableStream<Uint8Array>({
                start(c) {
                  c.close()
                },
              }),
            })
          }
          // Second call must use the fresh token from refresh fallback.
          expect(req.headers?.authorization).toBe("Bearer cq-fresh")
          return new NetworkResponse({
            status: 200,
            headers: {
              "content-type": "application/json",
              "anthropic-ratelimit-unified-status": "allowed",
            },
            transport: { id: "fake" },
            body: new ReadableStream<Uint8Array>({
              start(c) {
                c.enqueue(new TextEncoder().encode(`{"id":"x"}`))
                c.close()
              },
            }),
          })
        })
        const auth: AuthResult = {
          type: "oauth",
          token: "cq-stale",
          refresh: async () => {
            refreshCalls++
            return { type: "oauth", token: "cq-fresh" }
          },
        }
        const result = await checkQuota(auth, networkClient)
        expect(result.ok).toBe(true)
        expect(refreshCalls).toBe(1)
        expect(auth.token).toBe("cq-fresh")
      })
    })
  })

  describe("e2e", () => {
    const skip = !process.env.E2E

    it.skipIf(skip)(
      "sends a haiku request and gets a response",
      async () => {
        const auth = await getAuth()
        const messages: Message[] = [
          { role: "user", content: [{ type: "text", text: "Reply with exactly: PONG" }] },
        ]

        const response = await sendMessageSync({
          auth,
          messages,
          model: "claude-haiku-4-5-20251001",
          maxTokens: 32,
          stream: true,
        })

        expect(response.length).toBeGreaterThan(0)
        expect(response.toUpperCase()).toContain("PONG")
      },
      30_000,
    )

    it.skipIf(skip)(
      "sends a non-streaming request",
      async () => {
        const auth = await getAuth()
        const messages: Message[] = [
          { role: "user", content: [{ type: "text", text: "Reply with exactly: HELLO" }] },
        ]

        const response = await sendMessageSync({
          auth,
          messages,
          model: "claude-haiku-4-5-20251001",
          maxTokens: 32,
          stream: false,
        })

        expect(response.length).toBeGreaterThan(0)
        expect(response.toUpperCase()).toContain("HELLO")
      },
      30_000,
    )
  })

  // -------------------------------------------------------------------------
  // SSE error event handling (regression: Anthropic returns mid-stream
  // errors over HTTP 200 as `event: error` SSE frames. Before
  // `client.ts:case "error":` existed, the event fell through the switch
  // silently — sendMessage returned { blocks: [], text: "" } and the
  // agent loop treated it as a natural empty turn: no scrollback, no
  // warning, no retry. See docs/changes or the .net-dbg captures of
  // session d5e415fb-… for the wire shape.)
  //
  // These tests exercise `sendMessageOnce` (the single-attempt internal)
  // directly so we observe the bare throw + diag.error contract without
  // the retry coordinator firing. Retry behavior has its own block below.
  // -------------------------------------------------------------------------
  describe("SSE error event handling", () => {
    /**
     * Subscribe to the singleton diagnostic bus for the duration of a
     * single test. Returns the captured events and an explicit
     * `dispose()` for the test's try/finally.
     */
    function captureDiagEvents(): {
      events: LogEvent[]
      dispose: () => void
    } {
      const events: LogEvent[] = []
      const dispose = getDiagnosticBus().on("*", (e) => events.push(e))
      return { events, dispose }
    }

    /** Drain a generator to completion; collect yields, return final. */
    async function drain(
      gen: AsyncGenerator<string, unknown, undefined>,
    ): Promise<{ yields: string[]; final: unknown }> {
      const yields: string[] = []
      let result: IteratorResult<string, unknown>
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic drain
      while (!(result = await gen.next()).done) {
        yields.push(result.value)
      }
      return { yields, final: result.value }
    }

    it("throws on `event: error` with overloaded_error and surfaces via diag.error", async () => {
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      // Single SSE frame: the same shape Anthropic emits for transient
      // capacity issues (200 OK + `event: error` body). Our parseSSE
      // ignores the `event:` line and only inspects `data:`, so passing
      // just the JSON payload through sseResponse(...) reproduces the
      // exact wire condition the agent saw on 2026-05-20T14:56:51.
      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
            request_id: "req_test_overload_001",
          },
        ]),
      )

      const cap = captureDiagEvents()
      let caught: unknown = null
      try {
        await drain(
          sendMessageOnce({
            auth,
            messages,
            model: "claude-opus-4-7",
            stream: true,
            networkClient,
          }),
        )
      } catch (err) {
        caught = err
      } finally {
        cap.dispose()
      }

      // Throw shape: identifiable message AND tagged for the agent's
      // bare-fallback-line gate (`isErrorDiagEmitted`).
      expect(caught).toBeInstanceOf(Error)
      const err = caught as Error & { streamErrorType?: string }
      expect(err.message).toContain("Anthropic stream error")
      expect(err.message).toContain("overloaded_error")
      expect(err.message).toContain("Overloaded")
      expect(isErrorDiagEmitted(err)).toBe(true)
      // Stage B tag: structured marker for the retry classifier
      expect(err.streamErrorType).toBe("overloaded_error")

      // Diag emission: exactly one Error-severity event with the
      // structured payload sinks subscribe to (file log, scrollback,
      // TUI footer all key on this).
      const diagErrors = cap.events.filter(
        (e) => e.severity === Severity.Error && e.source === "api.stream-error",
      )
      expect(diagErrors).toHaveLength(1)
      const e = diagErrors[0]
      expect(e.message).toContain("overloaded_error: Overloaded")
      expect(e.structuredData).toBeDefined()
      expect(e.structuredData!["error-type"]).toBe("overloaded_error")
      expect(e.structuredData!["request-id"]).toBe("req_test_overload_001")
    })

    it("also surfaces other error types (api_error, invalid_request_error, …)", async () => {
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      const networkClient = fakeNetworkClient(() =>
        sseResponse([
          {
            type: "error",
            error: { type: "api_error", message: "Internal server error" },
            request_id: "req_test_api_002",
          },
        ]),
      )

      const cap = captureDiagEvents()
      let caught: unknown = null
      try {
        await drain(
          sendMessageOnce({
            auth,
            messages,
            model: "claude-opus-4-7",
            stream: true,
            networkClient,
          }),
        )
      } catch (err) {
        caught = err
      } finally {
        cap.dispose()
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toContain("api_error")
      const diagErrors = cap.events.filter(
        (e) => e.severity === Severity.Error && e.source === "api.stream-error",
      )
      expect(diagErrors).toHaveLength(1)
      expect(diagErrors[0].structuredData!["error-type"]).toBe("api_error")
    })

    it("missing error fields fall back to `unknown_error` / `stream error`", async () => {
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      // Defensive: a malformed/partial SSE error frame missing the
      // nested error object. We still surface, still throw, still tag.
      const networkClient = fakeNetworkClient(() => sseResponse([{ type: "error" }]))

      const cap = captureDiagEvents()
      let caught: unknown = null
      try {
        await drain(
          sendMessageOnce({
            auth,
            messages,
            model: "claude-opus-4-7",
            stream: true,
            networkClient,
          }),
        )
      } catch (err) {
        caught = err
      } finally {
        cap.dispose()
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toContain("unknown_error")
      expect((caught as Error).message).toContain("stream error")
      expect(isErrorDiagEmitted(caught as Error)).toBe(true)
      // request-id key is omitted when the server didn't send one
      const e = cap.events.find(
        (x) => x.severity === Severity.Error && x.source === "api.stream-error",
      )!
      expect(e.structuredData).toBeDefined()
      expect(e.structuredData!["error-type"]).toBe("unknown_error")
      expect(e.structuredData!["request-id"]).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // Stage B: sendMessage retry coordinator (around sendMessageOnce)
  // -------------------------------------------------------------------------
  describe("sendMessage retry coordinator", () => {
    /** Subscribe to the singleton bus for one test. */
    function captureDiagEvents(): {
      events: LogEvent[]
      dispose: () => void
    } {
      const events: LogEvent[] = []
      const dispose = getDiagnosticBus().on("*", (e) => events.push(e))
      return { events, dispose }
    }

    async function drain(
      gen: AsyncGenerator<string, unknown, undefined>,
    ): Promise<{ yields: string[]; final: unknown }> {
      const yields: string[] = []
      let result: IteratorResult<string, unknown>
      // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic drain
      while (!(result = await gen.next()).done) {
        yields.push(result.value)
      }
      return { yields, final: result.value }
    }

    /**
     * Build a networkClient whose `request` returns the n-th value from
     * `responses` (in order, looping the LAST entry if drained). Records
     * the call count so tests can assert "retried K times then succeeded".
     */
    function scriptedNetworkClient(responses: NetworkResponse[]): {
      client: NetworkClient
      calls: number
    } {
      const state = { calls: 0 }
      const client = fakeNetworkClient(() => {
        const i = Math.min(state.calls, responses.length - 1)
        state.calls += 1
        return responses[i]
      })
      // The returned object's `calls` field is a live count via closure.
      // Use a getter so callers see the up-to-date value.
      return {
        client,
        get calls() {
          return state.calls
        },
      } as { client: NetworkClient; calls: number }
    }

    it("retries overloaded_error then succeeds on the 3rd attempt (no error surfaces to caller)", async () => {
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      // Two overload responses, then a successful stream that yields "OK".
      const scripted = scriptedNetworkClient([
        sseResponse([
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
            request_id: "req_retry_1",
          },
        ]),
        sseResponse([
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
            request_id: "req_retry_2",
          },
        ]),
        sseResponse([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "OK" },
          },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
          },
        ]),
      ])

      const cap = captureDiagEvents()
      let drained: { yields: string[]; final: unknown }
      try {
        drained = await drain(
          sendMessage({
            auth,
            messages,
            model: "claude-opus-4-7",
            stream: true,
            networkClient: scripted.client,
          }),
        )
      } finally {
        cap.dispose()
      }

      // Three POST attempts, final yields the success text
      expect(scripted.calls).toBe(3)
      expect(drained.yields.join("")).toContain("OK")
      // The first two attempts emit retry diagnostics (warn-severity)
      const retryWarns = cap.events.filter(
        (e) => e.severity === Severity.Warning && e.source === "api.retry",
      )
      expect(retryWarns.length).toBe(2)
      for (const w of retryWarns) {
        expect(w.structuredData!["error-type"]).toBe("overloaded_error")
        expect(w.structuredData!["max-attempts"]).toBe(RETRY_MAX_ATTEMPTS)
      }
      // And the two failed attempts each fire diag.error("api.stream-error")
      const streamErrors = cap.events.filter(
        (e) => e.severity === Severity.Error && e.source === "api.stream-error",
      )
      expect(streamErrors.length).toBe(2)
    }, 20_000) // generous: jittered sleeps can add up to ~4s for 2 retries

    it("does NOT retry once content has been yielded mid-stream", async () => {
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      // First response: yields some text, THEN errors. Retrying would
      // duplicate the partial output, so the wrapper must NOT retry.
      const scripted = scriptedNetworkClient([
        sseResponse([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "partial..." },
          },
          {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          },
        ]),
        // Second response would succeed if reached — we assert it isn't.
        sseResponse([
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "should-not-see" },
          },
        ]),
      ])

      let caught: unknown = null
      const yields: string[] = []
      const gen = sendMessage({
        auth,
        messages,
        model: "claude-opus-4-7",
        stream: true,
        networkClient: scripted.client,
      })
      try {
        let r: IteratorResult<string, unknown>
        // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic drain
        while (!(r = await gen.next()).done) yields.push(r.value)
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toContain("overloaded_error")
      expect(yields.join("")).toBe("partial...")
      // Only one POST was made — retry was blocked by hasYielded
      expect(scripted.calls).toBe(1)
    }, 15_000)

    it("non-retryable error types fail-fast on first attempt (e.g. invalid_request_error)", async () => {
      const auth: AuthResult = { type: "oauth", token: "test-token" }
      const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
      const scripted = scriptedNetworkClient([
        sseResponse([
          {
            type: "error",
            error: {
              type: "invalid_request_error",
              message: "messages.0.content[0].text is required",
            },
          },
        ]),
      ])

      let caught: unknown = null
      try {
        await drain(
          sendMessage({
            auth,
            messages,
            model: "claude-opus-4-7",
            stream: true,
            networkClient: scripted.client,
          }),
        )
      } catch (err) {
        caught = err
      }

      expect(caught).toBeInstanceOf(Error)
      expect((caught as Error).message).toContain("invalid_request_error")
      // Permanent error: no retry, single POST
      expect(scripted.calls).toBe(1)
    }, 5_000)
  })
})

// Used by Stage B retry tests above; mirrors the constant in client.ts.
// Updating one MUST update the other — there's a deliberate test gate
// on the structured-data payload to catch drift.
const RETRY_MAX_ATTEMPTS = 4
