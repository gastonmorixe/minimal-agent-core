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
} from "../../src/llm/index.ts"
import * as modelRegistry from "../../src/llm/model-registry.ts"

import { anthropicAdapter, anthropicProviderPlugin, bootstrapAnthropic } from "./adapter.ts"
import { ANTHROPIC_BETA_FLAGS, buildBetaFlags, classifyRequest } from "./beta-flags.ts"
import { applyBootstrapOverrides } from "./bootstrap.ts"
import { buildAnthropicHeaders } from "./headers.ts"
import { registerAnthropicModels } from "./models.ts"
import {
  anthropicOAuthLogin,
  buildAnthropicOAuthCredential,
  CLAUDE_AI_AUTHORIZE_URL,
  LOGIN_SCOPES,
  MANUAL_REDIRECT_URL,
} from "./oauth-login.ts"
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

  it("Fable 5 registers with a flat $10/$50 rate, no fast tier, 1M window", () => {
    setup()
    const entry = resolveModel("claude-fable-5")
    // [1m] alias resolves to the same canonical entry.
    expect(resolveModel("claude-fable-5[1m]").id).toBe("claude-fable-5")
    // Flat rate: no per-request pricing picker, table pinned exactly.
    expect(entry.pricingForRequest).toBeUndefined()
    expect(entry.pricing.inputUSD).toBe(10)
    expect(entry.pricing.outputUSD).toBe(50)
    expect(entry.pricing.cacheWriteUSD).toBe(12.5)
    expect(entry.pricing.cacheReadUSD).toBe(1)
    // Capability twin of opus-4-8 EXCEPT the fast tier.
    expect(entry.capabilities.speedFast).toBe(false)
    expect(entry.capabilities.contextWindow).toBe(1_000_000)
    expect(entry.capabilities.maxOutputTokens).toBe(128_000)
    expect(entry.capabilities.effort.levels).toContain("xhigh")
    expect(entry.capabilities.thinking.adaptive).toBe(true)
    expect(entry.capabilities.thinking.extended).toBe(false)
  })

  it("recommendSubagentModels maps roles to its OWN registered models by tier (no foreign SKUs)", () => {
    setup()
    const recs = anthropicAdapter.recommendSubagentModels?.() ?? []
    const byRole = new Map(recs.map((r) => [r.role, r.modelId]))
    // scout → a Haiku, balanced → a Sonnet, deep → an Opus (production tier)
    expect(byRole.get("scout")).toBe("claude-haiku-4-5-20251001")
    expect(byRole.get("balanced")).toBe("claude-sonnet-4-6")
    expect(byRole.get("deep")).toBe("claude-opus-4-8")
    // every recommended model is actually an Anthropic model in the registry
    for (const r of recs) expect(resolveModel(r.modelId).providerId).toBe("anthropic")
  })
})

describe("anthropicProviderPlugin auth strategy", () => {
  it("exposes the Anthropic plan OAuth login strategy, not an API-key login strategy", () => {
    expect(anthropicProviderPlugin.oauthLogin).toBe(anthropicOAuthLogin)
    expect(anthropicProviderPlugin.apiKeyAuth).toBeUndefined()
  })

  it("keeps Anthropic OAuth endpoints and scopes provider-local", () => {
    const cfg = anthropicOAuthLogin.config()

    expect(cfg.authorizeUrl).toBe(CLAUDE_AI_AUTHORIZE_URL)
    expect(cfg.tokenUrl).toBe("https://platform.claude.com/v1/oauth/token")
    expect(cfg.redirectUri).toBe(MANUAL_REDIRECT_URL)
    expect(cfg.scopes).toEqual(LOGIN_SCOPES)
    expect(cfg.authorizeParams).toEqual({ code: "true" })
    expect(cfg.loginHintParam).toBe("login_hint")
  })

  it("builds an opaque host-persistable credential from a token response", () => {
    const built = buildAnthropicOAuthCredential({
      access_token: "AT",
      refresh_token: "RT",
      expires_in: 3600,
      scope: "user:profile user:inference",
      account: { uuid: "acc-uuid", email_address: "u@example.com" },
      organization: { uuid: "org-uuid" },
    })

    expect(built.credential.serviceId).toBe("anthropic-plan-oauth")
    expect(built.credential.displayName).toBe("Anthropic Plan (OAuth)")
    expect(built.credential.secrets).toMatchObject({
      tokenType: "oauth",
      accessToken: "AT",
      refreshToken: "RT",
      scopes: ["user:profile", "user:inference"],
      accountUuid: "acc-uuid",
      organizationUuid: "org-uuid",
      emailAddress: "u@example.com",
    })
    expect(built.result.account?.uuid).toBe("acc-uuid")
    expect(built.result.organization?.uuid).toBe("org-uuid")
  })

  it("rejects malformed token responses in the provider codec", () => {
    expect(() => buildAnthropicOAuthCredential({ refresh_token: "RT", expires_in: 3600 })).toThrow(
      /missing access_token/,
    )
    expect(() =>
      buildAnthropicOAuthCredential({ access_token: "AT", refresh_token: "RT" }),
    ).toThrow(/missing expires_in/)
  })
})

