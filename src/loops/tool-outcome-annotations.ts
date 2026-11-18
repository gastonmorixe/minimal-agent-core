/**
 * Core annotation builders for `ToolOutcome` (SPEC v6.1 D5).
 *
 * Each core append of today becomes one annotation with `owner: "core"`.
 * The `text` and the `join` hold the exact bytes of today, so
 * `finalizeOutcome(lift + annotations).text` equals today's `content`.
 *
 * D5 order (append order in the tool round):
 * 1. `output-truncated` (clamp, at the lift)
 * 2. `output-streak` (built-in path only)
 * 3. `diagnostics` (tool.didInvoke notes)
 * 4. `raw-output` (blob footer)
 * 5. `output-preview` (rule V: counted on the finalize prefix)
 * 6. `policy` (rule P: one annotation per clean line, join `"\n"`)
 * 7. `mode-active` (`joinWhenEmpty: false`)
 *
 * One-value rule (DECISIONS D-B option 2, D-A gate): each builder takes ONE
 * source value. A kind spec renders the `text` and makes the `attrs` from
 * that same value. A builder takes no text and no attrs as input, and the
 * result is deep-frozen. {@link buildCoreAnnotation} accepts only the frozen
 * specs of this module (review S3). So the text and the attrs cannot disagree.
 *
 * Pure functions, except that the text kinds call the synthetic text
 * resolver (the providers are pure in M1). No I/O, no clock, no config.
 * The kind labels are names only in M1 (D5). Core registers no kind.
 *
 * @module loops/tool-outcome-annotations
 */

import type {
  CoreAnnotationKind,
  ToolAnnotation,
  ToolOutcome,
} from "../../plugin-api/src/types/tool-outcome.ts"
import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import {
  computeTuiElision,
  DIAGNOSTICS_ANNOTATION_JOIN,
  diagnosticsNotes,
  renderDiagnosticsTag,
} from "../agent/tool-preview-budget.ts"
import { modeActiveStampText } from "../modes/mode-text.ts"
import { cleanHookContext } from "../sdk/hook-context.ts"
import { type BlobWriteResult, formatBytes, formatRawOutputFooter } from "../session/blob-store.ts"
import { previewTagText } from "../tools/tool-result-text.ts"
import {
  renderTruncatedNotice,
  TRUNCATION_NOTICE_JOIN,
  type TruncationFacts,
} from "../tools/truncation-parts.ts"

import { joinOutcome } from "./tool-outcome-finalize.ts"

/** Attribute value type of a `ToolAnnotation`. */
export type AnnotationAttrs = Readonly<Record<string, string | number | boolean>>

/** Owner of every annotation that this module builds. */
export const CORE_OWNER = "core"

/**
 * The spec of one core kind: the join, and two functions of ONE source value.
 * `render` gives the frozen text. `attrs` gives the attributes.
 * Local type: plugin-api has no typed attrs shape (recorded for the lead).
 */
export interface CoreAnnotationSpec<S> {
  readonly kind: CoreAnnotationKind
  readonly join: string
  /** Only `mode-active` sets it (to false). */
  readonly joinWhenEmpty?: false
  readonly attrs: (source: S) => AnnotationAttrs
  /** Optional sideband body (for example the policy line). */
  readonly body?: (source: S) => string
  readonly render: (source: S) => string
}

/**
 * The frozen specs of this module. {@link buildCoreAnnotation} accepts only
 * these, so a caller cannot give a `render` that disagrees with `attrs`.
 */
const CORE_SPECS = new WeakSet<object>()

/** Freeze a spec and record it as a core spec. */
function coreSpec<S>(spec: CoreAnnotationSpec<S>): CoreAnnotationSpec<S> {
  const frozen = Object.freeze(spec)
  CORE_SPECS.add(frozen)
  return frozen
}

/**
 * Build one frozen core annotation from one source value. The text and the
 * attrs both come from `source`. Core-internal (no public subpath exports
 * this module); exported for the tool round and the D-B gate test. Throws
 * for a spec that this module did not make (review S3).
 */
