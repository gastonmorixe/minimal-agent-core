/**
 * Structured tool result contract: `ToolOutcome` (SPEC v6.1 "The value", D2, D3, D4).
 *
 * Data-only types. Core lifts a handler result into a `ToolOutcome` (D2). Each
 * chain phase takes a `ToolOutcome` and returns a `ToolOutcome` (D4). Core makes
 * the model text from it at one place, at the end (D6).
 *
 * The only runtime values in this module are the D4 field table
 * (`TOOL_OUTCOME_FIELD_TABLE`) and the core kind list
 * (`CORE_ANNOTATION_KINDS`). Core reads them to check a stage result. This
 * module has no rendering text and no logic.
 *
 * Source: `research/2026-11-17-tool-result-structure/SPEC.md` v6.1.
 *
 * @module plugin-api/types/tool-outcome
 */

import type { ImageBlock } from "../llm/canonical-messages.ts"
import type { ToolResultPhase, TruncationInfo } from "./tool-result-chain.ts"

/**
 * Body of a tool result (SPEC "The value", D3).
 *
 * - `{ text }`: today's tools. Unchanged.
 * - `{ data, text, schema? }`: structured tools. `text` is required in both arms
 *   until the user decides D-A (D3). `schema` is documentation only. No validator
 *   runs (D3, D11 item 5). `data` must be JSON-safe, else core drops it at the
 *   lift (D11 item 6).
 */
export type ToolOutcomeBody =
  | { text: string }
  | { data: unknown; text: string; schema?: Readonly<Record<string, unknown>> }

/**
 * One rendered sideband line that core joins after the body (SPEC "The value", D4, D5).
 *
 * `text` holds the exact rendered bytes. They are frozen when the annotation is
 * added. Core sets `owner` when the annotation is appended. A stage cannot set
 * it (D4 owner rule).
 */
export interface ToolAnnotation {
  /** Sideband kind name, for example `"raw-output"`. */
  kind: string
  /** Sideband attributes. */
  attrs?: Record<string, string | number | boolean>
  /** Sideband body. */
  body?: string
  /** Exact rendered bytes. Frozen when added. */
  text: string
  /** Bytes before `text`: `"\n\n"`, `"\n"` or `""`. */
  join: string
  /** Default true. When false, core adds no join after an empty text. */
  joinWhenEmpty?: boolean
  /** Plugin id or `"core"`. Core sets it, not the stage (D4 owner rule). */
  owner: string
}

/**
 * Annotation kinds that core owns (D4 owner rule 3). They are read only for
 * every stage, in every phase, also in `stamp`. No stage may add one.
 *
 * The stored record has no owner field, so a restore gets the core status
 * of an annotation from its kind, through this list. Core uses only this
 * list for each "is this a core kind" check. Frozen at runtime.
 */
export const CORE_ANNOTATION_KINDS = Object.freeze([
  "mode-active",
  "policy",
  "raw-output",
  "output-preview",
  "output-truncated",
  "output-streak",
  "diagnostics",
] as const)

/** One annotation kind that core owns (see {@link CORE_ANNOTATION_KINDS}). */
export type CoreAnnotationKind = (typeof CORE_ANNOTATION_KINDS)[number]

/**
 * Hints for the live host view only. Not persisted (SPEC "The value").
 * The form is open until the user decides D-D.
 */
export interface HostHints {
  /** Was `display`. */
  view?: string
  /** Was `displayHeader`. */
  header?: string
  /** Was `displayFooter`. */
  footer?: string
  /** Was `suppressToolTime`. */
  hideDuration?: boolean
  /** Was `_displayPatch` and `_displayNewFile`. */
  diff?: { patch: string; newFile: boolean }
}

/** Blob reference. Core sets it after the blob write (D4, F3). */
export interface ToolOutcomeBlob {
  /** Absolute path of the blob file. */
  path: string
  /** Size in bytes. */
  bytes: number
  /** SHA-256 of the content. */
  sha256: string
}

