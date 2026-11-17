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
import { abortableSleep } from "../../plugin-api/src/utils/retry.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
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

/** Default time limit of one stage in ms (SPEC D1 item 8). */
export const STAGE_TIMEOUT_MS = 2000

/** Diagnostic source for a stage whose result core drops (SPEC D1 items 6 to 9). */
export const STAGE_FAILED = "tool-result-chain.stage-failed"

/** Why core dropped the result of a stage. */
export type StageFailReason = "throw" | "timeout" | "aborted" | "not-object" | "clone"

/** Options of {@link runPhase} and {@link runChain}. All are optional. */
export interface RunPhaseOptions {
  /**
   * Turn abort. An abort during a stage stops that stage (reason `aborted`).
   * When it is already aborted at the start of a stage, the stage runs with
   * its time limit only.
   */
  signal?: AbortSignal | undefined
  /** Handle for the `stage-failed` diagnostic. Omitted: no diagnostic. */
  diagnostics?: Pick<Diagnostics, "warn"> | undefined
}

/**
 * Freeze `value` and each child. Skip an ArrayBuffer and each ArrayBuffer view
 * (typed array, DataView): `Object.freeze` throws a TypeError on a view with
 * elements (MDN, https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/freeze).
 *
 * Limit: ArrayBuffer and ArrayBuffer views are not frozen. A stage can change
 * them in place, and the next stage then sees the change. Stage data is JSON
 * in practice, so the risk is low.
 */
function deepFreeze<T>(value: T): T {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

/** Lowest per-stage time limit in ms. The highest is {@link STAGE_TIMEOUT_MS}. */
export const STAGE_TIMEOUT_MIN_MS = 1

/**
 * Effective per-stage time limit. Absent or not a finite number gives
 * {@link STAGE_TIMEOUT_MS}. Else floor the value, then clamp it to 1..2000.
 * The loader emits `tool-result-chain.timeout-clamped` when it changes a
 * manifest value. This runner emits no diagnostic.
 *
 * @param timeoutMs - The declared value.
 * @returns The limit in ms.
 */
export function clampStageTimeout(timeoutMs: unknown): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return STAGE_TIMEOUT_MS
  return Math.min(STAGE_TIMEOUT_MS, Math.max(STAGE_TIMEOUT_MIN_MS, Math.floor(timeoutMs)))
}

/** Time limit of one stage: {@link clampStageTimeout} of `decl.timeoutMs`. */
function stageLimit(decl: ToolResultTransformDecl): number {
  return clampStageTimeout(decl.timeoutMs)
}

class StageStop extends Error {}

/**
 * Call one transform with `ctx.signal` = `signal`. Reject with
 * {@link StageStop} when `signal` fires first. Remove the abort listener when
 * the transform settles.
 */
function callStage(
  decl: ToolResultTransformDecl,
  input: ToolResultStage,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new StageStop())
      return
    }
    const onAbort = () => reject(new StageStop())
    signal.addEventListener("abort", onAbort, { once: true })
    const done = () => signal.removeEventListener("abort", onAbort)
    Promise.resolve()
      .then(() => decl.transform(input, { signal }))
      .then(
        (v) => {
          done()
          resolve(v)
        },
        (err: unknown) => {
          done()
          reject(err)
        },
      )
  })
}

/**
 * Deep-frozen `structuredClone`, or undefined when the value cannot be cloned.
 * ArrayBuffer and ArrayBuffer views in the copy are not frozen (see
 * {@link deepFreeze}). A stage can change them in place.
 */
function frozenCopy(value: ToolResultStage): ToolResultStage | undefined {
  try {
    return deepFreeze(structuredClone(value))
  } catch {
    return undefined
  }
}

const isBool = (v: unknown): boolean => v === undefined || typeof v === "boolean"

/** True when `out` has the stage shape that core accepts. */
function isStageShape(out: unknown): out is ToolResultStage {
  if (out === null || typeof out !== "object" || Array.isArray(out)) return false
  const o = out as { content?: unknown; isError?: unknown; aborted?: unknown }
  return typeof o.content === "string" && isBool(o.isError) && isBool(o.aborted)
}

