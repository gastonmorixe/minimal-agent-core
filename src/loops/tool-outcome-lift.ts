/**
 * Lift: a handler result to a `ToolOutcome` (SPEC v6.1 D2).
 *
 * Core makes a `ToolOutcome` at the point where the tool round copies the
 * result into its locals. Rule (D2): the lift never changes the text. The
 * clamp gives its parts (kept, notice, facts). The lift puts `kept` in
 * `body.text` and the notice in one `output-truncated` annotation (join
 * `"\n\n"`). So `joinOutcome(lift(...))` equals the old `content` string.
 * The lift does not split `content` at `shownBytes` (lead decision Q1).
 *
 * Pure functions. No I/O, no clock, no config. The notice text is rendered
 * from the typed facts with the resolver that the caller gives (required, no
 * default): the tool round passes the same resolver that the clamp used, so
 * the bytes do not depend on object identity (review W1).
 * The tool round (U3/U4) calls these functions. This module does not.
 *
 * @module loops/tool-outcome-lift
 */

import type { HostHints, ToolOutcome } from "../../plugin-api/src/types/tool-outcome.ts"
import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import type { ToolExecResult } from "../tools/tools.ts"
import {
  joinTruncationParts,
  type TruncationFacts,
  type TruncationParts,
} from "../tools/truncation-parts.ts"

import { outputTruncatedFromParts } from "./tool-outcome-annotations.ts"

/** Common inputs of a lift. */
export interface LiftOptions {
  /** True when the tool failed. Today's local is `boolean | undefined`; the outcome holds `=== true`. */
  readonly isError?: boolean
  /** True when the call was aborted. */
  readonly aborted?: boolean
  /** Hints for the live host view (from `display*`, `suppressToolTime`, `_displayPatch`). */
  readonly hostHints?: HostHints
}

/** Inputs of a lift that can render the truncation notice. */
export interface LiftRenderOptions extends LiftOptions {
  /**
   * The resolver that the clamp used (required, review W1). The lift renders
   * the `output-truncated` text from the facts with it.
   */
  readonly text: SyntheticTextResolver
}

/**
 * Lift a plain text result: a refusal (`isError: true`), a Mode JSON text, a
 * plugin `tool_result` that the clamp skipped, or the non-tool-result text.
 * `body.text` is `text`, unchanged. No annotation.
 */
export function liftText(text: string, opts: LiftOptions = {}): ToolOutcome {
  const o: ToolOutcome = {
    body: { text },
    annotations: [],
    isError: opts.isError === true,
    aborted: opts.aborted === true,
  }
  if (opts.hostHints !== undefined) o.hostHints = opts.hostHints
  return o
}

/** Inputs of {@link liftClamped}. */
export interface LiftClampedOptions extends LiftRenderOptions {
  /** Pre-clamp body for the blob store (today `rawForBlob`). Set only when the clamp cut. */
  readonly rawForBlob?: string
  /** Media blocks (built-in `blocks`). */
  readonly media?: ToolOutcome["media"]
}

/**
 * Lift a clamped result (plugin inline clamp, TR:687-697, or the built-in
 * clamp in `executeTool`). `body.text` is `parts.kept`. When the clamp cut
 * (`parts.facts.truncated`), one `output-truncated` annotation holds the
 * notice (rendered from the facts with `opts.text`) and the facts.
 * `truncInfo` is a copy of `parts.info`.
 */
export function liftClamped(parts: TruncationParts, opts: LiftClampedOptions): ToolOutcome {
  const o = liftText(parts.kept, opts)
  const notice = outputTruncatedFromParts(parts, opts.text)
  if (notice) o.annotations = [notice]
  o.truncInfo = { ...parts.info }
  if (opts.rawForBlob !== undefined) o.rawForBlob = opts.rawForBlob
  if (opts.media !== undefined) o.media = opts.media
  return o
}

/** Why {@link liftBuiltIn} did not use `_truncParts` (review S6, fix 5e). */
export type LiftFallbackReason = "missing" | "malformed" | "content-mismatch" | "notice-mismatch"

