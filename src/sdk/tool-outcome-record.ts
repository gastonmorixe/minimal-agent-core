/**
 * Convert a `ToolOutcome` to its persisted record form, and check a stored
 * record form (SPEC v6.1 D8).
 *
 * - {@link toPersistedToolOutcome}: the live side. It uses the one join of
 *   SPEC D6 ({@link finalizeOutcome}) and compares its text with the final
 *   model text. When they differ it gives no record (fail safe: no outcome is
 *   better than wrong spans).
 * - {@link validatePersistedToolOutcome}: the restore side. A shape check
 *   against the restored text, the E14 caps ({@link checkPluginAnnotationCaps}),
 *   the core span cap and the data cap. It never throws.
 * - {@link attachPersistedOutcome}: converts one time, sets `block.outcome`
 *   and gives the record, so that the caller passes the SAME record to
 *   `SessionStore.appendToolResult` (D8 rules 7 and 8: live == restored).
 *
 * This module is in `src/sdk/` (not `src/session/`): `src/sdk/tool-calls.ts`
 * is reached from `agent-core.ts`, and `sdk-transitive.test.ts` freezes the
 * edges from `agent-core.ts` into `src/session`.
 *
 * Pure functions. No I/O, no clock. Diagnostics go to the optional `report`
 * callback.
 *
 * @module sdk/tool-outcome-record
 */

import {
  PERSISTED_TOOL_OUTCOME_VERSION,
  type PersistedToolOutcome,
  type PersistedToolOutcomeSpan,
  TOOL_OUTCOME_DATA_INLINE_MAX_BYTES,
  type ToolOutcome,
} from "../../plugin-api/src/types/tool-outcome-record.ts"
import { finalizeOutcome } from "../loops/tool-outcome-finalize.ts"

/** Diagnostic id: `data` (or `schema`) was dropped from the record (SPEC D-F). */
export const TOOL_OUTCOME_DATA_DROPPED = "tool-outcome.data-dropped"

/** Diagnostic id: no record was made for this outcome. */
export const TOOL_OUTCOME_RECORD_SKIPPED = "tool-outcome.record-skipped"

/**
 * Diagnostic id: core dropped a record, or a part of it. Data:
 * `{ tool?, reason: "over-cap", cap }` (a cap of {@link checkPluginAnnotationCaps}
 * or `"core-span-text"`), or `{ tool?, reason: "core-kind-forged" }` (the
 * converter dropped the spans of plugin annotations with a core kind), or
 * `{ tool?, reason: "content-changed" }` (`runToolCalls`: the record of core's
 * own executor does not fit the result content that it reads).
 */
export const TOOL_OUTCOME_RECORD_DROPPED = "tool-outcome.record-dropped"

/**
 * Caps on the plugin-owned spans of one record (SPEC erratum E14). Core-owned
 * spans have no plugin cap (see {@link CORE_SPAN_TEXT_MAX_BYTES}). All caps
 * apply to ONE OUTCOME, all plugins together: `count` has the same scope as
 * `totalBytes`. The write path and restore use the same check
 * ({@link checkPluginAnnotationCaps}). Byte values are UTF-8.
 */
export const PLUGIN_ANNOTATION_CAPS = {
  /** Plugin-owned spans in one outcome. */
  count: 8,
  /** Text of one plugin-owned span. */
  textBytes: 2048,
  /** Attribute keys of one plugin-owned span. */
  attrKeys: 16,
  /** One string attribute value. */
  attrValueBytes: 256,
  /** Text, attribute keys and string values of all plugin-owned spans. */
  totalBytes: 8192,
} as const

/** The cap names of {@link checkPluginAnnotationCaps}. */
export type PluginAnnotationCap =
  | "count"
  | "text-bytes"
  | "attr-keys"
  | "attr-value-bytes"
  | "total-bytes"

/**
 * Maximum UTF-8 bytes of the text of ONE core-owned span
 * (`finalText.slice(start, end)`). Above it, core drops the outcome with
 * `cap: "core-span-text"`. The real core texts are far below it (see the
 * test "the real core annotation texts are below the core span cap").
 */
export const CORE_SPAN_TEXT_MAX_BYTES = 4096

