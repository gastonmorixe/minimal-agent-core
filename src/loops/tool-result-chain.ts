/**
 * Pure runner for the tool-result transform chain (spec R-API-3).
 *
 * No IO and no text. Core writes the blob and calls the sideband neutralizer
 * between phases, so the caller uses {@link runPhase} and interleaves them.
 *
 * @module loops/tool-result-chain
 */

import {
  CORE_ANNOTATION_KINDS,
  PLUGIN_ANNOTATION_CAPS,
  TOOL_OUTCOME_FIELD_TABLE,
  type ToolAnnotation,
  type ToolOutcomeField,
  type ToolOutcomeFieldPermission,
} from "../../plugin-api/src/types/tool-outcome.ts"
import type {
  ToolResultPhase,
  ToolResultStage,
  ToolResultTransformDecl,
  TruncationInfo,
} from "../../plugin-api/src/types/tool-result-chain.ts"
import { abortableSleep } from "../../plugin-api/src/utils/retry.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import { ID_RE } from "../plugins/manifest.ts"
import { createSidebandRegistry } from "../sideband/registry.ts"
import type { ReadonlySidebandRegistry, SidebandAttrDecl, SidebandKind } from "../sideband/types.ts"

import {
  type RenderCause,
  type RenderMessage,
  renderText,
  type TextRenderer,
} from "./tool-result-chain-render.ts"

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
  | "owner"
  | "size"

export { PLUGIN_ANNOTATION_CAPS }

/** A `"size"` failure with the value that broke the cap. */
interface SizeFail {
  reason: "size"
  /** The count over the cap (annotations or attrs). */
  count?: number
  /** The bytes over the cap. */
  bytes?: number
  /** The cap that the value broke. */
  cap: number
}

/** Why core dropped the result of a stage, with the detail of a cap. */
type StageFailure = StageFailReason | SizeFail

/**
 * Diagnostic source for a stage annotation that core drops: its kind is not
 * registered with placement `"tool-result"` (SPEC D4 owner rule 4). The same
 * source as the unknown-kind drop of the sideband mark.
 */
export const SIDEBAND_DROPPED = "tool-result-chain.sideband-dropped"

/**
 * Diagnostic source for a stage annotation that core drops because it cannot
 * compute the rendered text of its registered kind (SPEC D4 owner rule 5,
 * erratum E8). Data: `{pluginId, phase, tool, count, kinds, cause}`.
 */
export const SIDEBAND_RENDER_FAILED = "tool-result-chain.sideband-render-failed"

export type { RenderCause, RenderMessage, TextRenderer }

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
  /**
   * Sideband registry for the owner rule (rules 2 and 4). Omitted: no kind
   * is known, so core drops each new stage annotation (rule 4).
   */
  sidebandRegistry?: Pick<ReadonlySidebandRegistry, "kind"> | undefined
  /**
   * The keys `pluginId + "\u0000" + kind` of the rule 4 drops that already
   * have a diagnostic. Core adds to it, at most {@link DROPPED_KINDS_CAP}
   * keys per plugin. Omitted: core uses one set for each `entries` array
   * (one load of the chain), so a kind gives one diagnostic per plugin per
   * load, not one per call.
   */
  droppedKinds?: Set<string> | undefined
  /**
   * Text codec for owner rule 5. For a new stage annotation of a registered
   * kind, core computes `text` with `sideband.render` and replaces the text
   * of the plugin. Core calls `render` at most 8 times per stage call (the
   * count cap of 8 plugin annotations runs first). Omitted: core drops each
   * such annotation (cause `no-codec`). The stage context does not change.
   * A render failure drops that one annotation, but a rendered text over a cap
   * drops the whole stage result (reason size); a plugin cannot know the
   * rendered length ahead, so keep bodies well below the cap.
   */
  sideband?: TextRenderer | undefined
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

/** Marker of a value with the wrong runtime type. */
const SHAPE: unique symbol = Symbol("shape")

/**
 * Parse one present value of a stage key. Give a new core-built value, or
 * {@link SHAPE} for the wrong runtime type. Nested records are rebuilt with
 * explicit assignment of their known keys, so an unknown or `__proto__` key
 * of the copy never reaches the merged value.
 */
type Parse = (v: unknown) => unknown

const isStr = (v: unknown): v is string => typeof v === "string"
const isNum = (v: unknown): v is number => typeof v === "number"
const isBool = (v: unknown): v is boolean => typeof v === "boolean"
const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)

const asStr: Parse = (v) => (isStr(v) ? v : SHAPE)
const asBool: Parse = (v) => (isBool(v) ? v : SHAPE)
/** Any record. Core keeps it as given (read-only facts, for example `input`). */
const asRecord: Parse = (v) => (isRecord(v) ? v : SHAPE)

/**
 * Copy the keys of `spec` from `o` with explicit assignment. A required key
 * must pass. An optional key may be absent or `undefined` (then it is not
 * copied). Give {@link SHAPE} on the first bad key.
 */
function pick(
  o: unknown,
  required: Readonly<Record<string, (v: unknown) => boolean>>,
  optional: Readonly<Record<string, (v: unknown) => boolean>> = {},
): Record<string, unknown> | typeof SHAPE {
  if (!isRecord(o)) return SHAPE
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(required)) {
    const v = Object.hasOwn(o, k) ? o[k] : undefined
    if (!(required[k] as (v: unknown) => boolean)(v)) return SHAPE
    out[k] = v
  }
  for (const k of Object.keys(optional)) {
    const v = Object.hasOwn(o, k) ? o[k] : undefined
    if (v === undefined) continue
    if (!(optional[k] as (v: unknown) => boolean)(v)) return SHAPE
    out[k] = v
  }
  return out
}

