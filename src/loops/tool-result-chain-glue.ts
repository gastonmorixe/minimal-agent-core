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
  TruncationInfo,
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

/**
 * The round locals that a chain stage can read and change (legacy form).
 *
 * TEMPORARY ADAPTER (W2 U2). `tool-round.ts` still keeps the result as these
 * locals. U3 builds a `ToolOutcome` in `tool-round.ts` and calls
 * {@link runChainPhase}. U4 removes `ChainVars`, {@link applyChainPhase},
 * `outcomeFromVars` and `varsFromOutcome`.
 */
export interface ChainVars {
  content: string
  isError: boolean | undefined
  aborted: boolean
  truncInfo: TruncationInfo | undefined
  rawForBlob: string | undefined
  display: string | undefined
}

/** Fixed facts of one tool call. */
export interface ChainMeta {
  tool: string
  toolUseId: string
  input: Readonly<Record<string, unknown>>
  /**
   * Blob after the core write, or undefined.
   *
   * TEMPORARY (U4 removes). A second writer of `blob` next to
   * `outcome.blob` (review S3, lead decision D5). U4 removes this field and
   * the `meta.blob ??` read in {@link runChainPhase}.
   */
  blob?: { path: string; bytes: number; sha256: string } | undefined
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
 * @param outcome - Current outcome. `meta.blob` replaces `outcome.blob`.
 * @param meta - Fixed facts of the call.
 * @param opts - Turn abort signal, diagnostics handle and sideband registry.
 * @returns The new outcome and the final stage.
 */
export async function runChainPhase(
  phase: ToolResultPhase,
  entries: readonly ToolResultChainEntry[],
  outcome: ToolOutcome,
  meta: ChainMeta,
  opts: RunPhaseOptions = {},
): Promise<{ outcome: ToolOutcome; stage: ToolResultStage }> {
  const blob = meta.blob ?? outcome.blob
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
    ...(blob !== undefined ? { blob } : {}),
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

/**
 * TEMPORARY ADAPTER (W2 U2, U4 removes it). The legacy locals as a
 * {@link ToolOutcome}: `content` is `body.text`, `display` is
 * `hostHints.view`, no annotation, `isError` undefined is false.
 */
function outcomeFromVars(vars: ChainVars): ToolOutcome {
  return {
    body: { text: vars.content },
    annotations: [],
    isError: vars.isError ?? false,
    aborted: vars.aborted,
    ...(vars.truncInfo !== undefined ? { truncInfo: vars.truncInfo } : {}),
    ...(vars.rawForBlob !== undefined ? { rawForBlob: vars.rawForBlob } : {}),
    ...(vars.display !== undefined ? { hostHints: { view: vars.display } } : {}),
  }
}

/**
 * TEMPORARY ADAPTER (W2 U2, U4 removes it). The legacy locals from a
 * validated outcome. Plain field reads, no second check. Annotations and
 * `body.data` have no local: they are not kept (U3 keeps the outcome).
 */
function varsFromOutcome(o: ToolOutcome): ChainVars {
  return {
    content: o.body.text,
    isError: o.isError,
    aborted: o.aborted,
    truncInfo: o.truncInfo,
    rawForBlob: o.rawForBlob,
    display: o.hostHints?.view,
  }
}

/**
 * TEMPORARY ADAPTER (W2 U2, U4 removes it). Run one phase over the legacy
 * round locals through {@link runChainPhase}. Call it only when
 * {@link hasChainPhase} is true. Never throws.
 *
 * TEMPORARY (U4 removes). Known losses (review W3), with no model byte
 * today because no production stage runs: `varsFromOutcome` keeps only
 * `hostHints.view`, so a stage change to `header`, `footer`,
 * `hideDuration` or `diff` is lost, and a `hostHints` with no `view` clears
 * `display`. A change to `body.data` and each stage annotation are lost.
 * Today the caller passes no `sidebandRegistry` and no per-round
 * `droppedKinds`. U4 calls {@link runChainPhase} on the round outcome with
 * them.
 *
 * @param phase - Phase to run.
 * @param entries - Declared transforms.
 * @param vars - Current round locals.
 * @param meta - Fixed facts of the call.
 * @param opts - Turn abort signal and diagnostics handle.
 * @returns The changed locals and the final stage.
 */
export async function applyChainPhase(
  phase: ToolResultPhase,
  entries: readonly ToolResultChainEntry[],
  vars: ChainVars,
  meta: ChainMeta,
  opts: RunPhaseOptions = {},
): Promise<{ vars: ChainVars; stage: ToolResultStage }> {
  const r = await runChainPhase(phase, entries, outcomeFromVars(vars), meta, opts)
  return { stage: r.stage, vars: varsFromOutcome(r.outcome) }
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