export function buildCoreAnnotation<S>(spec: CoreAnnotationSpec<S>, source: S): ToolAnnotation {
  if (!CORE_SPECS.has(spec)) throw new TypeError("buildCoreAnnotation: not a core annotation spec")
  const attrs = Object.freeze({ ...spec.attrs(source) })
  const text = spec.render(source)
  const a: ToolAnnotation = { kind: spec.kind, text, join: spec.join, owner: CORE_OWNER }
  if (Object.keys(attrs).length > 0) a.attrs = attrs
  if (spec.body) a.body = spec.body(source)
  if (spec.joinWhenEmpty === false) a.joinWhenEmpty = false
  return Object.freeze(a)
}

// --- 1. output-truncated --------------------------------------------------

/** Source of `output-truncated`: the typed clamp facts and the text resolver. */
export interface TruncatedSource {
  readonly text: SyntheticTextResolver
  readonly facts: TruncationFacts
}

/**
 * The typed attrs of `output-truncated`: the D-H facts. Not `truncated` (the
 * annotation exists only when it is true) and not `noticeTotalLines` (a
 * renderer input only, review S1).
 */
export function truncationAttrs(f: TruncationFacts): AnnotationAttrs {
  return {
    tool: f.tool,
    shownBytes: f.shownBytes,
    totalBytes: f.totalBytes,
    shownLines: f.shownLines,
    totalLines: f.totalLines,
    totalLinesKnown: f.totalLinesKnown,
    cutLine: f.cutLine,
    cutByte: f.cutByte,
    cutMidLine: f.cutMidLine,
    longLines: f.longLines,
    lineCharCap: f.lineCharCap,
    lastLinePartial: f.lastLinePartial,
    nextOffset: f.nextOffset,
  }
}

/** `output-truncated` (D5 row 1, D-H facts in attrs). Join `"\n\n"`. */
export const OUTPUT_TRUNCATED_SPEC: CoreAnnotationSpec<TruncatedSource> = coreSpec({
  kind: "output-truncated",
  join: TRUNCATION_NOTICE_JOIN,
  attrs: (s: TruncatedSource): AnnotationAttrs => truncationAttrs(s.facts),
  render: (s: TruncatedSource): string => renderTruncatedNotice(s.text, s.facts),
})

/** The `output-truncated` annotation, rendered from `facts` (second clamp, C-5). */
export function outputTruncatedAnnotation(
  text: SyntheticTextResolver,
  facts: TruncationFacts,
): ToolAnnotation {
  return buildCoreAnnotation(OUTPUT_TRUNCATED_SPEC, { text, facts })
}

/**
 * The `output-truncated` annotation for a clamp result, or `null` when the
 * clamp did not cut. The gate reads `parts.facts.truncated` (frozen), not
 * `parts.info` (review W2). The text is always rendered from `parts.facts`
 * with `text`, which must be the resolver that the clamp used: then it is
 * the same bytes as `parts.notice`. `parts.notice` is not read, so the bytes
 * do not depend on object identity (a `structuredClone` of the parts gives
 * the same text) and a forged notice is not used (review W1).
 */
export function outputTruncatedFromParts(
  parts: { readonly facts: TruncationFacts },
  text: SyntheticTextResolver,
): ToolAnnotation | null {
  if (parts.facts.truncated !== true) return null
  return outputTruncatedAnnotation(text, parts.facts)
}

// --- 2. output-streak -----------------------------------------------------

/**
 * Source of `output-streak`: the note that `ToolFeedbackTracker.observe`
 * returned, with the tool name and the threshold (its facts). The tracker
 * owns the counter, so core keeps the rendered note as the source text.
 */
export interface StreakSource {
  readonly tool: string
  readonly threshold: number
  readonly note: string
}

/** `output-streak` (D5 row 2). Join `"\n\n"`. */
export const OUTPUT_STREAK_SPEC: CoreAnnotationSpec<StreakSource> = coreSpec({
  kind: "output-streak",
  join: "\n\n",
  attrs: (s: StreakSource): AnnotationAttrs => ({ tool: s.tool, threshold: s.threshold }),
  render: (s: StreakSource): string => s.note,
})

/**
 * The streak annotation, or `null` when the tracker gave no note. Today
 * TR appends only when the note is truthy (`if (streakNote)`).
 */
export function outputStreakAnnotation(
  note: string | null,
  tool: string,
  threshold: number,
): ToolAnnotation | null {
  if (!note) return null
  return buildCoreAnnotation(OUTPUT_STREAK_SPEC, { tool, threshold, note })
}

