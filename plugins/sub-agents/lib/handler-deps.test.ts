/**
 * Tests for the model-resolution gating in `serviceDepsFromCtx`.
 *
 * The contract under test: a delegated worker inherits the LEAD's model by
 * default, and only consults the active provider's per-role recommendation
 * (cheap scout / flagship deep) when the user explicitly opts in with
 * `MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1`. This is the regression guard for the
 * silent Opus→Sonnet/Haiku downgrade that surprised users.
 *
 * @module sub-agents/lib/handler-deps.test
 */

import { describe, expect, it } from "bun:test"

import type { TUIContext } from "../../../src/plugins/types.ts"

import { serviceDepsFromCtx } from "./handler-deps.ts"

const LEAD = "11111111-1111-4111-8111-111111111111"

/** A minimal TUIContext good enough for `serviceDepsFromCtx`. */
function makeCtx(env: Record<string, string>, model = "claude-opus-4-8"): TUIContext {
  return {
    cwd: "/repo",
    env,
    agent: { sessionId: LEAD, model },
    // The host wires this from the active provider; here it always offers a
    // cheaper per-role pick, so any leak shows up as a non-lead model.
    recommendSubagentModels: () => [
      { role: "scout", modelId: "claude-haiku-4-5-20251001" },
      { role: "balanced", modelId: "claude-sonnet-4-6" },
      { role: "deep", modelId: "claude-opus-4-8" },
    ],
    queryModelInfo: () => ({ modelId: model }),
  } as unknown as TUIContext
}

describe("serviceDepsFromCtx model gating", () => {
  it("does NOT wire recommendForRole by default (worker inherits the lead's model)", () => {
    const deps = serviceDepsFromCtx(makeCtx({}))
    expect(deps).not.toBeNull()
    // No role mapper means a role-bearing specialist falls through to defaultModel.
    expect(deps?.recommendForRole).toBeUndefined()
    expect(deps?.defaultModel).toBe("claude-opus-4-8")
  })

  it("wires recommendForRole only when MINIMAL_AGENT_SUBAGENT_AUTO_TIER=1", () => {
    const deps = serviceDepsFromCtx(makeCtx({ MINIMAL_AGENT_SUBAGENT_AUTO_TIER: "1" }))
    expect(deps?.recommendForRole).toBeDefined()
    expect(deps?.recommendForRole?.("scout")?.modelId).toBe("claude-haiku-4-5-20251001")
  })

  it("an explicit env model override still wins over auto-tiering", () => {
    const deps = serviceDepsFromCtx(
      makeCtx({
        MINIMAL_AGENT_SUBAGENT_AUTO_TIER: "1",
        MINIMAL_AGENT_SUBAGENT_MODEL: "claude-opus-4-8",
      }),
    )
    // Override short-circuits the role mapper so nothing can downgrade the pick.
    expect(deps?.recommendForRole).toBeUndefined()
    expect(deps?.defaultModel).toBe("claude-opus-4-8")
  })
})
