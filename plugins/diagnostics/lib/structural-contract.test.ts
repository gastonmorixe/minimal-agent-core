/**
 * Decoupling guard. The diagnostics plugin must NOT depend on the agent at
 * runtime OR at compile time — it must be able to live in its own repo, so it
 * imports NOTHING from `src/`, not even type-only. Its {@link Finding} must
 * nonetheless stay STRUCTURALLY assignable to the agent's `tool.didInvoke`
 * payload `Finding` so the plugin can push entries straight onto
 * `payload.findings`.
 *
 * The contract is enforced here against a LOCAL structural re-declaration of
 * the host's `Finding` (the decoupling idiom: re-state the host slice as a
 * local interface; TypeScript's structural typing makes the real host object
 * satisfy it at runtime). The host-side source of truth for this shape is
 * `src/plugins/hooks/tool-lifecycle.ts` — keep this mirror in lockstep with
 * it. If the plugin's `Finding` and this mirror drift, the compile-time
 * checks below fail in `bun test`/typecheck instead of silently at the hook
 * boundary.
 */
import { describe, expect, it } from "bun:test"

import type { Finding as PluginFinding } from "./types.ts"

/**
 * LOCAL structural mirror of the host's `Finding` (the `tool.didInvoke`
 * payload entry). Source of truth: `src/plugins/hooks/tool-lifecycle.ts`.
 * Re-declared here (not imported) so the plugin stays repo-independent.
 */
interface AgentFinding {
  source: string
  severity: "error" | "warning" | "info"
  line?: number
  col?: number
  code?: string
  message: string
  path?: string
  scope?: string
}

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
