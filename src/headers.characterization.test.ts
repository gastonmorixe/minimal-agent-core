/**
 * Wave-0 characterization snapshots for the LEGACY Anthropic wire builders
 * (`src/headers.ts`). These tests pin CURRENT behavior, byte-for-byte,
 * across the model × auth × requestType × fast matrix, so the provider-
 * decoupling refactor (move headers.ts internals into plugins/llm-anthropic,
 * see docs/changes/ + the Phase-3 plan) can prove "no behavior change" at
 * every wave. They are NOT aspirational: where current behavior is known-
 * weird (api-key sends zero beta flags), the weirdness is pinned on purpose
 * with a comment, so any fix shows up as an explicit snapshot edit in
 * review, never as silent drift.
 *
 * Companion: plugins/llm-anthropic/beta-flags.characterization.test.ts
 * pins the canonical transport's flag assembly over the same matrix. Since
 * the B-0 transport flip the redact-thinking divergence is an AGREEMENT pin
 * (B3a: both builders omit it from conversations) and the legacy api-key
 * zero-beta pin was deliberately deleted (B2: the canonical default path
 * sends the full non-OAuth set; this legacy builder only serves the
 * MINIMAL_AGENT_LEGACY_TRANSPORT=1 escape hatch until B-5 deletes it).
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "./auth.ts"
import { BetaFlagId, buildBetaFlags, buildHeaders } from "./headers.ts"

const MATRIX_MODELS = [
  "claude-fable-5",
  "claude-fable-5[1m]",
  "claude-opus-4-8",
  "claude-opus-4-8[1m]",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
] as const

describe("characterization: legacy buildBetaFlags (conversation)", () => {
  // The full conversation flag set per model, pinned as ordered arrays.
  // ANY change to this table is a wire-behavior change for the default
  // transport and must be a deliberate, reviewed snapshot edit.
  const expected: Record<(typeof MATRIX_MODELS)[number], string[]> = {
    "claude-fable-5": [
      "claude-code-20250219",
      "oauth-2025-04-20",
      "context-1m-2025-08-07",
      "interleaved-thinking-2025-05-14",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "advanced-tool-use-2025-11-20",
      "effort-2025-11-24",
      "mid-conversation-system-2026-04-07",
      "extended-cache-ttl-2025-04-11",
    ],
    "claude-fable-5[1m]": [
      "claude-code-20250219",
      "oauth-2025-04-20",
      "context-1m-2025-08-07",
      "interleaved-thinking-2025-05-14",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "advanced-tool-use-2025-11-20",
      "effort-2025-11-24",
      "mid-conversation-system-2026-04-07",
      "extended-cache-ttl-2025-04-11",
    ],
    "claude-opus-4-8": [
      "claude-code-20250219",
      "oauth-2025-04-20",
      "context-1m-2025-08-07",
      // NB: interleaved-thinking deliberately OMITTED for opus-4-8
      // (tool-batch spiral pathology; see headers.ts gate).
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "advanced-tool-use-2025-11-20",
      "effort-2025-11-24",
      "mid-conversation-system-2026-04-07",
      "extended-cache-ttl-2025-04-11",
    ],
    "claude-opus-4-8[1m]": [
      "claude-code-20250219",
      "oauth-2025-04-20",
      "context-1m-2025-08-07",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "advanced-tool-use-2025-11-20",
      "effort-2025-11-24",
      "mid-conversation-system-2026-04-07",
      "extended-cache-ttl-2025-04-11",
    ],
    "claude-opus-4-7": [
      "claude-code-20250219",
      "oauth-2025-04-20",
      "context-1m-2025-08-07",
      "interleaved-thinking-2025-05-14",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "advanced-tool-use-2025-11-20",
      "effort-2025-11-24",
      "mid-conversation-system-2026-04-07",
      "extended-cache-ttl-2025-04-11",
    ],
    "claude-opus-4-6": [
      "claude-code-20250219",
      "oauth-2025-04-20",
      "context-1m-2025-08-07",
      "interleaved-thinking-2025-05-14",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "advanced-tool-use-2025-11-20",
      "effort-2025-11-24",
      "mid-conversation-system-2026-04-07",
      "extended-cache-ttl-2025-04-11",
    ],
    "claude-sonnet-4-6": [
      "claude-code-20250219",
      "oauth-2025-04-20",
      // 1M-native since 97c0191. Caveat: the headers.ts docstring still
      // documents sonnet-1m as 429-gated for non-overage accounts (open
      // question B1 in the Phase-2 review); pinned as currently built.
      "context-1m-2025-08-07",
      "interleaved-thinking-2025-05-14",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "advanced-tool-use-2025-11-20",
      "effort-2025-11-24",
      "mid-conversation-system-2026-04-07",
      "extended-cache-ttl-2025-04-11",
    ],
    "claude-sonnet-4-5-20250929": [
      "claude-code-20250219",
      "oauth-2025-04-20",
      // 200k model: no context-1m.
      "interleaved-thinking-2025-05-14",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "advanced-tool-use-2025-11-20",
      "effort-2025-11-24",
      "mid-conversation-system-2026-04-07",
      "extended-cache-ttl-2025-04-11",
    ],
    "claude-haiku-4-5-20251001": [
      "claude-code-20250219",
      "oauth-2025-04-20",
      "interleaved-thinking-2025-05-14",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "advanced-tool-use-2025-11-20",
      "effort-2025-11-24",
      "mid-conversation-system-2026-04-07",
      "extended-cache-ttl-2025-04-11",
    ],
  }

  for (const model of MATRIX_MODELS) {
    it(`pins the conversation flag set for ${model}`, () => {
      expect(buildBetaFlags("conversation", model)).toEqual(
        expected[model] as unknown as BetaFlagId[],
      )
    })
  }

  it("pins fast-mode opt-in: appended ONLY when opts.speedFast (caller-gated)", () => {
    // The builder itself trusts the caller — capability gating lives in
    // client.ts (sendMessageOnce). Pinned so a refactor that moves the
    // gate INTO the builder shows up here.
    const withFast = buildBetaFlags("conversation", "claude-opus-4-8", { speedFast: true })
    expect(withFast).toContain(BetaFlagId.FAST_MODE_20260201)
    expect(withFast[withFast.length - 1]).toBe(BetaFlagId.FAST_MODE_20260201)
    const without = buildBetaFlags("conversation", "claude-opus-4-8")
    expect(without).not.toContain(BetaFlagId.FAST_MODE_20260201)
  })

  it("pins redact-thinking: EXCLUDED from conversations, INCLUDED in quota/title", () => {
    // Internal inconsistency, documented in the Phase-2 review (B3):
    // conversations keep thinking visible; the probe sets still carry the
    // redact flag. The canonical transport always adds it. Pinned as-is.
    expect(buildBetaFlags("conversation", "claude-opus-4-7")).not.toContain(
      BetaFlagId.REDACT_THINKING_20260212,
    )
    expect(buildBetaFlags("quota")).toContain(BetaFlagId.REDACT_THINKING_20260212)
    expect(buildBetaFlags("title")).toContain(BetaFlagId.REDACT_THINKING_20260212)
  })

  it("pins quota/title sets (model-independent)", () => {
    expect(buildBetaFlags("quota")).toEqual([
      BetaFlagId.OAUTH_20250420,
      BetaFlagId.INTERLEAVED_THINKING_20250514,
      BetaFlagId.REDACT_THINKING_20260212,
      BetaFlagId.CONTEXT_MANAGEMENT_20250627,
      BetaFlagId.PROMPT_CACHING_SCOPE_20260105,
    ])
    expect(buildBetaFlags("title")).toEqual([
      BetaFlagId.OAUTH_20250420,
      BetaFlagId.INTERLEAVED_THINKING_20250514,
      BetaFlagId.REDACT_THINKING_20260212,
      BetaFlagId.CONTEXT_MANAGEMENT_20250627,
      BetaFlagId.PROMPT_CACHING_SCOPE_20260105,
      BetaFlagId.STRUCTURED_OUTPUTS_20251215,
    ])
  })
})

describe("characterization: legacy buildHeaders auth split", () => {
  const oauth: AuthResult = { type: "oauth", token: "tok-oauth" }
  const apiKey: AuthResult = { type: "api-key", token: "sk-test" }

  it("pins OAuth headers: bearer + beta flags + browser-access", () => {
    const h = buildHeaders(oauth, "sid-1", "conversation", "claude-fable-5")
    expect(h.authorization).toBe("Bearer tok-oauth")
    expect(h["x-api-key"]).toBeUndefined()
    expect(h["anthropic-dangerous-direct-browser-access"]).toBe("true")
    expect(h["anthropic-beta"]).toContain("context-1m-2025-08-07")
    expect(h["anthropic-version"]).toBe("2023-06-01")
    expect(h["x-app"]).toBe("cli")
    expect(h["x-claude-code-session-id"]).toBe("sid-1")
  })

  it("pins api-key headers: x-api-key auth split (B2 zero-beta pin DELETED at the B-0 flip)", () => {
    // B2 RESOLVED at the B-0 transport flip (PLAN.md §2; decision package
    // in docs/changes/2026-06-09-fable-5-hardening-and-headers-decoupling.md):
    // the default transport is now the canonical stack, whose api-key
    // requests adopt the canonical (non-OAuth) beta set — the legacy
    // zero-beta behavior was likely broken anyway (the default SYSTEM_PROMPT
    // bakes ttl:"1h" cache_control, which REQUIRES the extended-cache-ttl
    // beta). The old `expect(h["anthropic-beta"]).toBeUndefined()` pin is
    // deliberately DELETED here rather than inverted: this legacy builder is
    // off the default path (reachable only via MINIMAL_AGENT_LEGACY_TRANSPORT
    // =1) and dies wholesale in B-5; its api-key beta behavior is no longer a
    // wire contract worth pinning. The auth-split mechanics it still owns
    // (x-api-key vs bearer, no browser-access header) stay pinned below.
    const h = buildHeaders(apiKey, "sid-2", "conversation", "claude-fable-5")
    expect(h["x-api-key"]).toBe("sk-test")
    expect(h.authorization).toBeUndefined()
    expect(h["anthropic-dangerous-direct-browser-access"]).toBeUndefined()
  })

  it("pins the stainless fingerprint shape", () => {
    const h = buildHeaders(oauth, "sid-3")
    expect(h["x-stainless-lang"]).toBe("js")
    expect(h["x-stainless-runtime"]).toBe("node")
    expect(h["x-stainless-retry-count"]).toBe("0")
    expect(h["x-stainless-timeout"]).toBe("600")
    expect(h["user-agent"]).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/)
  })
})
