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
 * Core-owned copy of the plugin-owned fields of one entry. Core reads each
 * field one time, then uses only this copy.
 */
interface EntrySnapshot {
  /** The entry as given. */
  entry: ToolResultChainEntry
  pluginId: string
  phase: unknown
  /** `decl.order`, or NaN when it is not a number. */
  order: number
  timeoutMs: unknown
  /** `decl.transform` as read. Core calls it with `decl` as `this`. */
  transform: unknown
  decl: ToolResultTransformDecl
}

/**
 * Read each plugin-owned field of `e` one time inside a try/catch. Gives
 * undefined when a read throws or when the plugin id is not a string (the
 * entry cannot name its plugin). Never throws.
 */
function snapshotEntry(e: ToolResultChainEntry): EntrySnapshot | undefined {
  try {
    const pluginId: unknown = e.pluginId
    if (typeof pluginId !== "string") return undefined
    const decl: unknown = e.decl
    if (decl === null || typeof decl !== "object") return undefined
    const d = decl as ToolResultTransformDecl
    const phase: unknown = d.phase
    const order: unknown = d.order
    const timeoutMs: unknown = d.timeoutMs
    const transform: unknown = d.transform
    return {
      entry: e,
      pluginId,
      phase,
      order: typeof order === "number" ? order : Number.NaN,
      timeoutMs,
      transform,
      decl: d,
    }
  } catch {
    return undefined
  }
}

/** Snapshots of `entries`. An unreadable entry is skipped. */
function snapshotEntries(entries: readonly ToolResultChainEntry[]): EntrySnapshot[] {
  const out: EntrySnapshot[] = []
  for (const e of entries) {
    const s = snapshotEntry(e)
    if (s !== undefined) out.push(s)
  }
  return out
}

/** Sort snapshots by ascending `order`, ties by plugin id in byte order. */
function sortSnapshots<T extends { order: number; pluginId: string }>(list: T[]): T[] {
  return list.sort((a, b) => a.order - b.order || byteCompare(a.pluginId, b.pluginId))
}

/**
 * Sort entries by ascending `order`, ties by plugin id in byte order (R-API-3.2).
 * Each plugin-owned field is read one time inside a try/catch. An entry whose
 * read throws, or whose plugin id is not a string, is skipped.
 *
 * @param entries - Declared transforms.
 * @returns A new sorted array. Never throws on a bad entry.
 */
export function orderStages(entries: readonly ToolResultChainEntry[]): ToolResultChainEntry[] {
  return sortSnapshots(snapshotEntries(entries)).map((s) => s.entry)
}

/**
 * Check chain rules and return violations as data (R-API-3.3, R-API-3.6).
 * Each plugin-owned field is read one time inside a try/catch. An entry whose
 * read throws, or whose plugin id is not a string, is skipped.
 *
 * @param entries - Declared transforms.
 * @returns Validation result. Never throws on a bad entry.
 */
