/**
 * Compaction provider contract (G7, R-API-9).
 *
 * A plugin supplies the text of a compaction: the summary system prompt, the
 * checkpoint message and the labels used to flatten tool blocks. Core holds
 * no such text. This provider stays UNUSED (dead code) until S7.2 adds the
 * registrar that wires it.
 *
 * The checkpoint return type is `ContentBlock` (text blocks only), like the
 * turn content provider. The sideband half of the spec union
 * (`SidebandOrBlock`) is not available yet.
 *
 * @module types/compaction
 */

import type { TextBlock } from "../llm/canonical-messages.ts"

/**
 * The block kinds a checkpoint may hold. plugin-api cannot import the core
 * `ContentBlock` (leaf rule), so text blocks only. Other kinds join later.
 */
export type CompactionBlock = TextBlock

/** Which checkpoint shape a compaction wrote. Remote compaction has no kind. */
export type CompactionKind = "tail" | "local"

/** Facts core passes when it asks a provider for the checkpoint message. */
export interface CompactionCheckpointInfo {
  /** Number of retained messages behind the checkpoint. */
  readonly retained: number
  /** The user focus string, unchanged. */
  readonly focus?: string
  /** The model summary, when a local summary ran. */
  readonly summary?: string
}

/** Supplies the compaction text. Core uses it only once S7.2 wires it. */
export interface CompactionProvider {
  /** System prompt for the local summary call. `focus` is user data. */
  summarySystemPrompt(focus?: string): string
  /** The checkpoint message blocks for a tail or local compaction. */
  checkpointMessage(
    kind: CompactionKind,
    info: CompactionCheckpointInfo,
  ): readonly CompactionBlock[]
  /** The label that replaces a tool block when core flattens history. */
  flattenLabel(kind: "tool_use" | "tool_result", facts: Readonly<Record<string, string>>): string
}

/**
 * Structured record of one compaction, stored as the optional `meta` field
 * of the `compact` session row. Remote compaction writes none.
 */
export interface CompactMeta {
  /** Checkpoint shape. */
  kind: CompactionKind
  /** Number of retained messages behind the checkpoint. */
  retained: number
  /** The user focus string, unchanged. Absent when none was given. */
  focus?: string
  /** ISO time of the compaction. Equal to the row `ts`. */
  at: string
}
