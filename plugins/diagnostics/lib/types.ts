/**
 * Local types for the diagnostics plugin.
 *
 * DECOUPLING: this plugin imports NOTHING from the agent's `src/`. It defines
 * its own {@link Finding} shape that STRUCTURALLY matches the agent's
 * `tool.didInvoke` payload contract (`src/plugins/hooks/tool-lifecycle.ts`).
 * The two meet only at the structural type, never via an import. A drift test
 * (`structural-contract.test.ts`) guards that the shapes stay assignable.
 *
 * @module plugins/diagnostics/lib/types
 */

/** Severity of a finding. Mirrors LSP error/warning/info. */
export type FindingSeverity = "error" | "warning" | "info"

/**
 * One diagnostic the plugin found, in a tool-agnostic shape. Matches the
 * agent's `Finding` so it can be pushed straight onto `payload.findings`.
 */
export interface Finding {
  source: string
  severity: FindingSeverity
  line?: number
  col?: number
  code?: string
  message: string
  path?: string
  /** Scope: "project" (normal) or "ad-hoc" (harness out-of-scope fallback). */
  scope?: string
}

/** Outcome of one provider run. A Result-ish discriminated shape: never throw. */
export type ProviderOutcome =
  | { ok: true; findings: Finding[]; ms: number }
  | { ok: false; degraded: string; ms: number }