/**
 * The annotation kinds that core owns (`CoreAnnotationKind`, D4 owner rule
 * 3). A record holds no owner. No stage can add a core kind, the sideband
 * registry rejects a core kind for a plugin owner (rule `"core-kind"`), and
 * the converter drops a plugin annotation with a core kind. So the kind
 * tells the owner: a core kind is core-owned, each other kind is
 * plugin-owned. `tool-outcome-record.test.ts` compares this list with the type.
 */
export const CORE_OWNED_KINDS: ReadonlySet<string> = new Set([
  "mode-active",
  "policy",
  "raw-output",
  "output-preview",
  "output-truncated",
  "output-streak",
  "diagnostics",
])

/**
 * Receives a diagnostic of the converter or of the validator. `id` is
 * {@link TOOL_OUTCOME_DATA_DROPPED}, {@link TOOL_OUTCOME_RECORD_SKIPPED} or
 * {@link TOOL_OUTCOME_RECORD_DROPPED}.
 */
export type ToolOutcomeRecordReport = (id: string, data: Record<string, unknown>) => void

/** Content of a tool result block, as the legacy and the canonical forms hold it. */
export type ToolResultTextSource = string | ReadonlyArray<{ readonly type: string }>

/**
 * The text that the record offsets refer to (SPEC D8 rule 1): `content` when
 * it is a string, else the text of the first text block, else `""`.
 *
 * Safe for bad stored data (restore reads JSONL that can be torn or edited):
 * a `content` that is not a string and not an array (for example `null` or a
 * number) gives `""`. An item that is not a non-null object is skipped. A
 * getter that throws gives `""`. This function never throws.
 */
export function outcomeTextOf(content: unknown): string {
  try {
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return ""
    for (const block of content as unknown[]) {
      if (typeof block !== "object" || block === null) continue
      if ((block as { type?: unknown }).type === "text") {
        const text = (block as { text?: unknown }).text
        return typeof text === "string" ? text : ""
      }
    }
    return ""
  } catch {
    return ""
  }
}

/** One encoder for all byte counts (the cap loops call it often). */
const utf8Encoder = new TextEncoder()

/** UTF-8 byte length of a string. */
function utf8Bytes(text: string): number {
  return utf8Encoder.encode(text).length
}

/**
 * Give a JSON copy of `value` when its JSON form is at most `max` UTF-8 bytes.
 * Else report one {@link TOOL_OUTCOME_DATA_DROPPED} and give `undefined`.
 *
 * Data shape of the diagnostic: `{ tool?, field, bytes, reason }`.
 * `reason` is `"over-cap"` (then `bytes` is the measured length) or
 * `"not-serializable"` (then `bytes` is `-1`): a BigInt, a cycle, a throwing
 * `toJSON` or getter, or a value with no JSON form (a function, a symbol).
 *
 * The copy (`JSON.parse` of the JSON form) makes the live record equal to the
 * restored record: both hold the JSON value, not the original object.
 */
function jsonCopyWithinCap(
  value: unknown,
  field: "data" | "schema",
  tool: string | undefined,
  report: ToolOutcomeRecordReport | undefined,
): { ok: true; value: unknown } | { ok: false } {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch {
    json = undefined
  }
  if (json === undefined) {
    report?.(TOOL_OUTCOME_DATA_DROPPED, {
      ...(tool === undefined ? {} : { tool }),
      field,
      bytes: -1,
      reason: "not-serializable",
    })
    return { ok: false }
  }
  const bytes = utf8Bytes(json)
  if (bytes > TOOL_OUTCOME_DATA_INLINE_MAX_BYTES) {
    report?.(TOOL_OUTCOME_DATA_DROPPED, {
      ...(tool === undefined ? {} : { tool }),
      field,
      bytes,
      reason: "over-cap",
    })
    return { ok: false }
  }
  return { ok: true, value: JSON.parse(json) as unknown }
}

/** True for an attribute value that JSON keeps as is. */
function isAttrValue(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
}

/** True for a non-null object that is not an array. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Copy attributes to a new object with own data properties only. Gives
 * `undefined` when one value is not a string, a boolean or a finite number.
 */