/** One key of {@link TruncationInfo}: required or optional, and its type check. */
interface TruncKeyRule {
  required: boolean
  check: (v: unknown) => boolean
}

/**
 * The keys of {@link TruncationInfo}. The `satisfies` gives a type error when
 * the type gets or loses a key (review W2). The parser keeps only these keys,
 * on the stage result and on the input (see `breaksReadOnly`).
 */
export const TRUNC_INFO_RULES = {
  tool: { required: false, check: isStr },
  truncated: { required: true, check: isBool },
  shownBytes: { required: true, check: isNum },
  shownLines: { required: true, check: isNum },
  totalBytes: { required: false, check: isNum },
  totalLines: { required: false, check: isNum },
  cutLine: { required: true, check: isNum },
  startLine: { required: false, check: isNum },
} satisfies Record<keyof TruncationInfo, TruncKeyRule>

function truncChecks(required: boolean): Record<string, (v: unknown) => boolean> {
  const out: Record<string, (v: unknown) => boolean> = {}
  for (const [k, r] of Object.entries(TRUNC_INFO_RULES))
    if (r.required === required) out[k] = r.check
  return out
}

const TRUNC_REQUIRED = truncChecks(true)
const TRUNC_OPTIONAL = truncChecks(false)

const asTruncInfo: Parse = (v) => pick(v, TRUNC_REQUIRED, TRUNC_OPTIONAL)

const asBlob: Parse = (v) => pick(v, { path: isStr, bytes: isNum, sha256: isStr })

const asHostHints: Parse = (v) => {
  const out = pick(v, {}, { view: isStr, header: isStr, footer: isStr, hideDuration: isBool })
  if (out === SHAPE || !isRecord(v) || !Object.hasOwn(v, "diff") || v.diff === undefined) return out
  const diff = pick(v.diff, { patch: isStr, newFile: isBool })
  if (diff === SHAPE) return SHAPE
  out.diff = diff
  return out
}

/** `{ text }` or `{ data, text, schema? }` (D3). `data` is kept as given. */
const asBody: Parse = (v) => {
  if (!isRecord(v) || !isStr(v.text)) return SHAPE
  if (!Object.hasOwn(v, "data")) return { text: v.text }
  const out: Record<string, unknown> = { data: v.data, text: v.text }
  if (v.schema === undefined) return out
  if (!isRecord(v.schema)) return SHAPE
  out.schema = v.schema
  return out
}

/** An array of image blocks. Each block is kept as given. */
const asMedia: Parse = (v) =>
  Array.isArray(v) && v.every((b) => isRecord(b) && b.type === "image") ? v : SHAPE

const isAttrValue = (v: unknown) => isStr(v) || isNum(v) || isBool(v)

/**
 * One annotation. `owner` is kept only when it is a string: the owner rule
 * reads it to find the annotations of other owners, then sets it on each
 * annotation of the stage plugin. On a stage result, `attrCountCap` ran
 * before this parse, so the attr copy loop runs on at most 16 keys of a
 * plugin annotation (review F20).
 */
const asAnnotation: Parse = (v) => {
  const out = pick(
    v,
    { kind: isStr, text: isStr, join: isStr },
    { body: isStr, joinWhenEmpty: isBool, owner: isStr },
  )
  if (out === SHAPE || !isRecord(v) || v.attrs === undefined) return out
  if (!isRecord(v.attrs)) return SHAPE
  const attrs: Record<string, unknown> = {}
  for (const k of Object.keys(v.attrs)) {
    const a = v.attrs[k]
    if (!isAttrValue(a)) return SHAPE
    Object.defineProperty(attrs, k, { value: a, enumerable: true, writable: true })
  }
  out.attrs = attrs
  return out
}

const asAnnotations: Parse = (v) => {
  if (!Array.isArray(v)) return SHAPE
  const out: unknown[] = []
  for (const a of v) {
    const p = asAnnotation(a)
    if (p === SHAPE) return SHAPE
    out.push(p)
  }
  return out
}

/** One key of {@link ToolResultStage}. */
interface StageKeyRule {
  /** True when the key must be present with a value. */
  required: boolean
  /** Runtime type check and rebuild. */
  parse: Parse
}

/**
 * The allow-list: each key of {@link ToolResultStage}. Other keys are
 * ignored. `tool`, `toolUseId` and `input` are not in the D4 field table:
 * they are read only in each phase.
 */
const STAGE_KEY_RULES = {
  tool: { required: true, parse: asStr },
  toolUseId: { required: true, parse: asStr },
  input: { required: true, parse: asRecord },
  body: { required: true, parse: asBody },
  media: { required: false, parse: asMedia },
  annotations: { required: true, parse: asAnnotations },
  isError: { required: true, parse: asBool },
  aborted: { required: true, parse: asBool },
  truncInfo: { required: false, parse: asTruncInfo },
  rawForBlob: { required: false, parse: asStr },
  blob: { required: false, parse: asBlob },
  hostHints: { required: false, parse: asHostHints },
  kind: { required: false, parse: asStr },
} as const satisfies Record<keyof ToolResultStage, StageKeyRule>