export function validateChain(entries: readonly ToolResultChainEntry[]): ChainValidation {
  const violations: ChainViolation[] = []
  let stamps = 0
  let clamps = 0
  for (const s of snapshotEntries(entries)) {
    const phase = s.phase
    if (!(TOOL_RESULT_PHASES as readonly unknown[]).includes(phase))
      violations.push({ kind: "phase-unknown", pluginId: s.pluginId })
    else if (phase === "stamp") stamps++
    else if (phase === "clamp") clamps++
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
export type StageFailReason =
  | "throw"
  | "timeout"
  | "aborted"
  | "not-object"
  | "clone"
  | "shape"
  | "field-readonly"

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

class StageStop extends Error {}

/**
 * Call the transform of snapshot `s` with `ctx.signal` = `signal`. Reject with
 * {@link StageStop} when `signal` fires first. Remove the abort listener when
 * the transform settles.
 */
function callStage(
  s: EntrySnapshot,
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
      // A transform that is not a function throws here: reason `throw`.
      .then(() =>
        (s.transform as ToolResultTransformDecl["transform"]).call(s.decl, input, { signal }),
      )
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

type Check = (v: unknown) => boolean

const isStr: Check = (v) => typeof v === "string"
const isNum: Check = (v) => typeof v === "number"
const isBoolean: Check = (v) => typeof v === "boolean"
const isRecord: Check = (v) => v !== null && typeof v === "object" && !Array.isArray(v)
const isStrList: Check = (v) => Array.isArray(v) && v.every(isStr)

/** True when each required key of `o` passes and each optional key is absent or passes. */
function fieldsOk(
  o: Record<string, unknown>,
  required: Readonly<Record<string, Check>>,
  optional: Readonly<Record<string, Check>>,
): boolean {
  for (const [k, ok] of Object.entries(required)) if (!ok(o[k])) return false
  for (const [k, ok] of Object.entries(optional)) if (o[k] !== undefined && !ok(o[k])) return false
  return true
}

const isTruncInfo: Check = (v) =>
  isRecord(v) &&
  fieldsOk(
    v as Record<string, unknown>,
    { truncated: isBoolean, shownBytes: isNum, shownLines: isNum, cutLine: isNum },
    { tool: isStr, totalBytes: isNum, totalLines: isNum, startLine: isNum },
  )

const isBlob: Check = (v) =>
  isRecord(v) &&
  fieldsOk(v as Record<string, unknown>, { path: isStr, bytes: isNum, sha256: isStr }, {})

/** Required fields of {@link ToolResultStage} and their runtime checks. */
const STAGE_REQUIRED: Readonly<Record<string, Check>> = {
  tool: isStr,
  toolUseId: isStr,
  input: isRecord,
  content: isStr,
  isError: isBoolean,
  aborted: isBoolean,
  diagnosticNotes: isStrList,
  policyNotes: isStrList,
}

/** Optional fields of {@link ToolResultStage}. An explicit `undefined` clears the field. */
const STAGE_OPTIONAL: Readonly<Record<string, Check>> = {
  truncInfo: isTruncInfo,
  rawForBlob: isStr,
  display: isStr,
  blob: isBlob,
  kind: isStr,
}

/**
 * Read-only fields of {@link ToolResultStage} in `phase` (M0): `aborted` in
 * each phase, `isError` in each phase except `pre-outcome`.
 */
function readOnlyFields(phase: ToolResultPhase): readonly ("aborted" | "isError")[] {
  return phase === "pre-outcome" ? ["aborted"] : ["aborted", "isError"]
}

/** The allow-list: the keys of {@link ToolResultStage} (M0). Other keys are ignored. */
const STAGE_KEYS: readonly string[] = [
  ...Object.keys(STAGE_REQUIRED),
  ...Object.keys(STAGE_OPTIONAL),
]

/**
 * Merge the copy of a stage result over its input, or give `shape`. Only the
 * allow-listed keys of `STAGE_REQUIRED` and `STAGE_OPTIONAL` count. Core
 * ignores each other key with no diagnostic (for example `outcome`,
 * `sideband`, `__proto__`, `constructor`). Core reads each allowed key of
 * `copy` one time. `Object.hasOwn` tells a missing key from a key with the
 * value `undefined`:
 * - missing: the input value stays;
 * - present: the value must have the correct runtime type, else `shape`. A
 *   required key must not be `undefined`. An optional key with the value
 *   `undefined` clears the field.
 *
 * The merged value is a new plain object (prototype `Object.prototype`).
 * Core sets each allowed key on it with an explicit assignment. No spread
 * and no loop over the keys of `copy`. Call it only on a `structuredClone`
 * copy: a copy has no getter and no Proxy, so the reads cannot run plugin
 * code.
 */
function mergeOver(
  input: ToolResultStage,
  copy: Record<string, unknown>,
): Record<string, unknown> | "shape" {
  const from = input as unknown as Record<string, unknown>
  const merged: Record<string, unknown> = {}
  for (const k of STAGE_KEYS) {
    const required = STAGE_REQUIRED[k]
    const check = required ?? (STAGE_OPTIONAL[k] as Check)
    if (!Object.hasOwn(copy, k)) {
      if (Object.hasOwn(from, k)) merged[k] = from[k]
      continue
    }
    const v = copy[k]
    if (v === undefined && required === undefined) continue
    if (!check(v)) return "shape"
    merged[k] = v
  }
  return merged
}

/**
 * Accept the raw result of a stage, or give a fail reason. Core reads no
 * property of `out` before the clone: `typeof` runs no Proxy trap. Then core
 * clones `out` one time (getters and Proxy traps run only in this call),
 * merges the allow-listed keys of the copy over `input` (see
 * {@link mergeOver}), checks the read-only fields and freezes the merged
 * value. Reasons: `not-object` (null, a primitive or an array), `clone` (only
 * the `structuredClone` call fails), `shape` (a present allowed key with the
 * wrong runtime type, or an error after the clone in merge, check or freeze),
 * `field-readonly` (the merged value of a read-only field of `phase` is not
 * the input value). On each reason core drops the whole result. Never throws.
 */
function acceptResult(
  out: unknown,
  input: ToolResultStage,
  phase: ToolResultPhase,
): ToolResultStage | StageFailReason {
  if (out === null || typeof out !== "object") return "not-object"
  let copy: unknown
  try {
    copy = structuredClone(out)
  } catch {
    return "clone"
  }
  try {
    if (!isRecord(copy)) return "not-object"
    const merged = mergeOver(input, copy as Record<string, unknown>)
    if (merged === "shape") return "shape"
    for (const k of readOnlyFields(phase)) if (merged[k] !== input[k]) return "field-readonly"
    return deepFreeze(merged) as unknown as ToolResultStage
  } catch {
    // The clone is plain data, so this is not expected. The value is bad
    // after the clone: label it `shape`, not `clone`.
    return "shape"
  }
}

/**
 * Run one stage on a frozen input. Returns the frozen merged next stage
 * (see {@link acceptResult}), or a fail reason. Core copies and freezes each result, so no stage shares
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
  s: EntrySnapshot,
  phase: ToolResultPhase,
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
  abortableSleep(clampStageTimeout(s.timeoutMs), timer.signal).then(
    () => stop("timeout"),
    () => {},
  )
  const onTurn = () => stop("aborted")
  const watch = turn !== undefined && !turn.aborted ? turn : undefined
  watch?.addEventListener("abort", onTurn, { once: true })
  let out: unknown
  try {
    out = await callStage(s, input, ctl.signal)
  } catch (err) {
    if (!(err instanceof StageStop)) return "throw"
    return stopped ?? "aborted"
  } finally {
    timer.abort()
    watch?.removeEventListener("abort", onTurn)
  }
  return acceptResult(out, input, phase)
}

/**
 * The entries of `phase`, sorted as {@link orderStages}. Each plugin-owned
 * field is read one time inside a try/catch (see `snapshotEntry`). An entry
 * whose read throws, or whose plugin id is not a string, is skipped (it
 * cannot name its plugin). After the read, core uses only the snapshot.
 */
function phaseStages(
  entries: readonly ToolResultChainEntry[],
  phase: ToolResultPhase,
): EntrySnapshot[] {
  return sortSnapshots(snapshotEntries(entries).filter((s) => s.phase === phase))
}

/** Emit one `stage-failed` warning. A throw from the handle is ignored. */
function warnFailed(
  opts: RunPhaseOptions,
  pluginId: string,
  phase: ToolResultPhase,
  reason: StageFailReason,
): void {
  try {
    opts.diagnostics?.warn(STAGE_FAILED, "", { pluginId, phase, reason })
  } catch {
    // A diagnostics failure must not stop the chain.
  }
}

/**
 * Run the stages of one phase in order. Fail open: each stage runs in its own
 * try/catch with a time limit ({@link clampStageTimeout} of
 * `decl.timeoutMs`, default {@link STAGE_TIMEOUT_MS}) and the turn abort. A
 * turn signal that is already aborted does not skip a stage. On a throw, a
 * timeout, an abort during the stage or a bad result, core keeps the input of
 * that stage, emits one `tool-result-chain.stage-failed` warning (plugin id,
 * phase, reason) and runs the next stage. Each stage gets a deep-frozen
 * `structuredClone` of its input. When the input cannot be cloned (a Proxy, a
 * getter that throws), no stage runs, core returns the input as given and
 * emits one warning per stage with reason `clone`. Core clones each result
 * one time, before it reads a property, then merges it over the input: a
 * missing key keeps the input value, a present key replaces it, and an
 * explicit `undefined` clears an optional field. Only the keys of
 * {@link ToolResultStage} count. Core ignores each other key with no
 * diagnostic. Reasons that drop the whole result: `clone` (the result cannot
 * be cloned: a function value, a Proxy, a getter that throws), `not-object`
 * (null, a primitive or an array), `shape` (a present key with the wrong
 * runtime type), `field-readonly` (the merged value of a read-only field is
 * not the input value: `aborted` in each phase, `isError` in each phase
 * except `pre-outcome`), `throw`, `timeout` and `aborted`. Never throws on a
 * bad entry or a bad stage result.
 *
 * The input must be a plain value that core builds. A hostile Proxy as the
 * input is not supported. Known limit: a Proxy input whose `get` trap throws,
 * or a revoked Proxy input, makes the returned promise reject. The promise
 * resolve step reads `then` on the returned value (ECMA-262 Promise Resolve
 * Functions). In production the glue builds the input from core locals, so a
 * plugin cannot cause this.
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
  for (const s of phaseStages(entries, phase)) {
    input ??= frozenCopy(current)
    let r: ToolResultStage | StageFailReason
    try {
      r = input === undefined ? "clone" : await runStage(s, phase, input, opts.signal)
    } catch {
      r = "throw"
    }
    if (typeof r === "string") warnFailed(opts, s.pluginId, phase, r)
    else current = input = r
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