function copyAttrs(attrs: unknown): PersistedToolOutcomeSpan["attrs"] | undefined {
  if (!isPlainRecord(attrs)) return undefined
  const entries: [string, string | number | boolean][] = []
  for (const key of Object.keys(attrs)) {
    const value = attrs[key]
    if (!isAttrValue(value)) return undefined
    entries.push([key, value])
  }
  // Object.fromEntries defines own properties: a "__proto__" key stays a key.
  return Object.fromEntries(entries)
}

/**
 * Make the record form of `outcome` for the final model text (SPEC D8).
 *
 * Rules:
 * - The spans come from {@link finalizeOutcome}, the one D6 join. This
 *   function does not copy the join.
 * - When `finalizeOutcome(outcome).text !== finalText`, it gives `undefined`
 *   (no record) and reports {@link TOOL_OUTCOME_RECORD_SKIPPED}
 *   `{ tool?, reason: "text-mismatch" }`.
 * - An annotation with a bad `attrs` value, or an outcome that throws on read,
 *   gives `undefined` and reports `{ tool?, reason: "invalid-outcome" }`.
 * - An annotation with a core kind ({@link CORE_OWNED_KINDS}) and an owner
 *   that is not `"core"` is a forgery: its span is dropped, the other spans
 *   and the rest of the record stay, and ONE {@link TOOL_OUTCOME_RECORD_DROPPED}
 *   `{ tool?, reason: "core-kind-forged" }` is reported for the outcome. The
 *   offsets of the other spans count the forged text, because that text is
 *   in the model text.
 * - `body.data` above {@link TOOL_OUTCOME_DATA_INLINE_MAX_BYTES} UTF-8 bytes
 *   of JSON, or not serializable: `data` is dropped, the rest of the record
 *   stays, and one {@link TOOL_OUTCOME_DATA_DROPPED} is reported. `schema`
 *   gets the same rule. No blob spill in M2 (no `dataRef`).
 * - The record never holds the text, `hostHints`, `truncInfo`, `media`,
 *   `rawForBlob` or `blob` (D8 rules 2 and 3).
 *
 * Never throws.
 *
 * @param outcome - The final `ToolOutcome` (after the stamp phase).
 * @param finalText - The final model text (see {@link outcomeTextOf}).
 * @param report - Optional diagnostic sink.
 * @param tool - Optional tool name for the diagnostic data.
 */
export function toPersistedToolOutcome(
  outcome: ToolOutcome,
  finalText: string,
  report?: ToolOutcomeRecordReport,
  tool?: string,
): PersistedToolOutcome | undefined {
  const skip = (reason: string): undefined => {
    report?.(TOOL_OUTCOME_RECORD_SKIPPED, { ...(tool === undefined ? {} : { tool }), reason })
    return undefined
  }
  let annotations: PersistedToolOutcomeSpan[]
  let bodyEnd: number
  let body: ToolOutcome["body"]
  let forged = false
  try {
    // The join runs on the FULL outcome: the text of a forged annotation is
    // in the model text, so the offsets of the other spans must count it.
    const finalized = finalizeOutcome(outcome)
    if (finalized.text !== finalText) return skip("text-mismatch")
    bodyEnd = finalized.bodyEnd
    annotations = []
    const source = outcome.annotations
    for (const [i, span] of finalized.spans.entries()) {
      if (typeof span.kind !== "string") return skip("invalid-outcome")
      // D4 owner rule 3: a core kind with an owner that is not "core" is a
      // forgery. Drop its span only. Its text stays in the model text.
      if (CORE_OWNED_KINDS.has(span.kind) && source[i]?.owner !== "core") {
        forged = true
        continue
      }
      if (span.attrs === undefined) {
        annotations.push({ kind: span.kind, start: span.start, end: span.end })
        continue
      }
      const attrs = copyAttrs(span.attrs)
      if (attrs === undefined) return skip("invalid-outcome")
      annotations.push({ kind: span.kind, attrs, start: span.start, end: span.end })
    }
    body = outcome.body
  } catch {
    return skip("invalid-outcome")
  }
  if (forged) {
    report?.(TOOL_OUTCOME_RECORD_DROPPED, {
      ...(tool === undefined ? {} : { tool }),
      reason: "core-kind-forged",
    })
  }

  const record: PersistedToolOutcome = { v: PERSISTED_TOOL_OUTCOME_VERSION, bodyEnd, annotations }
  let hasData = false
  let data: unknown
  let schema: unknown
  try {
    // A `data` key with the value `undefined` is the same as no data.
    if (isPlainRecord(body) && "data" in body) {
      data = (body as { data: unknown }).data
      hasData = data !== undefined
      if (hasData) schema = (body as { schema?: unknown }).schema
    }
  } catch {
    hasData = false
    report?.(TOOL_OUTCOME_DATA_DROPPED, {
      ...(tool === undefined ? {} : { tool }),
      field: "data",
      bytes: -1,
      reason: "not-serializable",
    })
  }
  if (hasData) {
    const copied = jsonCopyWithinCap(data, "data", tool, report)
    if (copied.ok) record.data = copied.value
    if (schema !== undefined) {
      const schemaCopy = jsonCopyWithinCap(schema, "schema", tool, report)
      if (schemaCopy.ok && isPlainRecord(schemaCopy.value)) record.schema = schemaCopy.value
    }
  }
  return record
}

