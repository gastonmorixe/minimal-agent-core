/**
 * Glue between {@link executeToolRound} and the tool-result chain runner
 * (spec R-API-3). No text. With no stage for a phase, nothing runs.
 *
 * @module loops/tool-result-chain-glue
 */

import type { ToolOutcome } from "../../plugin-api/src/types/tool-outcome.ts"
import type {
  ToolResultPhase,
  ToolResultStage,
} from "../../plugin-api/src/types/tool-result-chain.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import type { ReadonlySidebandRegistry } from "../sideband/types.ts"

import {
  applyStageKind,
  type RunPhaseOptions,
  runPhase,
  SIDEBAND_DROPPED,
  type ToolResultChainEntry,
} from "./tool-result-chain.ts"

/** Fixed facts of one tool call. */
export interface ChainMeta {
  tool: string
  toolUseId: string
  input: Readonly<Record<string, unknown>>
}

/**
 * True when `entries` holds a stage for `phase`. Allocates nothing. Each
 * entry is read inside its own try/catch: an entry whose `decl` or `phase`
 * read throws is skipped. Never throws on a bad entry.
 *
 * @param entries - Declared transforms, or undefined.
 * @param phase - Phase to look for.
 * @returns Whether a stage exists.
 */
export function hasChainPhase(
  entries: readonly ToolResultChainEntry[] | undefined,
  phase: ToolResultPhase,
): boolean {
  if (entries === undefined) return false
  for (const e of entries) {
    try {
      if (e.decl.phase === phase) return true
    } catch {
      // Unreadable entry: skip it. runPhase skips it too.
    }
  }
  return false
}

/**
 * Run one phase over a {@link ToolOutcome} (SPEC D4). Call it only when
 * {@link hasChainPhase} is true. The runner validates each stage result
 * against the D4 field table and the owner rule, so the glue reads the
 * result back with no second check. Fail open per stage (see
 * {@link runPhase}). Never throws.
 *
 * @param phase - Phase to run.
 * @param entries - Declared transforms.
 * @param outcome - Current outcome. Core sets `outcome.blob` after the
 *   blob write; it is the one writer of that field (lead decision D5).
 * @param meta - Fixed facts of the call.
 * @param opts - Turn abort signal, diagnostics handle, sideband registry and
 *   the per-round `droppedKinds` set.
 * @returns The new outcome and the final stage.
 */
export async function runChainPhase(
  phase: ToolResultPhase,
  entries: readonly ToolResultChainEntry[],
  outcome: ToolOutcome,
  meta: ChainMeta,
  opts: RunPhaseOptions = {},
): Promise<{ outcome: ToolOutcome; stage: ToolResultStage }> {
  const stage: ToolResultStage = {
    tool: meta.tool,
    toolUseId: meta.toolUseId,
    input: meta.input,
    body: outcome.body,
    annotations: outcome.annotations,
    isError: outcome.isError,
    aborted: outcome.aborted,
    ...(outcome.media !== undefined ? { media: outcome.media } : {}),
    ...(outcome.truncInfo !== undefined ? { truncInfo: outcome.truncInfo } : {}),
    ...(outcome.rawForBlob !== undefined ? { rawForBlob: outcome.rawForBlob } : {}),
    ...(outcome.blob !== undefined ? { blob: outcome.blob } : {}),
    ...(outcome.hostHints !== undefined ? { hostHints: outcome.hostHints } : {}),
  }
  const out = await runPhase(phase, stage, entries, opts)
  return { stage: out, outcome: outcomeOf(out) }
}

/**
 * The {@link ToolOutcome} fields of a validated stage. Plain field copies:
 * no check, no default (lead decision D5: one writer for each field).
 */
function outcomeOf(s: ToolResultStage): ToolOutcome {
  return {
    body: s.body,
    annotations: [...s.annotations],
    isError: s.isError,
    aborted: s.aborted,
    ...(s.media !== undefined ? { media: s.media } : {}),
    ...(s.truncInfo !== undefined ? { truncInfo: s.truncInfo } : {}),
    ...(s.rawForBlob !== undefined ? { rawForBlob: s.rawForBlob } : {}),
    ...(s.blob !== undefined ? { blob: s.blob } : {}),
    ...(s.hostHints !== undefined ? { hostHints: s.hostHints } : {}),
  }
}

const NO_KINDS: Pick<ReadonlySidebandRegistry, "kind"> = { kind: () => undefined }

/**
 * Decide the sideband mark of the final stage. An unknown kind is dropped
 * and a typed diagnostic with an empty message is emitted.
 *
 * @param stage - Stage after the stamp phase, or undefined when none ran.
 * @param registry - Sideband registry, or undefined.
 * @param diagnostics - Injected handle for the drop diagnostic, or undefined.
 * @returns The mark to put on the result block, or undefined.
 */
export function sidebandMark(
  stage: ToolResultStage | undefined,
  registry: Pick<ReadonlySidebandRegistry, "kind"> | undefined,
  diagnostics?: Diagnostics,
): { kind: string } | undefined {
  if (stage === undefined || stage.kind === undefined) return undefined
  const r = applyStageKind(stage, registry ?? NO_KINDS)
  if (r.dropped !== undefined) {
    diagnostics?.warn(SIDEBAND_DROPPED, "", {
      kind: r.dropped,
      tool: stage.tool,
    })
  }
  return r.sideband
}