/**
 * The value that flows through the chain and goes to the record (SPEC "The value", D2, D4).
 *
 * The D4 field table (`TOOL_OUTCOME_FIELD_TABLE`) gives which phase may change
 * which field.
 */
export interface ToolOutcome {
  /** Body. The lift never changes `text` (D2 rule). */
  body: ToolOutcomeBody
  /** Media blocks (built-in `blocks`). Read only in all phases (D4). */
  media?: ImageBlock[]
  /** Annotations in append order. */
  annotations: ToolAnnotation[]
  /** True when the tool failed. A stage may change it only in `pre-outcome` (D4). */
  isError: boolean
  /** True when the call was aborted. Read only in all phases (D4). */
  aborted: boolean
  /** Clamp numbers. Data only. */
  truncInfo?: TruncationInfo
  /** Blob input. */
  rawForBlob?: string
  /** Set by core after the blob write. */
  blob?: ToolOutcomeBlob
  /** Live host view only. Not persisted. */
  hostHints?: HostHints
}

/**
 * Permission of a phase for one field (D4 field table).
 *
 * - `"yes"`: a stage in this phase may change the field.
 * - `"no"`: core drops the stage result if the field changed.
 * - `"own"`: only the annotations that the stage plugin owns (owner rule).
 */
export type ToolOutcomeFieldPermission = "yes" | "no" | "own"

/**
 * Field names of the D4 field table. `body.data` and `body.schema` share one
 * row in the SPEC. `kind` is the sideband mark of the stage.
 */
export type ToolOutcomeField =
  | "body.text"
  | "body.data"
  | "body.schema"
  | "media"
  | "annotations"
  | "isError"
  | "aborted"
  | "truncInfo"
  | "rawForBlob"
  | "blob"
  | "hostHints"
  | "kind"

/** Shape of the D4 field table: one permission for each field and phase. */
export type ToolOutcomeFieldTable = Readonly<
  Record<ToolOutcomeField, Readonly<Record<ToolResultPhase, ToolOutcomeFieldPermission>>>
>

/**
 * D4 field table (SPEC v6.1 D4). Core checks each `"no"` cell after each stage
 * and drops the result of a stage that breaks a rule (fail open, D11 item 3).
 * Deep-frozen at runtime: a plugin cannot change the shared rules.
 */
export const TOOL_OUTCOME_FIELD_TABLE = freezeTable({
  "body.text": { clamp: "yes", "pre-outcome": "yes", "post-blob": "yes", final: "no", stamp: "no" },
  "body.data": { clamp: "no", "pre-outcome": "yes", "post-blob": "yes", final: "no", stamp: "no" },
  "body.schema": { clamp: "no", "pre-outcome": "yes", "post-blob": "yes", final: "no", stamp: "no" },
  media: { clamp: "no", "pre-outcome": "no", "post-blob": "no", final: "no", stamp: "no" },
  annotations: { clamp: "own", "pre-outcome": "own", "post-blob": "own", final: "own", stamp: "own" },
  isError: { clamp: "no", "pre-outcome": "yes", "post-blob": "no", final: "no", stamp: "no" },
  aborted: { clamp: "no", "pre-outcome": "no", "post-blob": "no", final: "no", stamp: "no" },
  truncInfo: { clamp: "yes", "pre-outcome": "no", "post-blob": "no", final: "no", stamp: "no" },
  rawForBlob: { clamp: "yes", "pre-outcome": "yes", "post-blob": "no", final: "no", stamp: "no" },
  blob: { clamp: "no", "pre-outcome": "no", "post-blob": "no", final: "no", stamp: "no" },
  hostHints: { clamp: "no", "pre-outcome": "no", "post-blob": "yes", final: "yes", stamp: "no" },
  kind: { clamp: "no", "pre-outcome": "no", "post-blob": "no", final: "no", stamp: "yes" },
} as const satisfies ToolOutcomeFieldTable)

/** Freeze each row, then the table. Returns the same object with the same type. */
function freezeTable<T extends ToolOutcomeFieldTable>(table: T): T {
  for (const row of Object.values(table)) Object.freeze(row)
  return Object.freeze(table)
}