describe("anthropicProviderPlugin.onStartupProbe + bootstrap overlay", () => {
  it("exposes onStartupProbe and self-gates the api-key path (no network, no throw)", () => {
    setup()
    expect(typeof anthropicProviderPlugin.onStartupProbe).toBe("function")
    // api-key auth short-circuits fetchBootstrap before any network I/O, so
    // this is safe to invoke in a unit test (the oauth path would hit the
    // real /bootstrap endpoint).
    expect(() =>
      anthropicProviderPlugin.onStartupProbe?.({
        auth: { kind: "api-key", key: "sk-test" },
        modelId: "claude-opus-4-8",
      }),
    ).not.toThrow()
  })

  it("applyBootstrapOverrides overlays server-shipped model costs onto the registry", () => {
    setup()
    const before = resolveModel("claude-opus-4-8").pricing.inputUSD
    expect(before).not.toBe(99)
    applyBootstrapOverrides(
      {
        client_data: null,
        additional_model_options: null,
        additional_model_costs: { "claude-opus-4-8": { inputTokens: 99 } },
        oauth_account: null,
      },
      modelRegistry,
    )
    expect(resolveModel("claude-opus-4-8").pricing.inputUSD).toBe(99)
    // A null bootstrap (the self-gated / failed-probe path) is a no-op.
    applyBootstrapOverrides(null, modelRegistry)
    expect(resolveModel("claude-opus-4-8").pricing.inputUSD).toBe(99)
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
  // NB: deliberately deviates from the live CLI capture for opus-4-8 — we OMIT
  // interleaved-thinking for this model (TODOS.md T-7c3f02; root cause in
  // private/tool-bugs-and-improvements/08-ROOT-CAUSE-corrected.md). The live CLI
  // sends it; we don't, because opus-4-8 hallucinates same-turn tool results
  // under it. Every other flag still matches the capture, in order.
  it("matches the live capture for an Opus 4.8 conversation (minus interleaved-thinking; T-7c3f02)", () => {
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
    // interleaved-thinking intentionally absent for opus-4-8 (T-7c3f02).
    expect(flags).not.toContain(ANTHROPIC_BETA_FLAGS.INTERLEAVED_THINKING)
    // redact-thinking intentionally absent for conversations since the B-0
    // flip (decision B3a): visible thinking is a product feature here. The
    // live CLI capture DOES send it; we deviate deliberately, matching the
    // legacy builder. Probe kinds (quota/title) still carry it.
    expect(flags).not.toContain(ANTHROPIC_BETA_FLAGS.REDACT_THINKING)
    expect(flags).toEqual([
      ANTHROPIC_BETA_FLAGS.CLAUDE_CODE,
      ANTHROPIC_BETA_FLAGS.OAUTH,
      ANTHROPIC_BETA_FLAGS.CONTEXT_1M,
      ANTHROPIC_BETA_FLAGS.CONTEXT_MANAGEMENT,
      ANTHROPIC_BETA_FLAGS.ADVANCED_TOOL_USE,
      ANTHROPIC_BETA_FLAGS.EFFORT,
      ANTHROPIC_BETA_FLAGS.PROMPT_CACHING_SCOPE,
      ANTHROPIC_BETA_FLAGS.EXTENDED_CACHE_TTL,
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
    // 9, not 11: interleaved-thinking is omitted for opus-4-8 (T-7c3f02)
    // and redact-thinking is omitted for conversations (B3a, B-0 flip).
    expect(headers["anthropic-beta"]).not.toContain("interleaved-thinking-2025-05-14")
    expect(headers["anthropic-beta"]).not.toContain("redact-thinking-2026-02-12")
    expect(betaFlags.length).toBe(9)
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

    const out: import("../../src/llm/canonical-events.ts").CanonicalEvent[] = []
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
    const out: import("../../src/llm/canonical-events.ts").CanonicalEvent[] = []
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
    const out: import("../../src/llm/canonical-events.ts").CanonicalEvent[] = []
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

describe("validateAnthropicRequest — modality gating", () => {
  const imageReq = (id: string): CanonicalRequest => ({
    modelId: id,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AA" } },
        ],
      },
    ],
  })
  const audioReq = (id: string): CanonicalRequest => ({
    modelId: id,
    messages: [
      {
        role: "user",
        content: [{ type: "audio", source: { kind: "base64", format: "wav", data: "AA" } }],
      },
    ],
  })
  const fileReq = (id: string): CanonicalRequest => ({
    modelId: id,
    messages: [
      {
        role: "user",
        content: [
          { type: "file", source: { kind: "base64", mediaType: "application/pdf", data: "AA" } },
        ],
      },
    ],
  })

  it("Opus 4.8 accepts image + PDF, rejects audio", () => {
    setup()
    const p = resolveProvider("anthropic")
    expect(p.validate(imageReq("claude-opus-4-8"), resolveModel("claude-opus-4-8")).ok).toBe(true)
    expect(p.validate(fileReq("claude-opus-4-8"), resolveModel("claude-opus-4-8")).ok).toBe(true)
    const audio = p.validate(audioReq("claude-opus-4-8"), resolveModel("claude-opus-4-8"))
    expect(audio.ok).toBe(false)
    expect(audio.errors.some((e) => e.capability === "modalities")).toBe(true)
  })

  it("Haiku 4.5 accepts image, rejects PDF (no pdf modality)", () => {
    setup()
    const p = resolveProvider("anthropic")
    expect(p.validate(imageReq("claude-haiku-4-5"), resolveModel("claude-haiku-4-5")).ok).toBe(true)
    const file = p.validate(fileReq("claude-haiku-4-5"), resolveModel("claude-haiku-4-5"))
    expect(file.ok).toBe(false)
    expect(file.errors.some((e) => e.capability === "modalities")).toBe(true)
  })
})

describe("buildAnthropicRequestBody — image encoding", () => {
  it("base64 image → source {type:base64, media_type, data}", () => {
    setup()
    const req: CanonicalRequest = {
      modelId: "claude-opus-4-8",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AAAA" } },
          ],
        },
      ],
    }
    const j = JSON.stringify(buildAnthropicRequestBody(req, resolveModel("claude-opus-4-8")))
    expect(j).toContain('"type":"image"')
    expect(j).toContain('"type":"base64"')
    expect(j).toContain('"media_type":"image/png"')
    expect(j).toContain('"data":"AAAA"')
  })

  it("url image → source {type:url, url}", () => {
    setup()
    const req: CanonicalRequest = {
      modelId: "claude-opus-4-8",
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { kind: "url", url: "https://x/y.png" } }],
        },
      ],
    }
    const j = JSON.stringify(buildAnthropicRequestBody(req, resolveModel("claude-opus-4-8")))
    expect(j).toContain('"type":"url"')
    expect(j).toContain('"url":"https://x/y.png"')
  })
})
