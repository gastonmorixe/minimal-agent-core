/**
 * Wave-0 characterization snapshots for the CANONICAL Anthropic beta-flag
 * assembler (`./beta-flags.ts`), plus the cross-transport divergence
 * contract against the legacy builder (`src/headers.ts`).
 *
 * Purpose (see the Phase-3 provider-decoupling plan): before any wave
 * moves code, pin what BOTH builders emit today over the same
 * model × auth × kind × fast matrix, and pin their KNOWN divergences
 * explicitly. A wave that silently changes either side, or silently
 * closes/opens a divergence, fails here and forces a reviewed edit.
 *
 * Known divergences pinned at the bottom (from the Phase-2 review):
 *  - redact-thinking: UNIFIED by the B-0 flip (decision B3a, 2026-06-09
 *    package): BOTH builders now omit it from conversations (thinking
 *    stays visible — a product feature) and include it in probes. The
 *    former divergence pin is now an agreement pin.
 *  - api-key auth: canonical still emits most flags; legacy emits NONE.
 *  - fast-mode: canonical gates on capabilities.speedFast inside the
 *    builder; legacy trusts the caller (gate lives in client.ts).
 */

import { beforeAll, describe, expect, it } from "bun:test"

import { buildBetaFlags as legacyBuildBetaFlags } from "../../src/headers.ts"
import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import { resolveModel } from "../../src/llm/model-registry.ts"

import { ANTHROPIC_BETA_FLAGS, buildBetaFlags, classifyRequest } from "./beta-flags.ts"
import { registerAnthropicModels } from "./models.ts"

beforeAll(() => {
  registerAnthropicModels()
})

/** Minimal conversation-shaped canonical request (multi-tool + 1h ttl). */
function conversationReq(modelId: string, extra?: Partial<CanonicalRequest>): CanonicalRequest {
  return {
    modelId,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }], cache: { ttl: "1h" } }],
    system: [{ type: "text", text: "sys", cache: { ttl: "1h" } }],
    tools: [
      { name: "a", description: "", inputSchema: { type: "object" } },
      { name: "b", description: "", inputSchema: { type: "object" } },
    ],
    effort: "high",
    ...extra,
  } as CanonicalRequest
}

const F = ANTHROPIC_BETA_FLAGS

describe("characterization: canonical buildBetaFlags (conversation, oauth)", () => {
  const cases: ReadonlyArray<[string, string[]]> = [
    [
      "claude-fable-5",
      [
        F.CLAUDE_CODE,
        F.OAUTH,
        F.INTERLEAVED_THINKING,
        F.CONTEXT_1M,
        F.CONTEXT_MANAGEMENT,
        F.ADVANCED_TOOL_USE,
        F.EFFORT,
        F.PROMPT_CACHING_SCOPE,
        F.EXTENDED_CACHE_TTL,
        // redact-thinking omitted for conversations since B3a (B-0 flip):
        // visible thinking is a product feature; matches the legacy builder.
        F.MID_CONVERSATION_SYSTEM,
      ],
    ],
    [
      "claude-opus-4-8",
      [
        F.CLAUDE_CODE,
        F.OAUTH,
        // interleaved-thinking omitted for opus-4-8 (same pathology gate
        // as legacy; the gate is duplicated by id in both builders).
        F.CONTEXT_1M,
        F.CONTEXT_MANAGEMENT,
        F.ADVANCED_TOOL_USE,
        F.EFFORT,
        F.PROMPT_CACHING_SCOPE,
        F.EXTENDED_CACHE_TTL,
        // redact-thinking omitted (B3a).
        F.MID_CONVERSATION_SYSTEM,
      ],
    ],
    [
      "claude-sonnet-4-6",
      [
        F.CLAUDE_CODE,
        F.OAUTH,
        F.INTERLEAVED_THINKING,
        // 1M-native → context-1m via the contextWindow >= 1M arm.
        F.CONTEXT_1M,
        F.CONTEXT_MANAGEMENT,
        F.ADVANCED_TOOL_USE,
        F.EFFORT,
        F.PROMPT_CACHING_SCOPE,
        F.EXTENDED_CACHE_TTL,
        // redact-thinking omitted (B3a).
        F.MID_CONVERSATION_SYSTEM,
      ],
    ],
    [
      "claude-haiku-4-5-20251001",
      [
        F.CLAUDE_CODE,
        F.OAUTH,
        F.INTERLEAVED_THINKING,
        // 200k, no mid-conversation-system, no effort levels → no EFFORT
        // flag would be wrong: haiku HAS no effort levels, so the effort
        // arm is skipped even though req.effort is set.
        F.CONTEXT_MANAGEMENT,
        F.ADVANCED_TOOL_USE,
        F.PROMPT_CACHING_SCOPE,
        F.EXTENDED_CACHE_TTL,
        // redact-thinking omitted (B3a).
      ],
    ],
  ]

  for (const [modelId, expectedSet] of cases) {
    it(`pins the conversation flag set for ${modelId}`, () => {
      const model = resolveModel(modelId)
      const req = conversationReq(modelId)
      expect(classifyRequest(req)).toBe("conversation")
      const flags = buildBetaFlags({ kind: "conversation", req, model, authKind: "oauth" })
      // Declaration-ordered comparison: sort both through the declaration
      // order to keep the pin insensitive to Set insertion details while
      // still pinning MEMBERSHIP exactly.
      const order = Object.values(ANTHROPIC_BETA_FLAGS)
      const sortByDecl = (xs: readonly string[]) =>
        [...xs].sort((a, b) => order.indexOf(a as never) - order.indexOf(b as never))
      expect(sortByDecl(flags)).toEqual(sortByDecl(expectedSet))
    })
  }

  it("pins fast-mode: capability-gated INSIDE the builder", () => {
    const fable = resolveModel("claude-fable-5")
    const opus = resolveModel("claude-opus-4-8")
    const fableFlags = buildBetaFlags({
      kind: "conversation",
      req: conversationReq("claude-fable-5", { speed: "fast" }),
      model: fable,
      authKind: "oauth",
    })
    const opusFlags = buildBetaFlags({
      kind: "conversation",
      req: conversationReq("claude-opus-4-8", { speed: "fast" }),
      model: opus,
      authKind: "oauth",
    })
    expect(fableFlags).not.toContain(F.FAST_MODE) // speedFast:false → dropped
    expect(opusFlags).toContain(F.FAST_MODE) // speedFast:true → kept
  })
})