type StageKey = keyof typeof STAGE_KEY_RULES

/** The allowed stage keys, from {@link STAGE_KEY_RULES} (review S2). */
const STAGE_KEYS = Object.keys(STAGE_KEY_RULES) as readonly StageKey[]

/** Stage keys that no stage may change, in each phase (D4: "unchanged, read only"). */
const CONTEXT_KEYS: readonly StageKey[] = ["tool", "toolUseId", "input"]

/** Marker of an absent body arm field. */
const ABSENT: unique symbol = Symbol("absent")

/** How core reads one field of the D4 field table from a stage. */
interface FieldReader {
  /** The stage key that holds the field. */
  key: StageKey
  /** The value of the field, or {@link ABSENT}. */
  read(s: Record<string, unknown>): unknown
}

/** An absent key and a key with the value `undefined` are the same field value. */
const top =
  (key: StageKey): FieldReader["read"] =>
  (s) =>
    Object.hasOwn(s, key) && s[key] !== undefined ? s[key] : ABSENT

const bodyPart =
  (part: "text" | "data" | "schema"): FieldReader["read"] =>
  (s) => {
    const b = s.body
    return isRecord(b) && Object.hasOwn(b, part) && b[part] !== undefined ? b[part] : ABSENT
  }

/**
 * Where each field of {@link TOOL_OUTCOME_FIELD_TABLE} lives on a stage. The
 * `satisfies` gives a type error when the table gets a field with no reader.
 * The permissions come only from the table (lead decision D2).
 */
export const STAGE_FIELD_READERS = {
  "body.text": { key: "body", read: bodyPart("text") },
  "body.data": { key: "body", read: bodyPart("data") },
  "body.schema": { key: "body", read: bodyPart("schema") },
  media: { key: "media", read: top("media") },
  annotations: { key: "annotations", read: top("annotations") },
  isError: { key: "isError", read: top("isError") },
  aborted: { key: "aborted", read: top("aborted") },
  truncInfo: { key: "truncInfo", read: top("truncInfo") },
  rawForBlob: { key: "rawForBlob", read: top("rawForBlob") },
  blob: { key: "blob", read: top("blob") },
  hostHints: { key: "hostHints", read: top("hostHints") },
  kind: { key: "kind", read: top("kind") },
} as const satisfies Record<ToolOutcomeField, FieldReader>

/**
 * The permission of `phase` for `field`, read from
 * {@link TOOL_OUTCOME_FIELD_TABLE}. The runner reads each permission here.
 *
 * @param field - A field of the D4 field table.
 * @param phase - A chain phase.
 * @returns `"yes"`, `"no"` or `"own"`.
 */
export function fieldPermission(
  field: ToolOutcomeField,
  phase: ToolResultPhase,
): ToolOutcomeFieldPermission {
  return TOOL_OUTCOME_FIELD_TABLE[field][phase]
}

/**
 * Value compare of plain data. `undefined` and an absent key are equal.
 * Typed arrays compare by bytes, a Date by its time. Other objects with a
 * prototype that is not `Object.prototype` or `null` compare by identity.
 */
export function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => sameValue(x, b[i]))
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
    return x.length === y.length && x.every((n, i) => n === y[i])
  }
  if (a instanceof Date || b instanceof Date)
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime()
  const plain = (o: object) => {
    const p: unknown = Object.getPrototypeOf(o)
    return p === Object.prototype || p === null
  }
  if (!plain(a) || !plain(b)) return false
  const x = a as Record<string, unknown>
  const y = b as Record<string, unknown>
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)]))
    if (!sameValue(x[k], y[k])) return false
  return true
}

/**
 * True when `kind` is a core annotation kind (D4 owner rule 3). No stage may
 * add one. Core uses only {@link CORE_ANNOTATION_KINDS} for this check (lead
 * decision: the stored record has no owner field, so the kind gives the
 * core status). The list has 7 names, so the scan is O(1).
 */
export function isCoreAnnotationKind(kind: string): boolean {
  return (CORE_ANNOTATION_KINDS as readonly string[]).includes(kind)
}

/** The registry view of the owner rule. */
type KindLookup = Pick<ReadonlySidebandRegistry, "kind">

/**
 * The stored owner of each core annotation. A plain string, because the
 * record is persisted to JSONL (lead decision F10: no Symbol).
 */
const CORE_OWNER = "core"

/**
 * True when no stage of `pluginId` may run: the id is empty or whitespace,
 * or it is `"core"` with any case and with spaces around it (review F10).
 *
 * @param pluginId - The plugin id of a chain entry.
 * @returns Whether the id is reserved.
 */
export function isReservedPluginId(pluginId: string): boolean {
  const id = pluginId.trim()
  return id === "" || id.toLowerCase() === CORE_OWNER
}

/**
 * True when no stage of `pluginId` may run: the id is reserved (see
 * {@link isReservedPluginId}), or it does not obey the plugin id rule of
 * the manifest (`ID_RE` of `src/plugins/manifest.ts`, lead decision c,
 * Scott 19:19). Thus `"core\u200b"` and other ids that look like a valid
 * id cannot run, and a manifest id such as `"beh_one"` can.
 */
function badPluginId(pluginId: string): boolean {
  return isReservedPluginId(pluginId) || !ID_RE.test(pluginId)
}

