/**
 * Decoupling guard. The diagnostics plugin must NOT depend on the agent at
 * runtime, but its {@link Finding} must stay STRUCTURALLY assignable to the
 * agent's `tool.didInvoke` payload `Finding` so the plugin can push entries
 * straight onto `payload.findings`.
 *
 * This test imports the agent type ONLY in a type position (erased at runtime,
 * no runtime coupling) and asserts assignability in both directions via a
 * compile-time check. If either shape drifts, `bun test`/typecheck fails here
 * instead of silently at the hook boundary.
 */
import { describe, expect, it } from "bun:test"

import type { Finding as AgentFinding } from "../../../src/plugins/hooks/tool-lifecycle.ts"

import type { Finding as PluginFinding } from "./types.ts"

// Compile-time assignability both ways. `satisfies` forces the check; the
// values are never used at runtime.
const _pluginToAgent = ((f: PluginFinding): AgentFinding => f) satisfies (
  f: PluginFinding,
) => AgentFinding
const _agentToPlugin = ((f: AgentFinding): PluginFinding => f) satisfies (
  f: AgentFinding,
) => PluginFinding

describe("structural contract: plugin Finding ⇆ agent Finding", () => {
  it("a plugin Finding is usable as an agent Finding (and vice versa)", () => {
    const f: PluginFinding = {
      source: "tsgo",
      severity: "error",
      code: "TS2322",
      message: "Type 'string' is not assignable to type 'number'.",
      line: 12,
      col: 5,
    }
    const asAgent: AgentFinding = f
    expect(asAgent.code).toBe("TS2322")
    expect(typeof _pluginToAgent).toBe("function")
    expect(typeof _agentToPlugin).toBe("function")
  })
})
