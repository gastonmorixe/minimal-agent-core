/**
 * Read view of a stored tool outcome (SPEC v6.1 D8).
 *
 * A host that shows a stored `tool_result` (CLI live, CLI replay, Task split,
 * Cursor) needs one rule: "give me the body and the spans of this `outcome`
 * for this `content`, or tell me to use the fallback". This module is that
 * rule. It is a leaf: it imports nothing from `src/`.
 *
 * @module plugin-api/types/tool-outcome-view
 */

/** One annotation of an {@link OutcomeView}, with its text. */
export interface OutcomeViewAnnotation {
  /** Kind of the annotation, for example `"output-truncated"`. */
  readonly kind: string
  /** Attributes of the annotation, when it has them. */
  readonly attrs?: Record<string, string | number | boolean>
  /** UTF-16 offset of the first character of the annotation text. */
  readonly start: number
  /** UTF-16 offset after the last character of the annotation text. */
  readonly end: number
  /** The annotation text: `text.slice(start, end)`. */
  readonly text: string
}

/** A stored outcome, resolved against the text that its offsets refer to. */
export interface OutcomeView {
  /** The text that the offsets refer to (D8 rule 1). */
  text: string
  /** The body: `text.slice(0, bodyEnd)`. */
  body: string
  /** UTF-16 offset where the body ends. */
  bodyEnd: number
  /** The annotations, in append order, each with its text. */
  annotations: readonly OutcomeViewAnnotation[]
  /** Structured body data, when the record holds it inline. */
  data?: unknown
}

/**
 * The text that the offsets refer to (D8 rule 1): the string `content`, else
 * the text of the first text block, else `""`. Same rule as `outcomeTextOf` in
 * `src/sdk/tool-outcome-record.ts`. Copied here because a leaf cannot import
 * `src/`. Never throws.
 */
function textOfContent(content: unknown): string {
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
}

/** Read the attributes of one span. A bad value gives `undefined` (no attrs). */
function readAttrs(value: unknown): Record<string, string | number | boolean> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  const attrs: Record<string, string | number | boolean> = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") {
      attrs[key] = item
    }
  }
  return attrs
}

/**
 * Give the view of a stored `outcome` for its `content`, or `undefined` when
 * the record does not fit the content. The reader then uses its fallback.
 *
 * Rules (all checked here, because a replay reads raw records):
 * - `outcome.v` is `1`. `bodyEnd` is an integer in `[0, text.length]`.
 * - Each span has integer `start <= end <= text.length`, `start` is not less
 *   than the previous `end`, and `start` is not less than `bodyEnd`.
 * - Placeholder guard: with no span, `bodyEnd` must equal `text.length`. With
 *   spans, each span must be non-empty and `bodyEnd` must not pass the first
 *   `start`. A placeholder text block (an image removed for a text-only
 *   model) fails this guard, so the offsets are never read against it.
 *
 * Never throws: any error gives `undefined`.
 *
 * @param content - The `content` of the stored `tool_result` (string or blocks).
 * @param outcome - The stored `outcome` value. Not validated by the caller.
 * @returns The view, or `undefined`.
 */
export function viewPersistedOutcome(content: unknown, outcome: unknown): OutcomeView | undefined {
  try {
    if (typeof outcome !== "object" || outcome === null) return undefined
    const record = outcome as {
      v?: unknown
      bodyEnd?: unknown
      annotations?: unknown
      data?: unknown
    }
    if (record.v !== 1) return undefined
    const text = textOfContent(content)
    const bodyEnd = record.bodyEnd
    if (typeof bodyEnd !== "number" || !Number.isInteger(bodyEnd)) return undefined
    if (bodyEnd < 0 || bodyEnd > text.length) return undefined
    const spans = record.annotations
    if (!Array.isArray(spans)) return undefined

    const annotations: OutcomeViewAnnotation[] = []
    let previousEnd = bodyEnd
    for (const span of spans as unknown[]) {
      if (typeof span !== "object" || span === null) return undefined
      const { kind, attrs, start, end } = span as {
        kind?: unknown
        attrs?: unknown
        start?: unknown
        end?: unknown
      }
      if (typeof kind !== "string") return undefined
      if (typeof start !== "number" || !Number.isInteger(start)) return undefined
      if (typeof end !== "number" || !Number.isInteger(end)) return undefined
      if (start > end || end > text.length) return undefined
      // `previousEnd` starts at `bodyEnd`, so this also checks `start >= bodyEnd`.
      if (start < previousEnd) return undefined
      // Placeholder guard: a span must have text.
      if (start === end) return undefined
      previousEnd = end
      const spanAttrs = readAttrs(attrs)
      annotations.push({
        kind,
        ...(spanAttrs === undefined ? {} : { attrs: spanAttrs }),
        start,
        end,
        text: text.slice(start, end),
      })
    }
    // Placeholder guard: with no span, the body is the whole text.
    if (annotations.length === 0 && bodyEnd !== text.length) return undefined

    const view: OutcomeView = { text, body: text.slice(0, bodyEnd), bodyEnd, annotations }
    if (record.data !== undefined) view.data = record.data
    return view
  } catch {
    return undefined
  }
}
