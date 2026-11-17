/**
 * Finalize: the one place that makes the model text of a `ToolOutcome`
 * (SPEC v6.1 D6).
 *
 * The join rule (D6): start with `body.text`. For each annotation, in append
 * order, add `join + text`. When the text so far is empty and the annotation
 * has `joinWhenEmpty: false`, add `text` only (the mode stamp on empty
 * content, D5).
 *
 * {@link finalizeOutcome} also gives the body end and one span for each
 * annotation (D8 rules 1 and 2, T2). A span covers the annotation `text`
 * only, not its `join`. So `text.slice(start, end) === annotation.text`.
 *
 * Pure functions. No I/O, no clock, no config, no diagnostics. Media is not
 * read: D6 puts the media blocks after this text. The caller builds the
 * media branch. Before M7, finalize reads no codec (D6).
 *
 * @module loops/tool-outcome-finalize
 */

import type { ToolAnnotation, ToolOutcome } from "../../plugin-api/src/types/tool-outcome.ts"

/** Position of one annotation in the finalized text (SPEC D8 rule 2). */
export interface ToolOutcomeSpan {
  /** Kind of the annotation. */
  readonly kind: string
  /** Attributes of the annotation, when it has them. */
  readonly attrs?: ToolAnnotation["attrs"]
  /** UTF-16 offset of the first character of the annotation `text`. */
  readonly start: number
  /** UTF-16 offset after the last character of the annotation `text`. */
  readonly end: number
}

/** Result of {@link finalizeOutcome}. */
export interface FinalizedOutcome {
  /** The model text. Equals `joinOutcome(outcome)`. */
  readonly text: string
  /** UTF-16 offset where the body ends: `text.slice(0, bodyEnd) === body.text`. */
  readonly bodyEnd: number
  /** One span for each annotation, in append order. */
  readonly spans: readonly ToolOutcomeSpan[]
}

/** The input that the join reads. A full `ToolOutcome` is accepted. */
export type JoinableOutcome = Pick<ToolOutcome, "body" | "annotations">

/**
 * Join the body text and the annotations into the model text (SPEC D6).
 * Reads `body.text` only, also for a body with `data`.
 */
export function joinOutcome(outcome: JoinableOutcome): string {
  return finalizeOutcome(outcome).text
}

/**
 * Join the body text and the annotations (SPEC D6). Also give the body end
 * and the annotation spans (SPEC D8, T2).
 */
export function finalizeOutcome(outcome: JoinableOutcome): FinalizedOutcome {
  let out = outcome.body.text
  const bodyEnd = out.length
  const spans: ToolOutcomeSpan[] = []
  for (const a of outcome.annotations) {
    out += out.length === 0 && a.joinWhenEmpty === false ? "" : a.join
    const start = out.length
    out += a.text
    spans.push(
      a.attrs === undefined
        ? { kind: a.kind, start, end: out.length }
        : { kind: a.kind, attrs: a.attrs, start, end: out.length },
    )
  }
  return { text: out, bodyEnd, spans }
}
