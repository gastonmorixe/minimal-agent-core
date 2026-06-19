/**
 * The {@link DiagnosticProvider} Strategy interface.
 *
 * Each diagnostic tool (tsgo, biome, oxlint, ...) is one provider behind this
 * single interface. The {@link DiagnosticsRunner} depends only on the
 * interface, never on a concrete tool, so adding a language server or linter is
 * "add a provider" with no change to the orchestration or the agent.
 *
 * Providers receive the PROPOSED text (which may differ from disk, for a
 * pre-write check) so they can diagnose exactly what the model wrote. They
 * return {@link Finding}[] or throw; the runner converts a throw/timeout into a
 * degraded outcome (providers never crash the hook).
 *
 * @module plugins/diagnostics/lib/provider
 */
import type { Finding } from "./types.ts"

/** What signal a provider produces (used for ordering + config gating). */
export type ProviderKind = "type" | "lint" | "format" | "apple"

export interface DiagnosticProvider {
  /** Stable id, matches the detected tool id (`"tsgo"`, `"biome"`, ...). */
  readonly id: string
  readonly kind: ProviderKind
  /** Cheap, synchronous gate: does this provider handle this file path? */
  handles(path: string): boolean
  /**
   * Check the proposed `text` for `path`. Resolve with findings, or reject /
   * throw to signal failure (the runner degrades). Honor `signal` for
   * cancellation when possible (the runner aborts on timeout).
   */
  check(path: string, text: string, signal?: AbortSignal): Promise<Finding[]>
  /** Release any held resources (e.g. a persistent LSP child). Idempotent. */
  dispose(): void
  /**
   * Optional: returns true when a persistent LSP server is currently booted
   * and alive. Used by the TUI to show which language servers are running.
   * Non-persistent providers can omit or return false.
   */
  isActive?(): boolean
  /** Return true when `path` is inside this provider's project scope. */
  inScope?(path: string): boolean
}