// --- 3. diagnostics -------------------------------------------------------

/** Source of `diagnostics`: the clean notes and the scope. */
export interface DiagnosticsSource {
  readonly notes: readonly string[]
  readonly scope?: string
}

/** `diagnostics` (D5 row 3). Join `"\n\n"`; the text has no leading join. */
export const DIAGNOSTICS_SPEC: CoreAnnotationSpec<DiagnosticsSource> = coreSpec({
  kind: "diagnostics",
  join: DIAGNOSTICS_ANNOTATION_JOIN,
  attrs: (s: DiagnosticsSource): AnnotationAttrs =>
    s.scope === "ad-hoc" ? { count: s.notes.length, scope: "ad-hoc" } : { count: s.notes.length },
  body: (s: DiagnosticsSource): string => s.notes.join("\n"),
  render: (s: DiagnosticsSource): string => renderDiagnosticsTag(s.notes, s.scope),
})

/**
 * The diagnostics annotation, or `null` when no note is left after the clean
 * step (today `formatDiagnosticsAnnotation` gives `""`, so TR adds nothing).
 */
export function diagnosticsAnnotation(
  notes: readonly unknown[],
  scope?: string,
): ToolAnnotation | null {
  const clean = diagnosticsNotes(notes)
  if (clean.length === 0) return null
  return buildCoreAnnotation(DIAGNOSTICS_SPEC, {
    notes: Object.freeze(clean),
    ...(scope !== undefined ? { scope } : {}),
  })
}

// --- 4. raw-output --------------------------------------------------------

/** `raw-output` (D5 row 4). Join `"\n\n"`. Source: the blob write result. */
export const RAW_OUTPUT_SPEC: CoreAnnotationSpec<BlobWriteResult> = coreSpec({
  kind: "raw-output",
  join: "\n\n",
  attrs: (b: BlobWriteResult): AnnotationAttrs => ({
    path: b.path,
    size: formatBytes(b.bytes),
    sha256: b.sha256,
  }),
  render: (b: BlobWriteResult): string => formatRawOutputFooter(b),
})

/** The raw-output footer annotation. */
export function rawOutputAnnotation(blob: BlobWriteResult): ToolAnnotation {
  return buildCoreAnnotation(RAW_OUTPUT_SPEC, {
    path: blob.path,
    bytes: blob.bytes,
    sha256: blob.sha256,
  })
}

// --- 5. output-preview ----------------------------------------------------

/** Source of `output-preview`: the elision numbers, the tool and the blob path. */
export interface PreviewSource {
  readonly text: SyntheticTextResolver
  readonly shown: number
  readonly total: number
  readonly tool: string
  readonly rawPath?: string
}

/** `output-preview` (D5 row 5). Join `"\n\n"`. */
export const OUTPUT_PREVIEW_SPEC: CoreAnnotationSpec<PreviewSource> = coreSpec({
  kind: "output-preview",
  join: "\n\n",
  attrs: (s: PreviewSource): AnnotationAttrs =>
    s.rawPath
      ? { shown: s.shown, total: s.total, tool: s.tool, path: s.rawPath }
      : { shown: s.shown, total: s.total, tool: s.tool },
  render: (s: PreviewSource): string =>
    previewTagText(s.text, {
      shown: s.shown,
      total: s.total,
      tool: s.tool,
      ...(s.rawPath ? { rawPath: s.rawPath } : {}),
    }),
})

/**
 * The preview annotation for `outcome`, or `null` when the body fits the
 * host budget. Rule V (SPEC D5, review C-1): the count reads the finalize
 * prefix (body plus the annotations so far, so the raw-output footer is
 * counted), not `body.text`. The caller checks the TR skip rules (host
 * body, diff, aborted) before the call.
 */
export function outputPreviewAnnotation(
  text: SyntheticTextResolver,
  outcome: Pick<ToolOutcome, "body" | "annotations">,
  tool: string,
  rawPath?: string,
): ToolAnnotation | null {
  const e = computeTuiElision(joinOutcome(outcome), tool)
  if (!e) return null
  return buildCoreAnnotation(OUTPUT_PREVIEW_SPEC, {
    text,
    shown: e.shown,
    total: e.total,
    tool,
    ...(rawPath ? { rawPath } : {}),
  })
}