/**
 * True when a stage of `pluginId` does not own the input annotation `a`.
 * Each annotation with the owner `"core"` or a core kind belongs to core,
 * also when its owner string equals `pluginId` (review F10). Core reads
 * `owner` only from its own pre-call copy of the stage input.
 */
function notOwnedBy(a: ToolAnnotation, pluginId: string): boolean {
  return a.owner !== pluginId || isCoreOwned(a)
}

/** True when the input annotation `a` belongs to core: owner `"core"` or a core kind. */
function isCoreOwned(a: ToolAnnotation): boolean {
  return a.owner === CORE_OWNER || isCoreAnnotationKind(a.kind)
}

/** The joins that a plugin annotation may have (review F11). */
const PLUGIN_JOINS: ReadonlySet<string> = new Set(["\n\n", "\n", ""])

/** The attr declaration of the probe kind. Its type is not read. */
const PROBE_ATTR: SidebandAttrDecl = { type: "string" }

/**
 * True when `key` is a valid name of the sideband registry (the rule of an
 * attr name and of a kind name). Core reuses the registry rule (the
 * kind-name regex and the length limit of `src/sideband/registry.ts`)
 * through a probe registration on a new, private registry: no second regex.
 * The probe puts `key` in an attr name, so the registry applies only the
 * name rule to it (not the `xml` prefix rule of kind names). `__proto__`,
 * `"Bad Key"` and `"core\u200b"` fail. Core uses it for attr keys. The
 * plugin id of a stage uses the manifest rule (see `badPluginId`).
 */
function validRegistryName(key: string): boolean {
  try {
    createSidebandRegistry().register(
      {
        kind: "probe",
        owner: "",
        direction: "to-model",
        placement: "tool-result",
        attrs: { [key]: PROBE_ATTR },
        body: "none",
        trust: "untrusted",
        summary: "",
      },
      "probe",
    )
    return true
  } catch {
    return false
  }
}

/**
 * True when the new plugin annotation `a` has a bad shape: a `join` that is
 * not `"\n\n"`, `"\n"` or `""` (F11), an attr key that is not a valid
 * sideband attr name, or a number attr that is not finite (F14). The type
 * checks of each field ran in the parse step.
 */
function badPluginShape(a: Record<string, unknown>): boolean {
  if (!PLUGIN_JOINS.has(a.join as string)) return true
  const attrs = a.attrs
  if (!isRecord(attrs)) return false
  for (const k of Object.keys(attrs)) {
    const v = attrs[k]
    if (isNum(v) && !Number.isFinite(v)) return true
    if (!validRegistryName(k)) return true
  }
  return false
}

/** UTF-8 bytes of `v`, or 0 when it is not a string. */
function utf8Bytes(v: unknown): number {
  return isStr(v) ? Buffer.byteLength(v, "utf8") : 0
}

/**
 * The attr count cap (review F20): the first plugin annotation (a kind that
 * is not a core kind) of the result copy with more attr keys than
 * `PLUGIN_ANNOTATION_CAPS.attrs` (16). Core runs it before the
 * parse (see `acceptResult`), so the parse never copies a large attrs object
 * key by key. The cost is one `Object.keys` per annotation.
 */
function attrCountCap(copy: Record<string, unknown>): SizeFail | undefined {
  const list = copy.annotations
  if (!Array.isArray(list)) return undefined
  const cap = PLUGIN_ANNOTATION_CAPS.attrs
  for (const a of list) {
    if (!isRecord(a) || !isRecord(a.attrs) || isCoreAnnotationKind(a.kind as string)) continue
    const n = Object.keys(a.attrs).length
    if (n > cap) return { reason: "size", count: n, cap }
  }
  return undefined
}

/**
 * Check the byte caps of {@link PLUGIN_ANNOTATION_CAPS} on the parsed result
 * annotations. Only plugin annotations count (a kind that is not a core
 * kind). O(n) in the annotations and their attrs. The annotation count and
 * the attr count are checked before the parse (see `acceptResult`).
 *
 * `countBody` true (the check before the render): an annotation counts
 * `text` + `body`, so a `body` over the per-annotation cap is a hard cap on
 * the field and drops the result before any render call. `countBody` false
 * (the check after the render): it counts the text only, as the SPEC E14.
 */
function capCheck(
  annotations: readonly Record<string, unknown>[],
  countBody: boolean,
): SizeFail | undefined {
  const caps = PLUGIN_ANNOTATION_CAPS
  const plugin = annotations.filter((a) => !isCoreAnnotationKind(a.kind as string))
  let total = 0
  for (const a of plugin) {
    const own = utf8Bytes(a.text) + (countBody ? utf8Bytes(a.body) : 0)
    if (own > caps.textBytes) return { reason: "size", bytes: own, cap: caps.textBytes }
    total += own
    const attrs = isRecord(a.attrs) ? a.attrs : {}
    for (const k of Object.keys(attrs)) {
      const b = utf8Bytes(attrs[k])
      if (b > caps.attrValueBytes) return { reason: "size", bytes: b, cap: caps.attrValueBytes }
      total += utf8Bytes(k) + b
    }
    if (total > caps.outcomeBytes) return { reason: "size", bytes: total, cap: caps.outcomeBytes }
  }
  return undefined
}

/** The rule 5 render failures of one stage call: kind, then the first cause. */
type RenderFailed = Map<string, RenderCause>