/** True for an integer `n` with `min <= n <= max`. */
function isOffset(n: unknown, min: number, max: number): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max
}

/**
 * True when UTF-16 offset `i` falls between the high and the low surrogate
 * of one pair in `text` (the high surrogate at `i - 1`, the low at `i`).
 */
function splitsSurrogatePair(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false
  const high = text.charCodeAt(i - 1)
  const low = text.charCodeAt(i)
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff
}

/** Check one stored span. Gives a clean copy, or `undefined`. */
function validateSpan(
  value: unknown,
  minStart: number,
  finalText: string,
): PersistedToolOutcomeSpan | undefined {
  if (!isPlainRecord(value)) return undefined
  const { kind, start, end, attrs } = value
  if (typeof kind !== "string") return undefined
  const textLength = finalText.length
  if (!isOffset(start, minStart, textLength)) return undefined
  if (!isOffset(end, start, textLength)) return undefined
  if (splitsSurrogatePair(finalText, start) || splitsSurrogatePair(finalText, end)) {
    return undefined
  }
  if (attrs === undefined) return { kind, start, end }
  const copied = copyAttrs(attrs)
  if (copied === undefined) return undefined
  return { kind, attrs: copied, start, end }
}

/** Check a stored `dataRef`. Gives a clean copy, or `undefined`. */
function validateDataRef(value: unknown): PersistedToolOutcome["dataRef"] | undefined {
  if (!isPlainRecord(value)) return undefined
  const { path, bytes, sha256 } = value
  if (typeof path !== "string" || typeof sha256 !== "string") return undefined
  if (!isOffset(bytes, 0, Number.MAX_SAFE_INTEGER)) return undefined
  return { path, bytes, sha256 }
}

/** Result of {@link checkPluginAnnotationCaps}. */
export type PluginAnnotationCapCheck = { ok: true } | { ok: false; cap: PluginAnnotationCap }

/**
 * The one E14 cap check of a record (SPEC erratum E14), for the write path
 * ({@link attachPersistedOutcome}) and for restore
 * ({@link validatePersistedToolOutcome}). The numbers are
 * {@link PLUGIN_ANNOTATION_CAPS}: 8 spans, 2048 text bytes, 16 attribute
 * keys, 256 bytes for one string value, 8192 bytes in total. The live runner
 * uses the same numbers.
 *
 * Only the plugin-owned spans count (kind not in {@link CORE_OWNED_KINDS}).
 * The scope is ONE OUTCOME, all plugins together. Checks in this order:
 * `count`, then for each span `text-bytes`, `attr-keys` and
 * `attr-value-bytes`, then `total-bytes` (text, attribute keys and string
 * values). The text of a span is `finalText.slice(start, end)`.
 *
 * @param record - The record (or a value with its `annotations`).
 * @param finalText - The model text that the offsets refer to.
 * @returns `{ ok: true }`, or `{ ok: false, cap }` with the first cap passed over.
 */
