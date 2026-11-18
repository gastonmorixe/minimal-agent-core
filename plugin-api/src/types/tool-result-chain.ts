/**
 * Tool-result transform chain contract (spec R-API-3).
 *
 * Data-only types. A plugin declares transforms, core runs them in a fixed
 * phase order and adds no text of its own.
 *
 * @module plugin-api/types/tool-result-chain
 */

import type { ToolAnnotation, ToolOutcome } from "./tool-outcome.ts"

/**
 * Phase of the tool-result chain. Core runs them in this order.
 *
 * Experimental: the shape can change before it is marked stable.
 *
 * @experimental
 */
export type ToolResultPhase = "clamp" | "pre-outcome" | "post-blob" | "final" | "stamp"

/**
 * Numbers that describe a clamp. Data only.
 *
 * Structurally the same as `TruncationInfo` in `src/tools/truncation.ts`.
 * plugin-api is a leaf and cannot import from `src/`, so it owns this copy.
 *
 * Experimental: the shape can change before it is marked stable.
 *
 * @experimental
 */
export interface TruncationInfo {
  /** Tool name. */
  tool?: string
  /** True when the body was clamped. */
  truncated: boolean
  /** Bytes shown to the model. */
  shownBytes: number
  /** Lines shown to the model. */
  shownLines: number
  /** Total bytes the source produced, if known. */
  totalBytes?: number
  /** Total lines the source produced, if known. */
  totalLines?: number
  /** Absolute last-line index visible. */
  cutLine: number
  /** Zero-based line offset already applied. */
  startLine?: number
}

/**
 * The value that flows through the chain (SPEC v6.1 D4): a `ToolOutcome`
 * plus the read-only facts of the call. Each transform returns a new stage.
 *
 * The D4 field table (`TOOL_OUTCOME_FIELD_TABLE`) gives which phase may
 * change which field. `tool`, `toolUseId` and `input` are read only in each
 * phase. `media` is read only in each phase. A stage may add, change or
 * remove only the annotations that its own plugin owns (D4 owner rule).
 *
 * Experimental: the shape can change before it is marked stable.
 *
 * @experimental
 */
export interface ToolResultStage extends Omit<ToolOutcome, "annotations"> {
  /** Tool name. Read only. */
  readonly tool: string
  /** Id of the tool call. Read only. */
  readonly toolUseId: string
  /** Tool input. Read only. */
  readonly input: Readonly<Record<string, unknown>>
  /**
   * Annotations in append order. Core sets `owner` on each annotation. A
   * stage cannot remove, change or reorder an annotation of core or of
   * another plugin: these stay in the same order among the annotations of
   * other owners, with the same fields. The stage may add its own
   * annotations at any position. An annotation of a core kind or with the
   * owner `"core"` is always a core annotation. The `owner` field in a stage
   * result has no effect: core takes the owner of each kept annotation from
   * its own copy of the input, and sets the plugin id on each new one. A
   * plugin annotation must have `join` `"\n\n"`, `"\n"` or `""`, at most 16
   * attrs with valid sideband attr names and finite numbers, and is under
   * the size caps of the runner (`PLUGIN_ANNOTATION_CAPS`, SPEC E14): at
   * most 8 plugin annotations on one outcome, for all plugins together (not
   * per stage result); at most 2048 UTF-8 bytes of `text` plus `body` per
   * plugin annotation; at most 8192 bytes of all plugin-owned annotation
   * text plus attr bytes on one outcome; at most 256 bytes per string attr.
   */
  annotations: readonly ToolAnnotation[]
  /**
   * Sideband kind for this result. Only a `stamp` stage may set it (D4 field
   * table). Core writes `block.sideband = { kind }` from it, only when the
   * kind is present and registered in the sideband registry.
   */
  kind?: string
}

/**
 * What core gives a transform next to the stage.
 *
 * Experimental: the shape can change before it is marked stable.
 *
 * @experimental
 */
export interface ToolResultStageContext {
  /**
   * Fires on the time limit of the stage, or on a turn abort during the
   * stage. A turn that is already aborted at the start does not fire it.
   */
  signal: AbortSignal
}

/**
 * One transform that a plugin declares.
 *
 * Experimental: the shape can change before it is marked stable.
 *
 * @experimental
 */
export interface ToolResultTransformDecl {
  /** Phase to run in. */
  phase: ToolResultPhase
  /** Ascending order inside a phase. */
  order: number
  /**
   * Time limit of this stage in ms. Source order: this decl value if it is a
   * finite number, else the plugin manifest value, else 2000. Core floors
   * the value, then clamps it to 1..2000. The loader emits one
   * `tool-result-chain.timeout-clamped` diagnostic
   * `{pluginId, phase, requested, applied}` when it clamps a value or finds
   * an invalid value. A missing value gives no diagnostic. The runner clamps
   * again and emits no diagnostic. On timeout core keeps the input of the
   * stage.
   */
  timeoutMs?: number
  /**
   * Return the next stage. The input is a deep-frozen copy: return a new
   * object, do not change the input. Return a partial or full stage value.
   * Only the keys of `ToolResultStage` count: core ignores each other key
   * (for example `outcome`, `sideband`, `__proto__`) with no diagnostic.
   * A missing key keeps the input value. `body` is one value: a present
   * `body` replaces the whole body. An explicit undefined clears an optional
   * field. A wrong type drops the whole result (reason "shape"). A change to
   * a field that the D4 field table marks "no" for the phase drops the whole
   * result (reason "field-readonly"). `tool`, `toolUseId` and `input` are
   * read only. A change, removal or reorder of an annotation of core or of
   * another plugin, or a new annotation of a core kind or of a
   * `trust: "harness"` kind that the plugin does not own, drops the whole
   * result (reason "owner"). A stage of a plugin with the id `"core"` (any
   * case, spaces around it), an empty id, or an id that does not obey the
   * sideband registry name rule (for example `"core\u200b"`) never runs
   * (reason "owner"). A result that puts the outcome over a size cap (the
   * annotation count cap is for all plugins together on one outcome) drops
   * the whole result (reason "size"). A bad `join`, attr key or number attr drops the whole result
   * (reason "shape"). Core drops
   * one new annotation of a kind that is not registered with placement
   * "tool-result", and keeps the rest of the result. A throw, a timeout or a
   * result that core cannot clone (a function, a Proxy, a getter that throws)
   * also keeps the input of the stage (fail open).
   */
  transform(
    s: ToolResultStage,
    ctx: ToolResultStageContext,
  ): ToolResultStage | Promise<ToolResultStage>
}