/** Result of the owner rule: the annotations to keep, or a fail reason. */
type OwnerResult =
  | { annotations: ToolAnnotation[]; dropped: Set<string>; failed: RenderFailed }
  | "owner"
  | "shape"

/** The fields of a registry kind that the owner rule reads. */
type KindFacts = Pick<SidebandKind, "owner" | "placement" | "trust">

/**
 * The owner rule facts of `kind`, read one time, or undefined when the
 * registry does not know the kind. A throw from the registry gives
 * undefined (the kind is unknown: rule 4).
 */
function lookupKind(registry: KindLookup, kind: string): KindFacts | undefined {
  try {
    const k: unknown = registry.kind(kind)
    if (!isRecord(k)) return undefined
    const { owner, placement, trust } = k as unknown as SidebandKind
    return { owner, placement, trust }
  } catch {
    return undefined
  }
}

/**
 * Apply the D4 owner rule to the annotations of a stage result.
 *
 * - Rules 1 and 3 (same order, lead decision 18:00): `others` holds the
 *   input annotations that the stage plugin does not own (see
 *   `notOwnedBy`), taken from the runner's own pre-call copy of the stage
 *   input. Each of them must stay in the result, in the same order, with the
 *   same fields (value compare, `owner` included). Else `"owner"`. The stage
 *   plugin may add or remove its own annotations at any position. A swap of
 *   two `others` gives `"owner"`. Core walks the result one time: an
 *   annotation equal to the next annotation of `others` is that annotation,
 *   and core keeps the input value (with its input `owner`). Each other
 *   annotation of the result is a new stage annotation.
 * - Rule 3 (G-1): a new stage annotation of a core kind: `"owner"`.
 * - F11 and F14: a new stage annotation with a bad `join`, a bad attr key or
 *   a number attr that is not finite: `"shape"` (see `badPluginShape`).
 * - Rule 2 (G-2): a new stage annotation of a `trust: "harness"` kind that
 *   `pluginId` does not own in the registry: `"owner"`.
 * - Rule 4: a new stage annotation of a kind that the registry does not
 *   know, or with a placement that is not `"tool-result"`, is dropped alone.
 *   Core keeps the rest of the result and gives the kind in `dropped`.
 * - Rule 5 (erratum E8): for a new stage annotation of a registered kind,
 *   core computes `text` with `sideband` (see `renderText`) and
 *   replaces the text of the plugin. On a failure core drops that one
 *   annotation and gives its kind and cause in `failed`.
 * - T11 case 4: core sets `owner = pluginId` on each new stage annotation.
 *   The `owner` that the stage gives has no effect.
 */
function applyOwnerRule(
  pre: PreCall,
  after: readonly Record<string, unknown>[],
  pluginId: string,
  registry: KindLookup,
  sideband: TextRenderer | undefined,
): OwnerResult {
  const others = pre.others
  const annotations: ToolAnnotation[] = []
  const dropped = new Set<string>()
  const failed: RenderFailed = new Map()
  let j = 0
  for (const a of after) {
    const next = others[j]
    if (next !== undefined && sameValue(a, next)) {
      annotations.push(next)
      j++
      continue
    }
    const kind = a.kind as string
    if (isCoreAnnotationKind(kind)) return "owner"
    if (badPluginShape(a)) return "shape"
    const reg = lookupKind(registry, kind)
    if (reg === undefined || reg.placement !== "tool-result") {
      dropped.add(kind)
      continue
    }
    if (reg.trust === "harness" && reg.owner !== pluginId) return "owner"
    // Rule 5: a plugin annotation that equals its own input annotation keeps
    // the input text and needs no render call.
    const kept = pre.own.find(
      (o) => o.kind === kind && sameValue(o.attrs, a.attrs) && sameValue(o.body, a.body),
    )
    const r = kept
      ? { text: kept.text }
      : renderText(sideband, kind, a.attrs as never, a.body as string | undefined)
    if ("cause" in r) {
      failed.set(kind, r.cause)
      continue
    }
    annotations.push({ ...(a as unknown as ToolAnnotation), text: r.text, owner: pluginId })
  }
  if (j !== others.length) return "owner"
  return { annotations, dropped, failed }
}

/**
 * Merge the copy of a stage result over its input, or give `shape`. Only the
 * keys of {@link STAGE_KEY_RULES} count. Core ignores each other key with no
 * diagnostic (for example `outcome`, `sideband`, `__proto__`,
 * `constructor`). Core reads each allowed key of `copy` one time.
 * `Object.hasOwn` tells a missing key from a key with the value `undefined`:
 * - missing: the input value stays;
 * - present: the value must have the correct runtime type, else `shape`. A
 *   required key must not be `undefined`. An optional key with the value
 *   `undefined` clears the field.
 *
 * The merged value is a new plain object (prototype `Object.prototype`).
 * Core sets each allowed key on it with an explicit assignment. Call it only
 * on a `structuredClone` copy: a copy has no getter and no Proxy, so the
 * reads cannot run plugin code.
 */
function mergeOver(
  input: ToolResultStage,
  copy: Record<string, unknown>,
): Record<string, unknown> | "shape" {
  const from = input as unknown as Record<string, unknown>
  const merged: Record<string, unknown> = {}
  for (const k of STAGE_KEYS) {
    const rule: StageKeyRule = STAGE_KEY_RULES[k]
    if (!Object.hasOwn(copy, k)) {
      if (Object.hasOwn(from, k)) merged[k] = from[k]
      continue
    }
    const v = copy[k]
    if (v === undefined && !rule.required) continue
    const parsed = rule.parse(v)
    if (parsed === SHAPE) return "shape"
    merged[k] = parsed
  }
  return merged
}