export function checkPluginAnnotationCaps(
  record: Pick<PersistedToolOutcome, "annotations">,
  finalText: string,
): PluginAnnotationCapCheck {
  const caps = PLUGIN_ANNOTATION_CAPS
  const over = (cap: PluginAnnotationCap): PluginAnnotationCapCheck => ({ ok: false, cap })
  const plugin = record.annotations.filter((a) => !CORE_OWNED_KINDS.has(a.kind))
  if (plugin.length > caps.count) return over("count")
  let total = 0
  for (const span of plugin) {
    const textBytes = utf8Bytes(finalText.slice(span.start, span.end))
    if (textBytes > caps.textBytes) return over("text-bytes")
    total += textBytes
    const keys = span.attrs === undefined ? [] : Object.keys(span.attrs)
    if (keys.length > caps.attrKeys) return over("attr-keys")
    for (const key of keys) {
      total += utf8Bytes(key)
      const value = span.attrs?.[key]
      if (typeof value !== "string") continue
      const valueBytes = utf8Bytes(value)
      if (valueBytes > caps.attrValueBytes) return over("attr-value-bytes")
      total += valueBytes
    }
  }
  return total > caps.totalBytes ? over("total-bytes") : { ok: true }
}

/**
 * True when the text of each core-owned span (kind in
 * {@link CORE_OWNED_KINDS}) is at most {@link CORE_SPAN_TEXT_MAX_BYTES}
 * UTF-8 bytes.
 */
function coreSpansWithinCap(
  annotations: readonly PersistedToolOutcomeSpan[],
  finalText: string,
): boolean {
  for (const span of annotations) {
    if (!CORE_OWNED_KINDS.has(span.kind)) continue
    if (utf8Bytes(finalText.slice(span.start, span.end)) > CORE_SPAN_TEXT_MAX_BYTES) return false
  }
  return true
}

/**
 * The first cap of a record: {@link checkPluginAnnotationCaps}, then the core
 * span cap (`"core-span-text"`). `undefined` when the record is within all caps.
 */
function overRecordCap(
  record: Pick<PersistedToolOutcome, "annotations">,
  finalText: string,
): PluginAnnotationCap | "core-span-text" | undefined {
  const plugin = checkPluginAnnotationCaps(record, finalText)
  if (!plugin.ok) return plugin.cap
  return coreSpansWithinCap(record.annotations, finalText) ? undefined : "core-span-text"
}

/** Report one {@link TOOL_OUTCOME_RECORD_DROPPED} `{ tool?, reason: "over-cap", cap }`. */
function reportOverCap(
  report: ToolOutcomeRecordReport | undefined,
  tool: string | undefined,
  cap: string,
): void {
  report?.(TOOL_OUTCOME_RECORD_DROPPED, {
    ...(tool === undefined ? {} : { tool }),
    reason: "over-cap",
    cap,
  })
}

/**
 * Check a stored `outcome` value against the restored text (SPEC D8 rules 5,
 * 6 and 8). Gives a clean copy with the known keys only, or `undefined` when
 * one check fails. Never throws.
 *
 * Checks: a non-null object; `v === 1`; `bodyEnd` an integer in
 * `0..finalText.length`; `annotations` an array; each span has a string
 * `kind` and integer offsets with `bodyEnd <= start <= end <= length`, and
 * `start` is not before the `end` of the span before; `attrs`, when present,
 * an object of string, boolean or finite number values; `schema`, when
 * present, an object; `dataRef`, when present, `{ path, bytes, sha256 }`.
 * The result holds copies: `data` and `schema` are JSON copies, so the result
 * shares no object with `value`.
 *
 * A span `start` or `end` that falls inside a UTF-16 surrogate pair of
 * `finalText` is a shape error.
 *
 * `data` can be any JSON value. Above {@link TOOL_OUTCOME_DATA_INLINE_MAX_BYTES}
 * UTF-8 bytes of JSON, or not serializable, `data` is dropped, the rest of the
 * record stays, and one {@link TOOL_OUTCOME_DATA_DROPPED} is reported (the
 * same rule as the write path). `schema` gets the same rule (field `"schema"`). This function does no I/O: a `dataRef` whose target file is
 * missing is valid here, and a reader treats it as "no data".
 *
 * A shape error gives `undefined` with no diagnostic. A valid record that
 * passes over a cap ({@link checkPluginAnnotationCaps}, or
 * {@link CORE_SPAN_TEXT_MAX_BYTES} for a core-owned span) also gives
 * `undefined`, and reports one {@link TOOL_OUTCOME_RECORD_DROPPED}
 * `{ tool?, reason: "over-cap", cap }`.
 *
 * @param value - The stored `outcome` value.
 * @param finalText - The restored model text (see {@link outcomeTextOf}).
 * @param report - Optional diagnostic sink.
 * @param tool - Optional tool name for the diagnostic data.
 */