/** Inputs of {@link liftBuiltIn}. */
export interface LiftBuiltInOptions extends LiftRenderOptions {
  /**
   * Called when the lift falls back to `content` as the body text with no
   * annotation. The tool round records it (for example as a diagnostic).
   */
  readonly onFallback?: (reason: LiftFallbackReason) => void
}

const FACT_NUMBERS: ReadonlyArray<keyof TruncationFacts> = [
  "shownBytes",
  "totalBytes",
  "shownLines",
  "totalLines",
  "cutLine",
  "cutByte",
  "longLines",
  "lineCharCap",
  "nextOffset",
]

/** True when `v` has the shape of the clamp parts (strings, a boolean gate, finite numbers). */
function isPartsShape(v: unknown): v is TruncationParts {
  if (typeof v !== "object" || v === null) return false
  const p = v as Partial<TruncationParts>
  if (typeof p.kept !== "string" || typeof p.notice !== "string") return false
  if (typeof p.info !== "object" || p.info === null) return false
  const f = p.facts as Partial<Record<keyof TruncationFacts, unknown>> | undefined
  if (typeof f !== "object" || f === null) return false
  if (typeof f.truncated !== "boolean" || typeof f.tool !== "string") return false
  if (typeof f.cutMidLine !== "boolean" || typeof f.lastLinePartial !== "boolean") return false
  return FACT_NUMBERS.every((k) => Number.isFinite(f[k]))
}

/**
 * Lift a built-in `ToolExecResult` (SPEC D2 row 4). Reads `_truncParts` when
 * the clamp ran; else `content` is the body (the clamp skips a diff result).
 * `media: blocks`, `hostHints.diff` from `_displayPatch`, `truncInfo` from
 * `_truncInfo`, `rawForBlob` from `_raw`, `aborted` from `_aborted`.
 * Guard: when `_truncInfo` is set but `_truncParts` is missing, when
 * `_truncParts` is malformed, when its join is not `content`, or when the
 * notice rendered from its facts with `opts.text` is not `parts.notice`, the
 * lift uses `content` as the body text with no annotation and calls
 * `opts.onFallback`. So the model bytes stay `content`.
 * The "canceled" text is NOT set here: the tool round runs `cancelWhenEmpty`
 * after the lift (D5, C-9).
 */
export function liftBuiltIn(result: ToolExecResult, opts: LiftBuiltInOptions): ToolOutcome {
  const { onFallback, ...rest } = opts
  const hostHints: HostHints | undefined =
    rest.hostHints ??
    (result._displayPatch !== undefined
      ? { diff: { patch: result._displayPatch, newFile: result._displayNewFile === true } }
      : undefined)
  const base: LiftClampedOptions = {
    ...rest,
    isError: rest.isError ?? result.is_error,
    aborted: rest.aborted ?? result._aborted === true,
    ...(hostHints !== undefined ? { hostHints } : {}),
    ...(result._raw !== undefined ? { rawForBlob: result._raw } : {}),
    ...(result.blocks !== undefined ? { media: result.blocks } : {}),
  }
  const parts: unknown = result._truncParts
  let reason: LiftFallbackReason | undefined
  if (parts === undefined) {
    if (result._truncInfo !== undefined) reason = "missing"
  } else if (!isPartsShape(parts)) {
    reason = "malformed"
  } else if (joinTruncationParts(parts) !== result.content) {
    reason = "content-mismatch"
  } else {
    const lifted = liftClamped(parts, base)
    // The notice rendered from the facts must be the clamp bytes. Else the
    // resolver is not the one that the clamp used, or the notice is forged.
    const rendered = lifted.annotations[0]?.text ?? ""
    if (!parts.facts.truncated || rendered === parts.notice) return lifted
    reason = "notice-mismatch"
  }
  if (reason !== undefined) onFallback?.(reason)
  const o = liftText(result.content, base)
  if (result._truncInfo !== undefined) o.truncInfo = result._truncInfo
  if (base.rawForBlob !== undefined) o.rawForBlob = base.rawForBlob
  if (base.media !== undefined) o.media = base.media
  return o
}
