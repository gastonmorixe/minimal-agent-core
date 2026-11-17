/**
 * Persisted form of a `ToolOutcome` (SPEC v6.1 D8): the `outcome` field of a
 * `tool_result` session record and of a `tool_result` history block.
 *
 * The record holds NO text. The offsets refer to the final model text of the
 * block (D8 rule 1: `content` when it is a string, else the first text block,
 * else `""`). A reader gets the body with `text.slice(0, bodyEnd)` and an
 * annotation with `text.slice(start, end)` (D8 rule 2).
 *
 * The record holds no `hostHints`, no `truncInfo`, no `media`, no `rawForBlob`
 * and no `blob` (D8 rule 3, spec S29: a record carries no presentation field).
 *
 * The field is metadata only. No encoder sends it to a provider (D9).
 *
 * @module plugin-api/types/tool-outcome-record
 */

import type { ToolAnnotation, ToolOutcomeBlob } from "./tool-outcome.ts"

// Re-export for the converter in `src/sdk/tool-outcome-record.ts`: it takes the
// type with its value import of this module, so the SDK type-only import
// ratchet (`src/architecture/sdk-port-boundaries.test.ts`) does not grow.
export type { ToolOutcome } from "./tool-outcome.ts"

/** Version of the record shape. A reader drops a value with another version. */
export const PERSISTED_TOOL_OUTCOME_VERSION = 1

/**
 * Maximum UTF-8 byte length of the JSON form of `data` that core keeps inline
 * (SPEC D-F final value). Above it, core drops `data` and keeps the rest of
 * the record. M2 writes no blob spill.
 */
export const TOOL_OUTCOME_DATA_INLINE_MAX_BYTES = 16_000

/** One annotation span in the final text (SPEC D8). UTF-16 offsets. */
export interface PersistedToolOutcomeSpan {
  /** Kind of the annotation, for example `"raw-output"`. */
  kind: string
  /** Attributes of the annotation, when it has them. */
  attrs?: ToolAnnotation["attrs"]
  /** UTF-16 offset of the first character of the annotation text. */
  start: number
  /** UTF-16 offset after the last character of the annotation text. */
  end: number
}

/** The `outcome` field of a `tool_result` record and block (SPEC D8). No text. */
export interface PersistedToolOutcome {
  /** Record shape version. Always {@link PERSISTED_TOOL_OUTCOME_VERSION}. */
  v: typeof PERSISTED_TOOL_OUTCOME_VERSION
  /** UTF-16 offset in the final text where the body ends. */
  bodyEnd: number
  /** One span for each annotation, in append order. */
  annotations: PersistedToolOutcomeSpan[]
  /** Structured body data. Inline only up to {@link TOOL_OUTCOME_DATA_INLINE_MAX_BYTES}. */
  data?: unknown
  /**
   * D-F: pointer to `data` in the blob store. M2 does not write it. A reader
   * that does not find the target treats it as "no data", not as an error.
   */
  dataRef?: ToolOutcomeBlob
  /** Documentation schema of `data` (D3). No validator runs. */
  schema?: Readonly<Record<string, unknown>>
}