export function validatePersistedToolOutcome(
  value: unknown,
  finalText: string,
  report?: ToolOutcomeRecordReport,
  tool?: string,
): PersistedToolOutcome | undefined {
  try {
    if (!isPlainRecord(value)) return undefined
    if (value.v !== PERSISTED_TOOL_OUTCOME_VERSION) return undefined
    const length = typeof finalText === "string" ? finalText.length : -1
    if (length < 0) return undefined
    const bodyEnd = value.bodyEnd
    if (!isOffset(bodyEnd, 0, length)) return undefined
    if (!Array.isArray(value.annotations)) return undefined
    const annotations: PersistedToolOutcomeSpan[] = []
    let minStart = bodyEnd
    for (const raw of value.annotations as unknown[]) {
      const span = validateSpan(raw, minStart, finalText)
      if (span === undefined) return undefined
      annotations.push(span)
      minStart = span.end
    }
    const out: PersistedToolOutcome = { v: PERSISTED_TOOL_OUTCOME_VERSION, bodyEnd, annotations }
    if ("dataRef" in value && value.dataRef !== undefined) {
      const dataRef = validateDataRef(value.dataRef)
      if (dataRef === undefined) return undefined
      out.dataRef = dataRef
    }
    const hasSchema = "schema" in value && value.schema !== undefined
    if (hasSchema && !isPlainRecord(value.schema)) return undefined
    const cap = overRecordCap(out, finalText)
    if (cap !== undefined) {
      reportOverCap(report, tool, cap)
      return undefined
    }
    if ("data" in value && value.data !== undefined) {
      const copied = jsonCopyWithinCap(value.data, "data", tool, report)
      if (copied.ok) out.data = copied.value
    }
    // `schema` gets the same rule as `data` (the write path rule): a JSON copy
    // (no shared object with the stored record), at most
    // TOOL_OUTCOME_DATA_INLINE_MAX_BYTES; else it is dropped with one
    // TOOL_OUTCOME_DATA_DROPPED `{ field: "schema" }`. The rest stays.
    if (hasSchema) {
      const copied = jsonCopyWithinCap(value.schema, "schema", tool, report)
      if (copied.ok && isPlainRecord(copied.value)) out.schema = copied.value
    }
    return out
  } catch {
    return undefined
  }
}

/** A block that can hold a persisted outcome (legacy or canonical `tool_result`). */
export interface OutcomeHolder {
  /** The final model content of the block. The record offsets refer to {@link outcomeTextOf} of it. */
  readonly content: ToolResultTextSource
  /** The persisted outcome, in record form. */
  outcome?: PersistedToolOutcome
}

/**
 * Convert `outcome` one time, set `block.outcome` and give the record (SPEC
 * D8 rules 7 and 8). The caller passes the returned record to
 * `SessionStore.appendToolResult` as its 4th argument, so the live block and
 * the stored record hold the same value.
 *
 * The final text comes from the block: `outcomeTextOf(block.content)`, the
 * same text that restore uses. So the caller cannot give a different text.
 *
 * When there is no record (no outcome, or {@link toPersistedToolOutcome}
 * gives `undefined`), the block gets no `outcome` key (an old key is
 * removed) and the function gives `undefined`.
 *
 * Defense: a record over a cap ({@link checkPluginAnnotationCaps}, or
 * {@link CORE_SPAN_TEXT_MAX_BYTES}) also gives no `outcome` key and
 * `undefined`, with ONE {@link TOOL_OUTCOME_RECORD_DROPPED}
 * `{ tool?, reason: "over-cap", cap }`. The live runner drops an over-cap
 * stage first.
 *
 * Last check: the restore check ({@link validatePersistedToolOutcome}) runs
 * on the record. A record that restore would drop (for example a span edge
 * inside a UTF-16 surrogate pair) is never written: no `outcome` key,
 * `undefined`, and one {@link TOOL_OUTCOME_RECORD_SKIPPED}
 * `{ tool?, reason: "restore-check" }`. The record on the block is the
 * output of that check, so the live block and the restored block are equal.
 *
 * The call is in `tool-round.ts` (Gabriel's file), and the leader adds it at
 * the integration merge.
 *
 * @example
 * ```ts
 * const rec = attachPersistedOutcome(resultBlock, toolOutcome, report, toolName)
 * store.appendToolResult(resultBlock, now, rawBlob, rec)
 * ```
 *
 * @param block - The live `tool_result` block (its `content` is final). Changed in place.
 * @param outcome - The final `ToolOutcome`, or `undefined`.
 * @param report - Optional diagnostic sink.
 * @param tool - Optional tool name for the diagnostic data.
 */
