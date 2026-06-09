/**
 * Degrade-offer pins for `validateAnthropicRequest` (Phase 16).
 *
 * Contract: a request whose ONLY violation is `speed:"fast"` against a
 * model without a fast tier gets a `degrade` offer (same request, no
 * `speed`), so `run({acceptDegrade:true})` proceeds instead of throwing —
 * matching the legacy transport, which drops the field with a warning.
 * Multi-violation requests still fail with no offer.
 */

import { beforeAll, describe, expect, it } from "bun:test"

import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import { resolveModel } from "../../src/llm/model-registry.ts"

import { registerAnthropicModels } from "./models.ts"
import { validateAnthropicRequest } from "./validate.ts"

beforeAll(() => {
  registerAnthropicModels()
})

function fastReq(modelId: string, extra?: Partial<CanonicalRequest>): CanonicalRequest {
  return {
    modelId,
    speed: "fast",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    ...extra,
  } as CanonicalRequest
}

describe("validateAnthropicRequest: fast-mode degrade offer", () => {
  it("offers a speed-stripped degrade when fast is the only violation (fable-5)", () => {
    const model = resolveModel("claude-fable-5")
    const result = validateAnthropicRequest(fastReq("claude-fable-5"), model)
    expect(result.ok).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.capability).toBe("speedFast")
    expect(result.degrade).toBeDefined()
    // The rest-spread removes the key entirely (not just sets undefined).
    expect(result.degrade && "speed" in result.degrade).toBe(false)
    expect(result.degrade?.modelId).toBe("claude-fable-5")
    expect(result.degrade?.messages).toEqual(fastReq("claude-fable-5").messages)
  })

  it("no degrade when fast is allowed (opus-4-8 passes validation outright)", () => {
    const model = resolveModel("claude-opus-4-8")
    const result = validateAnthropicRequest(fastReq("claude-opus-4-8"), model)
    expect(result.ok).toBe(true)
    expect(result.degrade).toBeUndefined()
  })

  it("no degrade when OTHER violations accompany the fast one", () => {
    const model = resolveModel("claude-fable-5")
    // speed:"fast" + previousResponseId (always invalid on this surface).
    const result = validateAnthropicRequest(
      fastReq("claude-fable-5", { previousResponseId: "resp_123" }),
      model,
    )
    expect(result.ok).toBe(false)
    expect(result.errors.length).toBeGreaterThan(1)
    expect(result.degrade).toBeUndefined()
  })
})