/**
 * The input as core parses a stage result: each allowed key that is present
 * goes through the parse of {@link STAGE_KEY_RULES}, so unknown nested keys
 * (for example a new `TruncationInfo` key) are dropped on the two sides of
 * the compare (review W2). A key whose parse fails keeps its raw value.
 */
function parsedInput(from: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of STAGE_KEYS) {
    if (!Object.hasOwn(from, k) || from[k] === undefined) continue
    const p = STAGE_KEY_RULES[k].parse(from[k])
    out[k] = p === SHAPE ? from[k] : p
  }
  return out
}

/**
 * True when `merged` changes a read-only field of `phase`: a context key, or
 * a field whose cell in {@link TOOL_OUTCOME_FIELD_TABLE} is `"no"`. Value
 * compare of the parsed input with the parsed result (like with like, see
 * `parsedInput`). On no change of an allowed key, core keeps the input value
 * of that key.
 */
function breaksReadOnly(
  input: ToolResultStage,
  merged: Record<string, unknown>,
  phase: ToolResultPhase,
): boolean {
  const from = input as unknown as Record<string, unknown>
  const parsed = parsedInput(from)
  for (const k of CONTEXT_KEYS) if (!sameValue(parsed[k], merged[k])) return true
  for (const f of Object.keys(STAGE_FIELD_READERS) as ToolOutcomeField[]) {
    if (fieldPermission(f, phase) !== "no") continue
    const r: FieldReader = STAGE_FIELD_READERS[f]
    if (!sameValue(r.read(parsed), r.read(merged))) return true
  }
  for (const k of STAGE_KEYS)
    if (Object.hasOwn(from, k) && sameValue(parsed[k], merged[k])) merged[k] = from[k]
  return false
}

/** An accepted stage result and the rule 4 and rule 5 drops of the stage call. */
interface Accepted {
  stage: ToolResultStage
  /** The kinds of the annotations that core dropped (rule 4). */
  dropped: Set<string>
  /** The kinds of the annotations that core dropped (rule 5), with the cause. */
  failed: RenderFailed
}

/**
 * The count cap per outcome (F13, lead decision F17): the plugin annotations
 * of the merged outcome, all plugins together. The owner rule requires that
 * the result keeps each input annotation of another owner (each core
 * annotation is one of them), so the plugin annotations of the merged
 * outcome are the result annotations minus the `core` input annotations of
 * core (see `isCoreOwned`). `core` comes from the runner's pre-call copy. O(1).
 */
function countCap(copy: Record<string, unknown>, core: number): SizeFail | undefined {
  const a = copy.annotations
  if (!Array.isArray(a)) return undefined
  const n = a.length - core
  const cap = PLUGIN_ANNOTATION_CAPS.perOutcome
  return n > cap ? { reason: "size", count: n, cap } : undefined
}

/** The runner's pre-call facts of the stage input (see `runStage`). */
interface PreCall {
  /** The input annotations that the stage plugin does not own. */
  others: readonly ToolAnnotation[]
  /** The input annotations that the stage plugin owns (rule 5 keep check). */
  own: readonly ToolAnnotation[]
  /** The number of input annotations of core (owner `"core"` or a core kind). */
  core: number
}

/**
 * Accept the raw result of a stage, or give a fail reason. Core reads no
 * property of `out` before the clone: `typeof` runs no Proxy trap. Then core
 * clones `out` one time (getters and Proxy traps run only in this call),
 * checks the annotation count cap per outcome (see `countCap`) and the attr
 * count cap per annotation (see `attrCountCap`), merges the
 * allow-listed keys of the copy over `input` (see {@link mergeOver}),
 * checks the D4 field table (see
 * `breaksReadOnly`), checks the byte caps (see `capCheck`),
 * applies the owner rule (see `applyOwnerRule`), checks the byte caps again
 * on the rendered text (rule 5) and freezes the merged value. `pre.others` is the runner's pre-call list of the input annotations
 * that the stage plugin does not own, and `pre.core` the pre-call count of
 * the input annotations of core (see `isCoreOwned`).
 * Reasons: `not-object` (null, a primitive or an array), `clone` (only the
 * `structuredClone` call fails), `size` (a cap of
 * {@link PLUGIN_ANNOTATION_CAPS}), `shape` (a present allowed key with the
 * wrong runtime type, a bad plugin annotation `join`, attr key or number,
 * or an error after the clone), `field-readonly` (a change to a `"no"` cell
 * or a context key), `owner` (owner rule 1, 2 or 3).
 * On each reason core drops the whole result. Never throws.
 */