describe("characterization: cross-transport divergence contract", () => {
  // These pin the DIFFERENCES between the two builders. When a wave of
  // the decoupling refactor intentionally unifies one of these, it must
  // edit this block in the same commit, which is exactly the review
  // visibility we want.

  it("redact-thinking: BOTH transports omit it from conversations, keep it in probes (B3a)", () => {
    // Former divergence pin, flipped to an AGREEMENT pin by the B-0 flip
    // (decision B3a, option (a) of the 2026-06-09 decision package): the
    // canonical builder aligned to legacy — conversations keep thinking
    // visible; the quota/title probe sets still carry the redact flag.
    const model = resolveModel("claude-opus-4-7")
    const req = conversationReq("claude-opus-4-7")
    const canonical = buildBetaFlags({ kind: "conversation", req, model, authKind: "oauth" })
    const legacy = legacyBuildBetaFlags("conversation", "claude-opus-4-7")
    expect(canonical).not.toContain(F.REDACT_THINKING)
    expect(legacy.map(String)).not.toContain(F.REDACT_THINKING)
    // Probe kinds keep the flag on both sides (unchanged by B3a).
    const canonicalQuota = buildBetaFlags({ kind: "quota", req, model, authKind: "oauth" })
    const canonicalTitle = buildBetaFlags({ kind: "title", req, model, authKind: "oauth" })
    expect(canonicalQuota).toContain(F.REDACT_THINKING)
    expect(canonicalTitle).toContain(F.REDACT_THINKING)
    expect(legacyBuildBetaFlags("quota").map(String)).toContain(F.REDACT_THINKING)
    expect(legacyBuildBetaFlags("title").map(String)).toContain(F.REDACT_THINKING)
  })

  it("api-key: canonical still emits flags, legacy emits none (B2)", () => {
    const model = resolveModel("claude-fable-5")
    const canonical = buildBetaFlags({
      kind: "conversation",
      req: conversationReq("claude-fable-5"),
      model,
      authKind: "api-key",
    })
    // Canonical drops only the oauth-coupled flags.
    expect(canonical).not.toContain(F.OAUTH)
    expect(canonical).not.toContain(F.PROMPT_CACHING_SCOPE)
    expect(canonical).toContain(F.CLAUDE_CODE)
    expect(canonical).toContain(F.CONTEXT_1M)
    // Legacy: buildHeaders attaches NO anthropic-beta header for api-key
    // (pinned in src/headers.characterization.test.ts). Cross-referenced
    // here so the two snapshots can't drift apart unnoticed.
  })

  it("context-1m: both transports agree for every registered 1M model", () => {
    // The fable-5 P0 was exactly this matrix cell drifting. Walk every
    // registered Anthropic model and assert legacy and canonical agree
    // on context-1m membership.
    for (const modelId of [
      "claude-fable-5",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
    ]) {
      const model = resolveModel(modelId)
      const canonical = buildBetaFlags({
        kind: "conversation",
        req: conversationReq(modelId),
        model,
        authKind: "oauth",
      }).includes(F.CONTEXT_1M)
      const legacy = legacyBuildBetaFlags("conversation", modelId)
        .map(String)
        .includes(F.CONTEXT_1M)
      expect({ modelId, canonical, legacy }).toEqual({ modelId, canonical, legacy: canonical })
    }
  })

  it("interleaved-thinking: the opus-4-8 omission gate matches across transports", () => {
    for (const modelId of ["claude-opus-4-8", "claude-opus-4-7", "claude-fable-5"]) {
      const model = resolveModel(modelId)
      const canonical = buildBetaFlags({
        kind: "conversation",
        req: conversationReq(modelId),
        model,
        authKind: "oauth",
      }).includes(F.INTERLEAVED_THINKING)
      const legacy = legacyBuildBetaFlags("conversation", modelId)
        .map(String)
        .includes(F.INTERLEAVED_THINKING)
      expect({ modelId, canonical, legacy }).toEqual({ modelId, canonical, legacy: canonical })
    }
  })
})