/**
 * Run one stage on a frozen input. Returns a frozen copy of the next stage,
 * or a fail reason. Core copies and freezes each result, so no stage shares
 * a mutable reference with the caller or another stage (SPEC D1 item 7).
 *
 * The stage signal fires on the time limit (reason `timeout`) or on a turn
 * abort during the stage (reason `aborted`). A turn signal that is already
 * aborted when the stage starts does not stop the stage: only the time limit
 * applies. Thus an aborted tool call still gets its clamp and stamp. Core
 * clears the timer and removes the turn listener when the stage settles.
 *
 * The timer is {@link abortableSleep} (an inventoried `setTimeout`, see
 * `src/architecture/timer-inventory.ts`). Abort of `timer` calls
 * `clearTimeout`. No `AbortSignal.timeout`, because it cannot be cleared.
 */
async function runStage(
  e: ToolResultChainEntry,
  input: ToolResultStage,
  turn: AbortSignal | undefined,
): Promise<ToolResultStage | StageFailReason> {
  const ctl = new AbortController()
  const timer = new AbortController()
  let stopped: "timeout" | "aborted" | undefined
  const stop = (why: "timeout" | "aborted") => {
    if (stopped !== undefined) return
    stopped = why
    ctl.abort()
  }
  abortableSleep(stageLimit(e.decl), timer.signal).then(
    () => stop("timeout"),
    () => {},
  )
  const onTurn = () => stop("aborted")
  const watch = turn !== undefined && !turn.aborted ? turn : undefined
  watch?.addEventListener("abort", onTurn, { once: true })
  let out: unknown
  try {
    out = await callStage(e.decl, input, ctl.signal)
  } catch (err) {
    if (!(err instanceof StageStop)) return "throw"
    return stopped ?? "aborted"
  } finally {
    timer.abort()
    watch?.removeEventListener("abort", onTurn)
  }
  if (!isStageShape(out)) return "not-object"
  return frozenCopy(out) ?? "clone"
}

/**
 * Run the stages of one phase in order. Fail open: each stage runs in its own
 * try/catch with a time limit ({@link clampStageTimeout} of
 * `decl.timeoutMs`, default {@link STAGE_TIMEOUT_MS}) and the turn abort. A
 * turn signal that is already aborted does not skip a stage. On a throw, a
 * timeout, an abort during the stage or a result that is not an object with a
 * string `content` (and boolean `isError` and `aborted` when present), core keeps the input
 * of that stage, emits one `tool-result-chain.stage-failed` warning (plugin
 * id, phase, reason) and runs the next stage. Each stage gets a deep-frozen
 * `structuredClone` of its input. A result that cannot be cloned (for example
 * a function value) fails with reason `clone`. Never throws.
 *
 * @param phase - Phase to run.
 * @param stage - Input stage.
 * @param entries - All declared transforms.
 * @param opts - Turn abort signal and diagnostics handle.
 * @returns The final stage, deep-frozen. The same object when the phase has
 *   no stage or when each stage failed.
 */
export async function runPhase(
  phase: ToolResultPhase,
  stage: ToolResultStage,
  entries: readonly ToolResultChainEntry[],
  opts: RunPhaseOptions = {},
): Promise<ToolResultStage> {
  let current = stage
  let input: ToolResultStage | undefined
  for (const e of orderStages(entries.filter((x) => x.decl.phase === phase))) {
    input ??= frozenCopy(current)
    const r = input === undefined ? "clone" : await runStage(e, input, opts.signal)
    if (typeof r === "string") {
      opts.diagnostics?.warn(STAGE_FAILED, "", { pluginId: e.pluginId, phase, reason: r })
    } else current = input = r
  }
  return current
}

/**
 * Run all phases in the fixed order. Convenience for tests: core interleaves
 * the blob write and neutralize itself through {@link runPhase}. Fail open
 * per stage, as {@link runPhase}. Never throws.
 *
 * @param stage - Input stage.
 * @param entries - All declared transforms.
 * @param opts - Turn abort signal and diagnostics handle.
 * @returns The stage after the last phase.
 */
export async function runChain(
  stage: ToolResultStage,
  entries: readonly ToolResultChainEntry[],
  opts: RunPhaseOptions = {},
): Promise<ToolResultStage> {
  let current = stage
  for (const phase of TOOL_RESULT_PHASES) current = await runPhase(phase, current, entries, opts)
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
