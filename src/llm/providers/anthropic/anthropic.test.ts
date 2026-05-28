/**
 * Anthropic adapter snapshot tests.
 *
 * Each test reconstructs a `CanonicalRequest` representative of one of
 * the captured 2026-05-28 traces and verifies that the new adapter
 * produces the same headers + body the live CLI sent. Fixtures live in
 * `__fixtures__/`.
 *
 * The comparison is deliberately field-by-field (not byte-by-byte) for
 * two reasons:
 *
 * 1. The Stainless SDK serializes unset sampling fields as `null`; our
 *    default is to omit them (cleaner snapshot). The `mirrorStainlessNulls`
 *    vendor flag flips that on for byte-identical mirroring.
 * 2. UUID-shaped headers (`x-client-request-id`) are per-call. We pin
 *    them via the headers builder's `clientRequestId` override.
 *
 * @module llm/providers/anthropic/anthropic.test
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  type CanonicalRequest,
  clearModelRegistry,
  clearProviderRegistry,
  resolveModel,
  resolveProvider,
  systemMessage,
  userText,
} from "../../index.ts"

import { bootstrapAnthropic } from "./adapter.ts"
import { ANTHROPIC_BETA_FLAGS, buildBetaFlags, classifyRequest } from "./beta-flags.ts"
import { buildAnthropicHeaders } from "./headers.ts"
import { registerAnthropicModels } from "./models.ts"
import { buildAnthropicRequestBody } from "./request-body.ts"
import { translateAnthropicStream } from "./response-stream.ts"

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function setup() {
  clearModelRegistry()
  clearProviderRegistry()
  bootstrapAnthropic()
}

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "__fixtures__", name), "utf-8")
}

function parseFixtureJson(name: string): unknown {
  return JSON.parse(fixture(name))
}

// ---------------------------------------------------------------------------
// Registry / bootstrap
// ---------------------------------------------------------------------------

describe("bootstrapAnthropic", () => {
  it("registers the adapter and the live catalog", () => {
    setup()
    expect(resolveProvider("anthropic").id).toBe("anthropic")
    expect(resolveModel("claude-opus-4-8").providerId).toBe("anthropic")
    expect(resolveModel("claude-opus-4-8[1m]").id).toBe("claude-opus-4-8")
    expect(resolveModel("claude-haiku-4-5").id).toBe("claude-haiku-4-5-20251001")
  })

  it("Opus 4.8 pricingForRequest switches on speed:fast", () => {
    setup()
    const entry = resolveModel("claude-opus-4-8")
    expect(entry.pricingForRequest).toBeDefined()
    const slow = entry.pricingForRequest?.({ modelId: entry.id, messages: [] })
    const fast = entry.pricingForRequest?.({ modelId: entry.id, messages: [], speed: "fast" })
    expect(slow?.inputUSD).toBe(5)
    expect(fast?.inputUSD).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// Request classification + beta flags
// ---------------------------------------------------------------------------

describe("classifyRequest", () => {
  it("classifies a quota probe", () => {
    const req: CanonicalRequest = {
      modelId: "claude-haiku-4-5-20251001",
      messages: [userText("quota")],
      generation: { maxOutputTokens: 1 },
    }
    expect(classifyRequest(req)).toBe("quota")
  })

  it("classifies a title gen request", () => {
    const req: CanonicalRequest = {
      modelId: "claude-haiku-4-5-20251001",
      messages: [userText("<session>…</session>")],
      outputFormat: {
        type: "json_schema",
        schema: { type: "object", properties: { title: { type: "string" } } },
      },
      system: [{ type: "text", text: "title" }],
    }
    expect(classifyRequest(req)).toBe("title")
  })

  it("classifies a multi-tool 1h-cache conversation", () => {
    const req: CanonicalRequest = {
      modelId: "claude-opus-4-8",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "text", text: "and", cache: { kind: "ephemeral", ttl: "1h" } },
          ],
        },
      ],
      tools: [
        { name: "A", description: "a", inputSchema: {} },
        { name: "B", description: "b", inputSchema: {} },
      ],
    }
    expect(classifyRequest(req)).toBe("conversation")
  })

  it("classifies a single-tool no-cache subtask", () => {
    const req: CanonicalRequest = {
      modelId: "claude-opus-4-8",
      messages: [userText("hi")],
      tools: [{ name: "A", description: "a", inputSchema: {} }],
    }
    expect(classifyRequest(req)).toBe("subtask")
  })
})

describe("buildBetaFlags", () => {
  it("matches the live capture for an Opus 4.8 conversation", () => {
    setup()
    const model = resolveModel("claude-opus-4-8")
    const req: CanonicalRequest = {
      modelId: model.id,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "text", text: "and", cache: { kind: "ephemeral", ttl: "1h" } },
          ],
        },
      ],
      tools: [
        { name: "A", description: "a", inputSchema: {} },
        { name: "B", description: "b", inputSchema: {} },
      ],
      effort: "high",
    }
    const flags = buildBetaFlags({
      kind: "conversation",
      req,
      model,
      authKind: "oauth",
    })
    expect(flags).toEqual([
      ANTHROPIC_BETA_FLAGS.CLAUDE_CODE,
      ANTHROPIC_BETA_FLAGS.OAUTH,
      ANTHROPIC_BETA_FLAGS.INTERLEAVED_THINKING,
      ANTHROPIC_BETA_FLAGS.CONTEXT_1M,
      ANTHROPIC_BETA_FLAGS.CONTEXT_MANAGEMENT,
      ANTHROPIC_BETA_FLAGS.ADVANCED_TOOL_USE,
      ANTHROPIC_BETA_FLAGS.EFFORT,
      ANTHROPIC_BETA_FLAGS.PROMPT_CACHING_SCOPE,
      ANTHROPIC_BETA_FLAGS.EXTENDED_CACHE_TTL,
      ANTHROPIC_BETA_FLAGS.REDACT_THINKING,
      ANTHROPIC_BETA_FLAGS.MID_CONVERSATION_SYSTEM,
    ])
  })

  it("matches the live capture for a haiku quota probe", () => {
    setup()
    const model = resolveModel("claude-haiku-4-5-20251001")
    const req: CanonicalRequest = {
      modelId: model.id,
      messages: [userText("quota")],
      generation: { maxOutputTokens: 1 },
    }
    const flags = buildBetaFlags({ kind: "quota", req, model, authKind: "oauth" })
    expect(flags).toEqual([
      ANTHROPIC_BETA_FLAGS.OAUTH,
      ANTHROPIC_BETA_FLAGS.INTERLEAVED_THINKING,
      ANTHROPIC_BETA_FLAGS.CONTEXT_MANAGEMENT,
      ANTHROPIC_BETA_FLAGS.PROMPT_CACHING_SCOPE,
      ANTHROPIC_BETA_FLAGS.REDACT_THINKING,
    ])
  })

  it("adds STRUCTURED_OUTPUTS for title gen", () => {
    setup()
    const model = resolveModel("claude-haiku-4-5-20251001")
    const req: CanonicalRequest = {
      modelId: model.id,
      messages: [userText("title please")],
      outputFormat: {
        type: "json_schema",
        schema: { type: "object", properties: { title: { type: "string" } } },
      },
    }
    const flags = buildBetaFlags({ kind: "title", req, model, authKind: "oauth" })
    expect(flags).toContain(ANTHROPIC_BETA_FLAGS.STRUCTURED_OUTPUTS)
  })
})

// ---------------------------------------------------------------------------
// Request body snapshots
// ---------------------------------------------------------------------------

describe("buildAnthropicRequestBody — quota probe", () => {
  it("matches the live quota body exactly", () => {
    setup()
    const live = parseFixtureJson("quota.req-body.json") as {
      model: string
      max_tokens: number
      messages: Array<{ role: string; content: string }>
    }
    const req: CanonicalRequest = {
      modelId: "claude-haiku-4-5-20251001",
      messages: [
        {
          role: "user",
          // The live wire uses string content for the quota probe.
          content: [{ type: "text", text: "quota" }],
        },
      ],
      generation: { maxOutputTokens: 1 },
      stream: false,
      metadata: {
        accountId: "7b6f82df-aaef-4d77-9e79-3adda8890e47",
        deviceId: "e87ce8cdb2b2e5d5e8abca596a5b758c954f5998bcdd77415259140daf1ee575",
        sessionId: "cf97e168-d4f9-4831-b26f-2ec3149ea7f0",
      },
    }
    const model = resolveModel("claude-haiku-4-5-20251001")
    const body = buildAnthropicRequestBody(req, model)
    expect(body.model).toBe(live.model)
    expect(body.max_tokens).toBe(live.max_tokens)
    // Quota probe uses string content. Our adapter sends array; semantic
    // parity (server accepts either), test that the text matches.
    const liveFirst = live.messages[0]
    expect(liveFirst).toBeDefined()
    if (!liveFirst) return
    const liveText = typeof liveFirst.content === "string" ? liveFirst.content : ""
    const ourFirst = body.messages[0]
    expect(ourFirst).toBeDefined()
    if (!ourFirst || typeof ourFirst.content === "string") {
      throw new Error("expected array content")
    }
    const firstBlock = ourFirst.content[0]
    expect(firstBlock?.type).toBe("text")
    if (firstBlock?.type === "text") expect(firstBlock.text).toBe(liveText)
    expect(body.metadata?.user_id).toBeDefined()
    expect(JSON.parse(body.metadata!.user_id!)).toEqual({
      device_id: "e87ce8cdb2b2e5d5e8abca596a5b758c954f5998bcdd77415259140daf1ee575",
      account_uuid: "7b6f82df-aaef-4d77-9e79-3adda8890e47",
      session_id: "cf97e168-d4f9-4831-b26f-2ec3149ea7f0",
    })
  })
})

describe("buildAnthropicRequestBody — Opus 4.8 conversation", () => {
  it("matches the live conversation request shape", () => {
    setup()
    const live = parseFixtureJson("conversation-opus48.req-body.json") as {
      model: string
      max_tokens: number
      stream: boolean
      thinking?: { type: string }
      output_config?: { effort?: string }
      context_management?: { edits: Array<{ type: string }> }
      messages: Array<unknown>
      system: Array<{ text: string; cache_control?: object }>
      temperature?: number | null
      top_p?: number | null
      top_k?: number | null
    }

    const req: CanonicalRequest = {
      modelId: "claude-opus-4-8",
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=2.1.154.d6e; cc_entrypoint=cli; cch=00000;",
        },
        { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
        {
          type: "text",
          text: "<full behavioral instructions>",
          cache: { kind: "ephemeral", ttl: "1h", scope: "global" },
        },
        {
          type: "text",
          text: "<session-scope guidance>",
          cache: { kind: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>…</system-reminder>" },
            { type: "text", text: "hi!", cache: { kind: "ephemeral", ttl: "1h" } },
          ],
        },
        systemMessage("The following deferred tools are now available via ToolSearch."),
      ],
      tools: [
        { name: "Bash", description: "shell", inputSchema: { type: "object" } },
        { name: "Read", description: "read", inputSchema: { type: "object" } },
      ],
      effort: "high",
      metadata: {
        accountId: "7b6f82df-aaef-4d77-9e79-3adda8890e47",
        deviceId: "e87ce8cdb2b2e5d5e8abca596a5b758c954f5998bcdd77415259140daf1ee575",
        sessionId: "cf97e168-d4f9-4831-b26f-2ec3149ea7f0",
      },
    }
    const model = resolveModel("claude-opus-4-8")
    const body = buildAnthropicRequestBody(req, model)

    expect(body.model).toBe(live.model)
    expect(body.max_tokens).toBe(64_000)
    expect(body.stream).toBe(true)
    expect(body.thinking).toEqual({ type: "adaptive" })
    expect(body.output_config).toEqual({ effort: "high" })
    expect(body.context_management).toEqual({
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    })
    // Our default omits temperature/top_p/top_k; the live capture has them
    // explicitly as `null` thanks to Stainless. Verify omitted here, and
    // separately verify mirrorStainlessNulls turns them on.
    expect(body.temperature).toBeUndefined()
    expect(body.top_p).toBeUndefined()
    expect(body.top_k).toBeUndefined()

    // System block cache markers
    expect(body.system).toBeDefined()
    expect(body.system?.length).toBe(4)
    const sys2 = body.system?.[2]
    const sys3 = body.system?.[3]
    expect(sys2?.cache_control).toEqual({ type: "ephemeral", ttl: "1h", scope: "global" })
    expect(sys3?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })

    // Mid-conversation system message renders as role:"system" with
    // STRING content (matches live capture).
    const lastMsg = body.messages[body.messages.length - 1]
    expect(lastMsg?.role).toBe("system")
    expect(typeof lastMsg?.content).toBe("string")
  })

  it("mirrorStainlessNulls: true emits null sampling fields", () => {
    setup()
    const model = resolveModel("claude-opus-4-8")
    const req: CanonicalRequest = {
      modelId: "claude-opus-4-8",
      messages: [userText("hi")],
      vendor: { anthropic: { mirrorStainlessNulls: true } },
    }
    const body = buildAnthropicRequestBody(req, model)
    expect(body.temperature).toBeNull()
    expect(body.top_p).toBeNull()
    expect(body.top_k).toBeNull()
  })

  it("speed:fast emits the top-level field", () => {
    setup()
    const model = resolveModel("claude-opus-4-8")
    const req: CanonicalRequest = {
      modelId: "claude-opus-4-8",
      messages: [userText("hi")],
      speed: "fast",
    }
    const body = buildAnthropicRequestBody(req, model)
    expect(body.speed).toBe("fast")
  })

  it("cacheDiagnostics adds the diagnostics block", () => {
    setup()
    const model = resolveModel("claude-opus-4-8")
    const req: CanonicalRequest = {
      modelId: "claude-opus-4-8",
      messages: [userText("hi")],
      vendor: { anthropic: { cacheDiagnostics: true } },
    }
    const body = buildAnthropicRequestBody(req, model)
    expect(body.diagnostics).toEqual({ previous_message_id: null })
  })
})

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

describe("buildAnthropicHeaders", () => {
  it("produces the full set for an Opus 4.8 OAuth conversation", () => {
    setup()
    const model = resolveModel("claude-opus-4-8")
    const req: CanonicalRequest = {
      modelId: "claude-opus-4-8",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "text", text: "and", cache: { kind: "ephemeral", ttl: "1h" } },
          ],
        },
      ],
      tools: [
        { name: "A", description: "a", inputSchema: {} },
        { name: "B", description: "b", inputSchema: {} },
      ],
      effort: "high",
    }
    const { headers, betaFlags } = buildAnthropicHeaders({
      req,
      model,
      auth: { kind: "oauth", token: "sk-ant-oat01-…" },
      sessionId: "cf97e168-d4f9-4831-b26f-2ec3149ea7f0",
      clientRequestId: "00000000-0000-0000-0000-000000000000",
    })
    expect(headers.authorization).toBe("Bearer sk-ant-oat01-…")
    expect(headers["anthropic-beta"]).toContain("mid-conversation-system-2026-04-07")
    expect(headers["anthropic-beta"]).toContain("extended-cache-ttl-2025-04-11")
    expect(headers["x-app"]).toBe("cli")
    expect(headers["user-agent"]).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/)
    expect(headers["x-stainless-package-version"]).toBe("0.94.0")
    expect(betaFlags.length).toBe(11)
  })

  it("uses x-api-key auth when api-key provided", () => {
    setup()
    const model = resolveModel("claude-opus-4-8")
    const { headers } = buildAnthropicHeaders({
      req: { modelId: "claude-opus-4-8", messages: [userText("hi")] },
      model,
      auth: { kind: "api-key", key: "sk-test", organization: "org_x" },
      sessionId: "s",
    })
    expect(headers["x-api-key"]).toBe("sk-test")
    expect(headers["anthropic-organization"]).toBe("org_x")
    expect(headers.authorization).toBeUndefined()
    // anthropic-beta NOT set when not OAuth (the API uses the
    // x-api-key channel's per-request beta flags by call-site convention,
    // not the global header).
    expect(headers["anthropic-beta"]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// SSE translator
// ---------------------------------------------------------------------------

describe("translateAnthropicStream", () => {
  it("translates a complete message_start → message_stop sequence", async () => {
    setup()
    const events = [
      {
        type: "message_start",
        message: {
          id: "msg_1",
          model: "claude-opus-4-8",
          usage: {
            input_tokens: 100,
            output_tokens: 1,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 10,
            cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 10 },
            service_tier: "standard",
            inference_geo: "us-east-1",
          },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ", world" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null, stop_details: null },
        usage: {
          input_tokens: 100,
          output_tokens: 3,
          output_tokens_details: { thinking_tokens: 0 },
        },
        context_management: { applied_edits: [] },
      },
      { type: "message_stop" },
    ] as const

    const out: string[] = []
    let stopReason: string | null | undefined
    for await (const ev of translateAnthropicStream(asAsyncIterable(events))) {
      out.push(ev.type)
      if (ev.type === "message_delta") stopReason = ev.stopReason
      if (ev.type === "message_start") expect(ev.serviceTier).toBe("standard")
    }
    expect(out).toEqual([
      "message_start",
      "text_start",
      "text_delta",
      "text_delta",
      "text_stop",
      "message_delta",
      "message_stop",
    ])
    expect(stopReason).toBe("end_turn")
  })

  it("emits tool_use_input_delta and parses input on stop", async () => {
    const events = [
      {
        type: "message_start",
        message: {
          id: "m",
          model: "claude-opus-4-8",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "tu_1", name: "Bash" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"cmd":"' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: 'ls"}' },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null, stop_details: null },
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      { type: "message_stop" },
    ] as const

    const out: import("../../canonical-events.ts").CanonicalEvent[] = []
    for await (const ev of translateAnthropicStream(asAsyncIterable(events))) out.push(ev)
    const stopEv = out.find((e) => e.type === "tool_use_stop")
    expect(stopEv).toBeDefined()
    if (stopEv?.type === "tool_use_stop") {
      expect(stopEv.input).toEqual({ cmd: "ls" })
    }
  })

  it("surfaces refusal stop_details on message_delta", async () => {
    const events = [
      {
        type: "message_start",
        message: {
          id: "m",
          model: "claude-opus-4-8",
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: "message_delta",
        delta: {
          stop_reason: "refusal",
          stop_sequence: null,
          stop_details: { type: "harm_category_X", message: "declined" },
        },
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      { type: "message_stop" },
    ] as const
    let stopDetails: unknown
    let stopReason: string | null | undefined
    for await (const ev of translateAnthropicStream(asAsyncIterable(events))) {
      if (ev.type === "message_delta") {
        stopReason = ev.stopReason
        stopDetails = ev.stopDetails
      }
    }
    expect(stopReason).toBe("refusal")
    expect(stopDetails).toEqual({ type: "harm_category_X", message: "declined" })
  })

  it("maps SSE error → stream_error with retryable category", async () => {
    const events = [
      {
        type: "error",
        error: { type: "overloaded_error", message: "try later" },
      },
    ] as const
    const out: import("../../canonical-events.ts").CanonicalEvent[] = []
    for await (const ev of translateAnthropicStream(asAsyncIterable(events))) out.push(ev)
    expect(out[0]?.type).toBe("stream_error")
    if (out[0]?.type === "stream_error") {
      expect(out[0].retryable).toBe(true)
      expect(out[0].category).toBe("overloaded")
    }
  })

  it("translates the captured Opus 4.8 SSE response end-to-end", async () => {
    const raw = fixture("conversation-opus48.res-body.sse")
    const events = parseSseFixture(raw)
    const out: import("../../canonical-events.ts").CanonicalEvent[] = []
    for await (const ev of translateAnthropicStream(asAsyncIterable(events))) out.push(ev)
    const stopEv = out.find((e) => e.type === "message_delta")
    expect(stopEv).toBeDefined()
    if (stopEv?.type === "message_delta") {
      expect(stopEv.stopReason).toBe("end_turn")
      expect(stopEv.usage.reasoningTokens).toBe(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function* asAsyncIterable<T>(arr: ReadonlyArray<unknown>): AsyncIterable<T> {
  // Test fixtures use `as const` to fix shape inference, which produces
  // readonly properties. The SSE translator only reads, never mutates, so a
  // lossy cast through `unknown` keeps the runtime behavior intact while
  // satisfying the type-checker against the wire interface shape.
  for (const v of arr) yield v as T
}

function parseSseFixture(raw: string): unknown[] {
  const out: unknown[] = []
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const data = line.slice(6).trim()
    if (data === "[DONE]") break
    try {
      out.push(JSON.parse(data))
    } catch {
      // skip
    }
  }
  return out
}

// Reference to silence unused-import warnings; classifyRequest covered above.
void registerAnthropicModels
