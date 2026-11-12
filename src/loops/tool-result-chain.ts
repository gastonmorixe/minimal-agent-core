/**
 * Pure runner for the tool-result transform chain (spec R-API-3).
 *
 * No IO and no text. Core writes the blob and calls the sideband neutralizer
 * between phases, so the caller uses {@link runPhase} and interleaves them.
 *
 * @module loops/tool-result-chain
 */

import type {
  ToolResultPhase,
  ToolResultStage,
  ToolResultTransformDecl,
} from "../../plugin-api/src/types/tool-result-chain.ts"
import type { ReadonlySidebandRegistry } from "../sideband/types.ts"

/** A declared transform with the id of the plugin that owns it. */
export interface ToolResultChainEntry {
  /** Owner plugin id. Used for the tie break. */
  pluginId: string
  /** The declaration. */
  decl: ToolResultTransformDecl
}

/** One chain violation, as data. */
export interface ChainViolation {
  /** Violation code. */
  kind: "stamp-multiple" | "clamp-multiple" | "phase-unknown"
  /** Offending plugin id, for `phase-unknown`. */
  pluginId?: string
}

/** Result of {@link validateChain}. */
export interface ChainValidation {
  /** True when there are no violations. */
  ok: boolean
  /** Violations found. */
  violations: ChainViolation[]
}

/** Fixed phase order (R-API-3.1). */
export const TOOL_RESULT_PHASES: readonly ToolResultPhase[] = [
  "clamp",
  "pre-outcome",
  "post-blob",
  "final",
  "stamp",
]

const encoder = new TextEncoder()

function byteCompare(a: string, b: string): number {
  const x = encoder.encode(a)
  const y = encoder.encode(b)
  const n = Math.min(x.length, y.length)
  for (let i = 0; i < n; i++) {
    const d = (x[i] as number) - (y[i] as number)
    if (d !== 0) return d
  }
  return x.length - y.length
}

/**
 * Sort entries by ascending `order`, ties by plugin id in byte order (R-API-3.2).
 *
 * @param entries - Declared transforms.
 * @returns A new sorted array.
 */
export function orderStages(entries: readonly ToolResultChainEntry[]): ToolResultChainEntry[] {
  return [...entries].sort(
    (a, b) => a.decl.order - b.decl.order || byteCompare(a.pluginId, b.pluginId),
  )
}

/**
 * Check chain rules and return violations as data (R-API-3.3, R-API-3.6).
 *
 * @param entries - Declared transforms.
 * @returns Validation result. Never throws.
 */
export function validateChain(entries: readonly ToolResultChainEntry[]): ChainValidation {
  const violations: ChainViolation[] = []
  let stamps = 0
  let clamps = 0
  for (const e of entries) {
    if (!TOOL_RESULT_PHASES.includes(e.decl.phase))
      violations.push({ kind: "phase-unknown", pluginId: e.pluginId })
    else if (e.decl.phase === "stamp") stamps++
    else if (e.decl.phase === "clamp") clamps++
  }
  if (stamps > 1) violations.push({ kind: "stamp-multiple" })
  if (clamps > 1) violations.push({ kind: "clamp-multiple" })
  return { ok: violations.length === 0, violations }
}

/**
 * Run the stages of one phase in order. A throw propagates to the caller.
 *
 * @param phase - Phase to run.
 * @param stage - Input stage.
 * @param entries - All declared transforms.
 * @returns The final stage. The same object when the phase has no stage.
 */
export async function runPhase(
  phase: ToolResultPhase,
  stage: ToolResultStage,
  entries: readonly ToolResultChainEntry[],
): Promise<ToolResultStage> {
  let current = stage
  for (const e of orderStages(entries.filter((x) => x.decl.phase === phase))) {
    current = await e.decl.transform(current)
  }
  return current
}

/**
 * Run all phases in the fixed order. Convenience for tests: core interleaves
 * the blob write and neutralize itself through {@link runPhase}.
 *
 * @param stage - Input stage.
 * @param entries - All declared transforms.
 * @returns The stage after the last phase.
 */
export async function runChain(
  stage: ToolResultStage,
  entries: readonly ToolResultChainEntry[],
): Promise<ToolResultStage> {
  let current = stage
  for (const phase of TOOL_RESULT_PHASES) current = await runPhase(phase, current, entries)
  return current
}

/**
 * Decide the sideband mark from `stage.kind`.
 *
 * @param stage - Stage after the chain.
 * @param registry - Sideband registry for the kind lookup.
 * @returns `{ sideband }` for a known kind, `{ dropped }` for an unknown kind, `{}` with no kind.
 */
export function applyStageKind(
  stage: ToolResultStage,
  registry: Pick<ReadonlySidebandRegistry, "kind">,
): { sideband?: { kind: string }; dropped?: string } {
  if (stage.kind === undefined) return {}
  return registry.kind(stage.kind) ? { sideband: { kind: stage.kind } } : { dropped: stage.kind }
}
