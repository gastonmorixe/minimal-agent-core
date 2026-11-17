/**
 * Tool-result transform chain contract (spec R-API-3).
 *
 * Data-only types. A plugin declares transforms, core runs them in a fixed
 * phase order and adds no text of its own.
 *
 * @module plugin-api/types/tool-result-chain
 */

/** Phase of the tool-result chain. Core runs them in this order. */
export type ToolResultPhase = "clamp" | "pre-outcome" | "post-blob" | "final" | "stamp"

/**
 * Numbers that describe a clamp. Data only.
 *
 * Structurally the same as `TruncationInfo` in `src/tools/truncation.ts`.
 * plugin-api is a leaf and cannot import from `src/`, so it owns this copy.
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

/** The value that flows through the chain. Each transform returns a new stage. */
export interface ToolResultStage {
  /** Tool name. */
  tool: string
  /** Id of the tool call. */
  toolUseId: string
  /** Tool input. */
  input: Readonly<Record<string, unknown>>
  /** Result text for the model. */
  content: string
  /** True when the tool failed. */
  isError: boolean
  /** True when the call was aborted. */
  aborted: boolean
  /** Set by the clamp stage. Data only. */
  truncInfo?: TruncationInfo
  /** Set by the clamp stage. With no clamp stage, core sets it to `content`. */
  rawForBlob?: string
  /** Text for the host view. */
  display?: string
  /** Set by core after the blob write. */
  blob?: { path: string; bytes: number; sha256: string }
  /** Plugin-authored notes. */
  diagnosticNotes: readonly string[]
  /** Plugin-authored notes. */
  policyNotes: readonly string[]
  /**
   * Sideband kind for this result. Normally a `stamp` stage returns the new
   * text plus this kind. Core writes `block.sideband = { kind }` from it, only
   * when the kind is present and registered in the sideband registry. Closes a
   * gap in the sideband spec.
   */
  kind?: string
}

/** What core gives a transform next to the stage. */
export interface ToolResultStageContext {
  /**
   * Fires on the time limit of the stage, or on a turn abort during the
   * stage. A turn that is already aborted at the start does not fire it.
   */
  signal: AbortSignal
}

/** One transform that a plugin declares. */
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
   * A missing key keeps the input value. An explicit undefined clears an
   * optional field where the phase allows it. A wrong type drops the whole
   * result (reason "shape"). `aborted` is read only. `isError` can change
   * only in pre-outcome. A change to a read-only field drops the whole result
   * (reason "field-readonly"). A throw, a timeout or a result that core
   * cannot clone (a function, a Proxy, a getter that throws) also keeps the
   * input of the stage (fail open).
   */
  transform(
    s: ToolResultStage,
    ctx: ToolResultStageContext,
  ): ToolResultStage | Promise<ToolResultStage>
}
