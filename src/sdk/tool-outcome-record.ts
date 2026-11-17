/**
 * Convert a `ToolOutcome` to its persisted record form, and check a stored
 * record form (SPEC v6.1 D8).
 *
 * - {@link toPersistedToolOutcome}: the live side. It uses the one join of
 *   SPEC D6 ({@link finalizeOutcome}) and compares its text with the final
 *   model text. When they differ it gives no record (fail safe: no outcome is
 *   better than wrong spans).
 * - {@link validatePersistedToolOutcome}: the restore side. A shape check
 *   against the restored text, and the E14 caps on plugin-owned spans. It
 *   never throws.
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

/** Diagnostic id: restore dropped a stored record (SPEC erratum E14 caps). */
export const TOOL_OUTCOME_RECORD_DROPPED = "tool-outcome.record-dropped"

/**
 * Caps on the plugin-owned spans of one stored record (SPEC erratum E14).
 * Core-owned spans have no cap. The live runner applies `count` to each
 * stage result. A record does not keep the stage, so restore applies it to
 * the full outcome. Byte values are UTF-8.
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

/**
 * The annotation kinds that core owns (`CoreAnnotationKind`, D4 owner rule
 * 3). A record holds no owner. No stage can add a core kind, so the kind
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
 */
export function outcomeTextOf(content: ToolResultTextSource): string {
  if (typeof content === "string") return content
  for (const block of content) {
    if (block.type === "text") {
      const text = (block as { text?: unknown }).text
      return typeof text === "string" ? text : ""
    }
  }
  return ""
}

/** UTF-8 byte length of a string. */
function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length
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
  try {
    const finalized = finalizeOutcome(outcome)
    if (finalized.text !== finalText) return skip("text-mismatch")
    bodyEnd = finalized.bodyEnd
    annotations = []
    for (const span of finalized.spans) {
      if (typeof span.kind !== "string") return skip("invalid-outcome")
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

/** Check one stored span. Gives a clean copy, or `undefined`. */
function validateSpan(
  value: unknown,
  minStart: number,
  textLength: number,
): PersistedToolOutcomeSpan | undefined {
  if (!isPlainRecord(value)) return undefined
  const { kind, start, end, attrs } = value
  if (typeof kind !== "string") return undefined
  if (!isOffset(start, minStart, textLength)) return undefined
  if (!isOffset(end, start, textLength)) return undefined
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

/**
 * The first E14 cap that the plugin-owned spans pass over, or `undefined`.
 * Checks in this order: `count`, then for each span `text-bytes`,
 * `attr-keys` and `attr-value-bytes`, then `total-bytes`. The text of a span
 * is `finalText.slice(start, end)`. See {@link PLUGIN_ANNOTATION_CAPS}.
 */
export function overPluginAnnotationCap(
  annotations: readonly PersistedToolOutcomeSpan[],
  finalText: string,
): string | undefined {
  const caps = PLUGIN_ANNOTATION_CAPS
  const plugin = annotations.filter((a) => !CORE_OWNED_KINDS.has(a.kind))
  if (plugin.length > caps.count) return "count"
  let total = 0
  for (const span of plugin) {
    const textBytes = utf8Bytes(finalText.slice(span.start, span.end))
    if (textBytes > caps.textBytes) return "text-bytes"
    total += textBytes
    const keys = span.attrs === undefined ? [] : Object.keys(span.attrs)
    if (keys.length > caps.attrKeys) return "attr-keys"
    for (const key of keys) {
      total += utf8Bytes(key)
      const value = span.attrs?.[key]
      if (typeof value !== "string") continue
      const valueBytes = utf8Bytes(value)
      if (valueBytes > caps.attrValueBytes) return "attr-value-bytes"
      total += valueBytes
    }
  }
  return total > caps.totalBytes ? "total-bytes" : undefined
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
 *
 * `data` can be any JSON value. This function does no I/O: a `dataRef` whose
 * target file is missing is valid here, and a reader treats it as "no data".
 *
 * A shape error gives `undefined` with no diagnostic. A valid record whose
 * plugin-owned spans pass over a cap ({@link overPluginAnnotationCap}) also
 * gives `undefined`, and reports one {@link TOOL_OUTCOME_RECORD_DROPPED}
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
      const span = validateSpan(raw, minStart, length)
      if (span === undefined) return undefined
      annotations.push(span)
      minStart = span.end
    }
    const out: PersistedToolOutcome = { v: PERSISTED_TOOL_OUTCOME_VERSION, bodyEnd, annotations }
    if ("data" in value && value.data !== undefined) out.data = value.data
    if ("dataRef" in value && value.dataRef !== undefined) {
      const dataRef = validateDataRef(value.dataRef)
      if (dataRef === undefined) return undefined
      out.dataRef = dataRef
    }
    if ("schema" in value && value.schema !== undefined) {
      if (!isPlainRecord(value.schema)) return undefined
      out.schema = value.schema
    }
    const cap = overPluginAnnotationCap(annotations, finalText)
    if (cap !== undefined) {
      const data = { ...(tool === undefined ? {} : { tool }), reason: "over-cap", cap }
      report?.(TOOL_OUTCOME_RECORD_DROPPED, data)
      return undefined
    }
    return out
  } catch {
    return undefined
  }
}

/** A block that can hold a persisted outcome (legacy or canonical `tool_result`). */
export interface OutcomeHolder {
  /** The persisted outcome, in record form. */
  outcome?: PersistedToolOutcome
}

/**
 * Convert `outcome` one time, set `block.outcome` and give the record (SPEC
 * D8 rules 7 and 8). The caller passes the returned record to
 * `SessionStore.appendToolResult` as its 4th argument, so the live block and
 * the stored record hold the same value.
 *
 * When there is no record (no outcome, or {@link toPersistedToolOutcome}
 * gives `undefined`), the block gets no `outcome` key (an old key is
 * removed) and the function gives `undefined`.
 *
 * The call is in `tool-round.ts` (Gabriel's file), and the leader adds it at
 * the integration merge.
 *
 * @example
 * ```ts
 * const rec = attachPersistedOutcome(resultBlock, toolOutcome, finalText, report, toolName)
 * store.appendToolResult(resultBlock, now, rawBlob, rec)
 * ```
 *
 * @param block - The live `tool_result` block. Changed in place.
 * @param outcome - The final `ToolOutcome`, or `undefined`.
 * @param finalText - The final model text of the block (see {@link outcomeTextOf}).
 * @param report - Optional diagnostic sink.
 * @param tool - Optional tool name for the diagnostic data.
 */
export function attachPersistedOutcome(
  block: OutcomeHolder,
  outcome: ToolOutcome | undefined,
  finalText: string,
  report?: ToolOutcomeRecordReport,
  tool?: string,
): PersistedToolOutcome | undefined {
  const record =
    outcome === undefined ? undefined : toPersistedToolOutcome(outcome, finalText, report, tool)
  if (record === undefined) delete block.outcome
  else block.outcome = record
  return record
}