export function attachPersistedOutcome(
  block: OutcomeHolder,
  outcome: ToolOutcome | undefined,
  report?: ToolOutcomeRecordReport,
  tool?: string,
): PersistedToolOutcome | undefined {
  const finalText = outcomeTextOf(block.content)
  let record =
    outcome === undefined ? undefined : toPersistedToolOutcome(outcome, finalText, report, tool)
  if (record !== undefined) {
    const cap = overRecordCap(record, finalText)
    if (cap !== undefined) {
      reportOverCap(report, tool, cap)
      record = undefined
    }
  }
  if (record !== undefined) {
    // The caps passed above, so this check reports no over-cap and no data
    // drop (data and schema are already JSON copies within the cap).
    const checked = validatePersistedToolOutcome(record, finalText)
    if (checked === undefined) {
      report?.(TOOL_OUTCOME_RECORD_SKIPPED, {
        ...(tool === undefined ? {} : { tool }),
        reason: "restore-check",
      })
    }
    record = checked
  }
  if (record === undefined) delete block.outcome
  else block.outcome = record
  return record
}

/**
 * Core-internal channel for the persisted outcome of a tool result (SPEC
 * v6.1 D8 rule 8). The public `ToolExecResult` has no `outcome` field until
 * M3, so a host executor cannot set it. Core's own `ToolExecutorAdapter`
 * registers the record of the live block here, and `runToolCalls` reads it.
 * The map is module-private, and this module is not a public subpath: an
 * `outcome` key on a result object is never read.
 */
const internalOutcomes = new WeakMap<object, PersistedToolOutcome>()

/**
 * Register `outcome` for the result object `result` (core's own executor
 * only). With `undefined`, an old registration is removed. Gives `result`.
 */
export function withInternalOutcome<T extends object>(
  result: T,
  outcome: PersistedToolOutcome | undefined,
): T {
  if (outcome === undefined) internalOutcomes.delete(result)
  else internalOutcomes.set(result, outcome)
  return result
}

/**
 * The outcome that core's own executor registered for `result` with
 * {@link withInternalOutcome}, or `undefined`. An `outcome` key on the
 * object itself is ignored.
 */
export function internalOutcomeOf(result: object): PersistedToolOutcome | undefined {
  return internalOutcomes.get(result)
}

/**
 * Core-internal channel from `runToolCalls` to core's own session persistence
 * (`SessionStorePersistence`), keyed on the live `tool_result` block (SPEC
 * v6.1 D8 rule 8, review W2 M2). The public `SessionPersistence` port has no
 * outcome parameter, and the persistence does not trust an `outcome` key on
 * the block: other code (a synthetic result, a host) can also give it blocks.
 * Only `runToolCalls` registers here, after it checked the record against the
 * block content. The map is module-private, and this module is not a public
 * subpath.
 */
const blockOutcomes = new WeakMap<object, PersistedToolOutcome>()

/**
 * Register `outcome` for the live block `block` (`runToolCalls` only). With
 * `undefined`, an old registration is removed. Gives `block`.
 */
export function withBlockOutcome<T extends object>(
  block: T,
  outcome: PersistedToolOutcome | undefined,
): T {
  if (outcome === undefined) blockOutcomes.delete(block)
  else blockOutcomes.set(block, outcome)
  return block
}

/**
 * The outcome that `runToolCalls` registered for `block` with
 * {@link withBlockOutcome}, or `undefined`. An `outcome` key on the block
 * itself is ignored.
 */
export function blockOutcomeOf(block: object): PersistedToolOutcome | undefined {
  return blockOutcomes.get(block)
}