function acceptResult(
  out: unknown,
  input: ToolResultStage,
  pre: PreCall,
  phase: ToolResultPhase,
  pluginId: string,
  registry: KindLookup,
  sideband: TextRenderer | undefined,
): Accepted | StageFailure {
  if (out === null || typeof out !== "object") return "not-object"
  let copy: unknown
  try {
    copy = structuredClone(out)
  } catch {
    return "clone"
  }
  try {
    if (!isRecord(copy)) return "not-object"
    const counted = countCap(copy, pre.core)
    if (counted !== undefined) return counted
    const attrCounted = attrCountCap(copy)
    if (attrCounted !== undefined) return attrCounted
    const merged = mergeOver(input, copy)
    if (merged === "shape") return "shape"
    if (breaksReadOnly(input, merged, phase)) return "field-readonly"
    const after = merged.annotations as Record<string, unknown>[]
    const sized = capCheck(after, true)
    if (sized !== undefined) return sized
    const owned = applyOwnerRule(pre, after, pluginId, registry, sideband)
    if (typeof owned === "string") return owned
    // Rule 5: the caps count the rendered text. After rule 5 the text of a
    // plugin annotation of a registered kind was rendered by core and holds the body.
    const resized = capCheck(owned.annotations as unknown as Record<string, unknown>[], false)
    if (resized !== undefined) return resized
    merged.annotations = owned.annotations
    return {
      stage: deepFreeze(merged) as unknown as ToolResultStage,
      dropped: owned.dropped,
      failed: owned.failed,
    }
  } catch {
    // The clone is plain data, so this is not expected. The value is bad
    // after the clone: label it `shape`, not `clone`.
    return "shape"
  }
}

/**
 * Run one stage on a frozen input. Returns the frozen merged next stage and
 * the rule 4 drops (see {@link acceptResult}), or a fail reason. Core copies
 * and freezes each result, so no stage shares a mutable reference with the
 * caller or another stage (SPEC D1 item 7).
 *
 * Before the call, core takes its own list of the input annotations that
 * the stage plugin does not own (see `notOwnedBy`) and the count of the
 * input annotations of core (for `countCap`). The owner rule reads
 * only this list, never an `owner` of the stage result (review F10).
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
  registry: KindLookup,
  sideband: TextRenderer | undefined,
): Promise<Accepted | StageFailure> {
  const others = input.annotations.filter((a) => notOwnedBy(a, s.pluginId))
  const own = input.annotations.filter((a) => !notOwnedBy(a, s.pluginId))
  const core = input.annotations.filter(isCoreOwned).length
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
  return acceptResult(out, input, { others, own, core }, phase, s.pluginId, registry, sideband)
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

/**
 * Emit one `stage-failed` warning: `{pluginId, phase, reason}`, plus
 * `count` or `bytes` and `cap` for reason `size`. A throw from the handle is
 * ignored.
 */
function warnFailed(
  opts: RunPhaseOptions,
  pluginId: string,
  phase: ToolResultPhase,
  failure: StageFailure,
): void {
  const data = typeof failure === "string" ? { reason: failure } : failure
  try {
    opts.diagnostics?.warn(STAGE_FAILED, "", { pluginId, phase, ...data })
  } catch {
    // A diagnostics failure must not stop the chain.
  }
}

/**
 * Most kinds that one drop set remembers for one plugin (review W1). At the
 * cap, core emits one overflow diagnostic for the plugin, then stops to
 * remember and to warn for that plugin in that drop set.
 */
export const DROPPED_KINDS_CAP = 64

/** Most new kinds in one `sideband-dropped` diagnostic. */
const DROPPED_KINDS_SHOWN = 8

/**
 * The rule 4 drop sets, one for each `entries` array (one chain load).
 * The key is the `entries` array object (identity), not its contents. This
 * works because the glue passes the same array for each call of one load.
 * A new array for each call gives a new, empty set each time.
 */
const DROPS_PER_LOAD = new WeakMap<readonly ToolResultChainEntry[], Set<string>>()

/**
 * For each drop set: for each plugin id, the number of remembered kinds, or
 * `"overflow"` after the overflow diagnostic.
 */
const DROP_COUNTS = new WeakMap<Set<string>, Map<string, number | "overflow">>()

/** The rule 5 drop sets, one for each `entries` array (see {@link DROPS_PER_LOAD}). */
const RENDER_DROPS = new WeakMap<readonly ToolResultChainEntry[], Set<string>>()

/** The rule 4 drop set of `opts`, else the set of `entries` in `per`. */
function dropSet(
  entries: readonly ToolResultChainEntry[],
  opts: RunPhaseOptions,
  per = DROPS_PER_LOAD,
): Set<string> {
  if (per === DROPS_PER_LOAD && opts.droppedKinds !== undefined) return opts.droppedKinds
  let set = per.get(entries)
  if (set === undefined) {
    set = new Set()
    per.set(entries, set)
  }
  return set
}

/**
 * Emit at most one `sideband-dropped` warning for one stage call:
 * `{pluginId, phase, tool, count, kinds}`. `count` is the number of kinds
 * that core dropped in this call. `kinds` holds the first
 * {@link DROPPED_KINDS_SHOWN} kinds that have no warning yet in `seen`, as
 * one JSON array string (diagnostic data is flat).
 * With no new kind, no warning. `seen` keeps at most
 * {@link DROPPED_KINDS_CAP} kinds per plugin. When a new kind finds the
 * plugin at the cap, the warning gets `overflow: true` (one time per plugin
 * and drop set), and core stops to remember and to warn for that plugin.
 * A throw from the handle is ignored. With `fail` (rule 5) the source is
 * {@link SIDEBAND_RENDER_FAILED} and the data also has `cause`: the fixed
 * cause of the first listed kind. The data has no message text.
 */
