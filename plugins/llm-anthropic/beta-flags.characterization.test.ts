/**
 * Characterization snapshots for the Anthropic beta-flag assembler
 * (`./beta-flags.ts`): pin what it emits over the model × auth × kind × fast
 * matrix so a silent change fails here and forces a reviewed edit.
 *
 * Invariants pinned at the bottom:
 *  - redact-thinking: omitted from conversations (thinking stays visible — a
 *    product feature), included in the quota/title probe sets.
 *  - api-key auth: drops the oauth-coupled flags, keeps the rest.
 *  - context-1m: attached for every registered 1M model (the fable-5 P0 guard).
 *  - interleaved-thinking: omitted on opus-4-8 (parallel-tool-batch pathology),
 *    kept elsewhere.
 */

import { beforeAll, describe, expect, it } from "bun:test"

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

describe("characterization: beta-flag invariants per model/auth", () => {
  // These pin the DIFFERENCES between the two builders. When a wave of
  // the decoupling refactor intentionally unifies one of these, it must
  // edit this block in the same commit, which is exactly the review
  // visibility we want.

  it("redact-thinking: BOTH transports omit it from conversations, keep it in probes (B3a)", () => {
    // Conversations keep thinking visible (a product feature), so the redact
    // flag is omitted there; the quota/title probe sets still carry it.
    const model = resolveModel("claude-opus-4-7")
    const req = conversationReq("claude-opus-4-7")
    const canonical = buildBetaFlags({ kind: "conversation", req, model, authKind: "oauth" })
    expect(canonical).not.toContain(F.REDACT_THINKING)
    // Probe kinds keep the flag.
    const canonicalQuota = buildBetaFlags({ kind: "quota", req, model, authKind: "oauth" })
    const canonicalTitle = buildBetaFlags({ kind: "title", req, model, authKind: "oauth" })
    expect(canonicalQuota).toContain(F.REDACT_THINKING)
    expect(canonicalTitle).toContain(F.REDACT_THINKING)
  })

  it("api-key: drops only the oauth-coupled flags, keeps the rest", () => {
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
  })

  it("context-1m membership tracks each model's context window (the fable-5 P0 guard)", () => {
    // The fable-5 P0 was exactly this matrix cell drifting. context-1m is
    // attached iff the registered model is 1M-capable: opus/fable/sonnet-4-6
    // are 1M; sonnet-4-5 and haiku-4-5 are 200K and must NOT carry the flag.
    const expected: Record<string, boolean> = {
      "claude-fable-5": true,
      "claude-opus-4-8": true,
      "claude-opus-4-7": true,
      "claude-opus-4-6": true,
      "claude-sonnet-4-6": true,
      "claude-sonnet-4-5-20250929": false,
      "claude-haiku-4-5-20251001": false,
    }
    for (const modelId of Object.keys(expected)) {
      const model = resolveModel(modelId)
      const hasContext1m = buildBetaFlags({
        kind: "conversation",
        req: conversationReq(modelId),
        model,
        authKind: "oauth",
      }).includes(F.CONTEXT_1M)
      expect({ modelId, hasContext1m }).toEqual({ modelId, hasContext1m: expected[modelId] })
    }
  })

  it("interleaved-thinking: the opus-4-8 omission gate holds", () => {
    // opus-4-8 omits interleaved-thinking (the parallel-tool-batch pathology);
    // opus-4-7 and fable-5 keep it.
    const expected: Record<string, boolean> = {
      "claude-opus-4-8": false,
      "claude-opus-4-7": true,
      "claude-fable-5": true,
    }
    for (const modelId of Object.keys(expected)) {
      const model = resolveModel(modelId)
      const hasInterleaved = buildBetaFlags({
        kind: "conversation",
        req: conversationReq(modelId),
        model,
        authKind: "oauth",
      }).includes(F.INTERLEAVED_THINKING)
      expect({ modelId, hasInterleaved }).toEqual({ modelId, hasInterleaved: expected[modelId] })
    }
  })
})