// --- 6. policy ------------------------------------------------------------

/** Source of one `policy` annotation: one clean context line (or `""`, rule P item 2). */
export interface PolicySource {
  readonly line: string
}

/** `policy` (D5 row 6). Join `"\n"`. Same bytes as `wrapHookContext([line])`. */
export const POLICY_SPEC: CoreAnnotationSpec<PolicySource> = coreSpec({
  kind: "policy",
  join: "\n",
  attrs: (): AnnotationAttrs => ({}),
  body: (s: PolicySource): string => s.line,
  render: (s: PolicySource): string =>
    s.line === "" ? "" : `<ma::agent::policy>${s.line}</ma::agent::policy>`,
})

/**
 * The policy annotations for the lifecycle notes (SPEC D5 rule P, review C-8).
 * 1. One annotation per `cleanHookContext(notes)` line, join `"\n"`.
 * 2. When that list is empty but `notes.length > 0`, one annotation with
 *    `text: ""` (today TR adds a bare `"\n"`).
 * 3. No notes: no annotation.
 */
export function policyAnnotations(notes: readonly unknown[]): ToolAnnotation[] {
  if (notes.length === 0) return []
  const lines = cleanHookContext(notes)
  if (lines.length === 0) return [buildCoreAnnotation(POLICY_SPEC, { line: "" })]
  return lines.map((line) => buildCoreAnnotation(POLICY_SPEC, { line }))
}

// --- 7. mode-active -------------------------------------------------------

/** Source of `mode-active`: the mode id and the ISO time of the last change. */
export interface ModeStampSource {
  readonly text: SyntheticTextResolver
  readonly id: string
  readonly since: string
}

/** `mode-active` (D5 row 7). Join `"\n\n"`, `joinWhenEmpty: false`. */
export const MODE_ACTIVE_SPEC: CoreAnnotationSpec<ModeStampSource> = coreSpec({
  kind: "mode-active",
  join: "\n\n",
  joinWhenEmpty: false,
  attrs: (s: ModeStampSource): AnnotationAttrs => ({ id: s.id, since: s.since }),
  render: (s: ModeStampSource): string => modeActiveStampText(s.text, s.id, s.since),
})

/**
 * The mode stamp annotation, or `null` when no mode is active or the text is
 * `""` (today `if (modeStamp)` drops an empty stamp). The source is the same
 * as `ModeManager.buildActiveModeStamp` (`modes.ts:813-822`): the active id
 * and `(activeSince ?? now).toISOString()`.
 */
export function modeActiveAnnotation(
  text: SyntheticTextResolver,
  id: string | null,
  since: string,
): ToolAnnotation | null {
  if (id === null) return null
  const a = buildCoreAnnotation(MODE_ACTIVE_SPEC, { text, id, since })
  return a.text === "" ? null : a
}

// --- Helpers for the tool round (U3/U4) ------------------------------------

/** A new outcome with the annotations appended in order. `null` items are skipped. */
export function appendAnnotations<O extends Pick<ToolOutcome, "annotations">>(
  outcome: O,
  ...added: ReadonlyArray<ToolAnnotation | null | undefined>
): O {
  const keep = added.filter((a): a is ToolAnnotation => a != null)
  if (keep.length === 0) return outcome
  return { ...outcome, annotations: [...outcome.annotations, ...keep] }
}

/**
 * A new outcome with `body.text` replaced and all annotations removed (binary
 * placeholder and binary rewrite, SPEC D5 body table, W2-PLAN Q9).
 */
export function replaceBodyClearAnnotations<O extends Pick<ToolOutcome, "body" | "annotations">>(
  outcome: O,
  text: string,
): O {
  return { ...outcome, body: { text }, annotations: [] }
}

/**
 * The aborted "canceled" rule (SPEC D5, review C-9): set `body.text` to
 * `text` only when the finalized text is `""` (body empty and no
 * annotation text or join). Not `body.text === ""`.
 */
export function cancelWhenEmpty<O extends Pick<ToolOutcome, "body" | "annotations">>(
  outcome: O,
  text = "canceled",
): O {
  if (joinOutcome(outcome) !== "") return outcome
  return { ...outcome, body: { ...outcome.body, text } }
}