function warnDropped(
  opts: RunPhaseOptions,
  seen: Set<string>,
  s: EntrySnapshot,
  phase: ToolResultPhase,
  tool: string,
  dropped: ReadonlySet<string>,
  fail?: RenderFailed,
): void {
  let counts = DROP_COUNTS.get(seen)
  if (counts === undefined) {
    counts = new Map()
    DROP_COUNTS.set(seen, counts)
  }
  let n = counts.get(s.pluginId) ?? 0
  if (n === "overflow") return
  const kinds: string[] = []
  let overflow = false
  let cause: RenderCause | undefined
  for (const kind of dropped) {
    const key = `${s.pluginId}\u0000${kind}`
    if (seen.has(key)) continue
    cause ??= fail?.get(kind)
    if (n >= DROPPED_KINDS_CAP) {
      overflow = true
      break
    }
    seen.add(key)
    n++
    if (kinds.length < DROPPED_KINDS_SHOWN) kinds.push(kind)
  }
  counts.set(s.pluginId, overflow ? "overflow" : n)
  if (kinds.length === 0 && !overflow) return
  const data = {
    pluginId: s.pluginId,
    phase,
    tool,
    count: dropped.size,
    kinds: JSON.stringify(kinds),
  }
  try {
    const src = fail ? SIDEBAND_RENDER_FAILED : SIDEBAND_DROPPED
    opts.diagnostics?.warn(src, "", {
      ...data,
      ...(fail && { cause }),
      ...(overflow && { overflow }),
    })
  } catch {
    // A diagnostics failure must not stop the chain.
  }
}

const NO_KINDS: KindLookup = { kind: () => undefined }

/**
 * Run the stages of one phase in order. Fail open: each stage runs in its own
 * try/catch with a time limit ({@link clampStageTimeout} of
 * `decl.timeoutMs`, default {@link STAGE_TIMEOUT_MS}) and the turn abort. A
 * turn signal that is already aborted does not skip a stage. On a throw, a
 * timeout, an abort during the stage or a bad result, core keeps the input of
 * that stage, emits one `tool-result-chain.stage-failed` warning (plugin id,
 * phase, reason) and runs the next stage. A stage whose plugin id is
 * reserved (`"core"` with any case and spaces, or empty, see
 * {@link isReservedPluginId}) or does not obey the name rule of the sideband
 * registry (for example `"core\u200b"`) never runs: reason `owner` (review
 * F10). Each
 * stage gets a deep-frozen `structuredClone` of its input. When the input
 * cannot be cloned (a Proxy, a getter that throws), no stage runs, core
 * returns the input as given and emits one warning per stage with reason
 * `clone`. Core clones each result one time, before it reads a property,
 * then merges it over the input: a missing key keeps the input value, a
 * present key replaces it, and an explicit `undefined` clears an optional
 * field. Only the keys of {@link ToolResultStage} count. Core ignores each
 * other key with no diagnostic. Reasons that drop the whole result: `clone`
 * (the result cannot be cloned: a function value, a Proxy, a getter that
 * throws), `not-object` (null, a primitive or an array), `size` (a cap of
 * {@link PLUGIN_ANNOTATION_CAPS}; the warning also has `count` or `bytes`
 * and `cap`), `shape` (a present key with the wrong runtime type, a plugin
 * annotation `join` that is not `"\n\n"`, `"\n"` or `""`, a bad attr key, a
 * number attr that is not finite), `field-readonly` (a change to `tool`,
 * `toolUseId`, `input` or to a field whose cell in
 * `TOOL_OUTCOME_FIELD_TABLE` is `"no"` for the phase), `owner` (D4 owner
 * rule 1, 2 or 3, a reserved plugin id or a plugin id that is not a valid
 * registry name), `throw`, `timeout` and
 * `aborted`. A new stage annotation of a kind that is not registered with
 * placement `"tool-result"` is dropped alone (rule 4): core keeps the rest
 * of the result and emits at most one `tool-result-chain.sideband-dropped`
 * warning per stage call, only for kinds with no warning yet in the drop
 * set (see `RunPhaseOptions.droppedKinds` and {@link DROPPED_KINDS_CAP}).
 * For a new annotation of a registered kind core computes `text` with
 * `RunPhaseOptions.sideband` and replaces the plugin text (rule 5). A failure
 * drops that one annotation, with at most one
 * {@link SIDEBAND_RENDER_FAILED} warning per stage call, under the same
 * limits and with its own drop set.
 * Never throws on a bad entry or a bad stage result.
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
  const registry = opts.sidebandRegistry ?? NO_KINDS
  for (const s of phaseStages(entries, phase)) {
    if (badPluginId(s.pluginId)) {
      warnFailed(opts, s.pluginId, phase, "owner")
      continue
    }
    input ??= frozenCopy(current)
    let r: Accepted | StageFailure
    try {
      r =
        input === undefined
          ? "clone"
          : await runStage(s, phase, input, opts.signal, registry, opts.sideband)
    } catch {
      r = "throw"
    }
    if (typeof r === "string" || !("stage" in r)) {
      warnFailed(opts, s.pluginId, phase, r)
      continue
    }
    const tool = r.stage.tool
    if (r.dropped.size > 0) warnDropped(opts, dropSet(entries, opts), s, phase, tool, r.dropped)
    if (r.failed.size > 0) {
      const seen = dropSet(entries, opts, RENDER_DROPS)
      warnDropped(opts, seen, s, phase, tool, new Set(r.failed.keys()), r.failed)
    }
    current = input = r.stage
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
