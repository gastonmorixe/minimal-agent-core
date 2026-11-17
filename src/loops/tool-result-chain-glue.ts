/**
 * Glue between {@link executeToolRound} and the tool-result chain runner
 * (spec R-API-3). No text. With no stage for a phase, nothing runs.
 *
 * @module loops/tool-result-chain-glue
 */

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
  type ToolResultChainEntry,
} from "./tool-result-chain.ts"

/** The round locals that a chain stage can read and change. */
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
  /** Blob after the core write, or undefined. */
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
 * Run one phase over the round locals. Call it only when
 * {@link hasChainPhase} is true. Each stage result is merged over its input
 * (a missing key keeps the input value). Fail open per stage (see
 * {@link runPhase}): a failed stage keeps its input and emits
 * `tool-result-chain.stage-failed` on `opts.diagnostics`. Never throws.
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
  const stage: ToolResultStage = {
    tool: meta.tool,
    toolUseId: meta.toolUseId,
    input: meta.input,
    content: vars.content,
    isError: vars.isError ?? false,
    aborted: vars.aborted,
    ...(vars.truncInfo !== undefined ? { truncInfo: vars.truncInfo } : {}),
    ...(vars.rawForBlob !== undefined ? { rawForBlob: vars.rawForBlob } : {}),
    ...(vars.display !== undefined ? { display: vars.display } : {}),
    ...(meta.blob !== undefined ? { blob: meta.blob } : {}),
    diagnosticNotes: [],
    policyNotes: [],
  }
  const out = await runPhase(phase, stage, entries, opts)
  return { stage: out, vars: writeBack(vars, out) }
}

/**
 * The new locals from `out`, the merged and validated result of
 * {@link runPhase}. The stage input holds each optional local that is
 * defined, so an optional key that is absent from `out` was cleared on
 * purpose by a stage (explicit `undefined`, rule 4): write `undefined`. A
 * field with the wrong runtime type keeps the prior local value. The runner
 * validates each stage result, so this is a second guard.
 */
function writeBack(vars: ChainVars, out: ToolResultStage): ChainVars {
  const str = (v: unknown, prior: string): string => (typeof v === "string" ? v : prior)
  const bool = <T>(v: unknown, prior: T): boolean | T => (typeof v === "boolean" ? v : prior)
  /** Absent key: cleared. Present key: the value when `ok`, else the prior local. */
  const opt = <T>(
    key: keyof ToolResultStage,
    ok: (v: unknown) => boolean,
    prior: T,
  ): T | undefined => {
    if (!Object.hasOwn(out, key)) return undefined
    const v: unknown = out[key]
    return ok(v) ? (v as T) : prior
  }
  const isStr = (v: unknown) => typeof v === "string"
  return {
    content: str(out.content, vars.content),
    isError: bool(out.isError, vars.isError),
    aborted: bool(out.aborted, vars.aborted),
    truncInfo: opt("truncInfo", (v) => v !== null && typeof v === "object", vars.truncInfo),
    rawForBlob: opt("rawForBlob", isStr, vars.rawForBlob),
    display: opt("display", isStr, vars.display),
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
    diagnostics?.warn("tool-result-chain.sideband-dropped", "", {
      kind: r.dropped,
      tool: stage.tool,
    })
  }
  return r.sideband
}
