/**
 * Engine rules for the host tool preview that also change what the model
 * sees.
 *
 * - {@link TOOL_PREVIEW_LINES}: the per-tool line budget of a host preview.
 *   The engine uses it for the model-only `<ma::agent::output-preview>`
 *   annotation, so the model knows how much of the body the user saw.
 * - {@link computeTuiElision}: the shown/total line gap behind that
 *   annotation.
 * - {@link formatDiagnosticsAnnotation}: the model-facing `diagnostics`
 *   block, rendered by the sideband API. {@link diagnosticsAnnotationText}
 *   gives the same tag with no leading join (SPEC v6.1 D5).
 *
 * A host that shows a preview (the CLI transcript) must use the same
 * budget, so the annotation matches the screen.
 *
 * @module agent/tool-preview-budget
 */

import { renderCoreKind } from "../sideband/core-render.ts"
import type { SidebandApi, SidebandReader } from "../sideband/types.ts"
import { countLines } from "../tools/truncation.ts"

/**
 * Per-tool body line budget for the transcript preview. These are display
 * caps, not API caps. The model still sees up to the universal
 * `MAX_TOOL_OUTPUT_LINES` per `tool_result.content`.
 */
export const TOOL_PREVIEW_LINES: Record<string, number> = {
  Bash: 10,
  Read: 15,
  Grep: 12,
  Glob: 25,
  Edit: 1000, // diff display channel; effectively unbounded
  Write: 1000,
}

/** Line budget for a tool with no {@link TOOL_PREVIEW_LINES} entry. */
export const TOOL_PREVIEW_LINES_DEFAULT = 10

/**
 * The kinds of the model-only annotations that start the cut region at the
 * end of `tool_result.content`: the old truncation and streak notices
 * (codec form `v1-text`), the preview hint, the diagnostics block and the
 * active-mode stamp. The raw-output footer and the policy lines are not in
 * the set: the line count includes them (SPEC D5 rule V).
 */
const PREVIEW_CUT_KINDS: ReadonlySet<string> = new Set([
  "output-truncated",
  "output-streak",
  "output-preview",
  "diagnostics",
  "mode-active",
])

/** The join before each annotation of {@link PREVIEW_CUT_KINDS}. */
const PREVIEW_CUT_JOIN = "\n\n"

/**
 * Index of the start of the trailing annotation region of `content` (the
 * join before the first annotation of {@link PREVIEW_CUT_KINDS} in the
 * region), or `-1` when there is none. The codec finds the region at the
 * end (`sb.trailing`: a few searches from the end, then a parse of the tail
 * only). With `NO_SIDEBAND` the result is `-1`.
 */
export function findAnnotationStart(content: string, sb: SidebandReader): number {
  for (const n of sb.trailing(content).nodes) {
    if (!PREVIEW_CUT_KINDS.has(n.kind)) continue
    const at = n.span.start - PREVIEW_CUT_JOIN.length
    if (at >= 0 && content.startsWith(PREVIEW_CUT_JOIN, at)) return at
  }
  return -1
}

/**
 * Compute the preview vs body line gap for the `<ma::agent::output-preview>`
 * annotation. Returns `null` when the body fits in the per-tool budget or
 * there is no body. Trailing annotations are removed before the count, so
 * a second application is idempotent.
 */
export function computeTuiElision(
  content: string,
  tool: string,
  sb: SidebandReader,
): { shown: number; total: number } | null {
  const idx = findAnnotationStart(content, sb)
  const body = idx >= 0 ? content.slice(0, idx) : content
  if (!body) return null
  const total = countLines(body)
  const budget = TOOL_PREVIEW_LINES[tool] ?? TOOL_PREVIEW_LINES_DEFAULT
  if (total <= budget) return null
  return { shown: budget, total }
}

/** The bytes before the `diagnostics` tag (SPEC v6.1 D5 row 3). */
export const DIAGNOSTICS_ANNOTATION_JOIN = "\n\n"

/**
 * The `diagnostics` tag text from the plugin `notes`, with no leading join.
 * `sb.render` makes the bytes (design step 6): attrs `count` (and `scope`
 * only when it is `"ad-hoc"`), body the clean notes joined with `"\n"`.
 * Returns `""` when there are no notes, or when `sb` has no codec or no
 * `diagnostics` kind ({@link renderCoreKind}). The
 * `diagnostics` annotation (SPEC v6.1 D5) uses this text with the join
 * {@link DIAGNOSTICS_ANNOTATION_JOIN}.
 */
export function diagnosticsAnnotationText(
  sb: Pick<SidebandApi, "render">,
  notes: readonly unknown[],
  scope?: string,
): string {
  const clean = diagnosticsNotes(notes)
  if (clean.length === 0) return ""
  return renderCoreKind(sb, "diagnostics", {
    attrs: scope === "ad-hoc" ? { count: clean.length, scope } : { count: clean.length },
    body: clean.join("\n"),
  })
}

/** The non-blank string notes, in order. Its length is the `count` attr. */
export function diagnosticsNotes(notes: readonly unknown[]): string[] {
  return notes.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
}

/**
 * Build the model-facing `diagnostics` annotation from the plugin `notes`,
 * with its leading join. Returns `""` when there are no notes or no codec
 * (no stray join). Same bytes as before: join + {@link diagnosticsAnnotationText}.
 */
export function formatDiagnosticsAnnotation(
  sb: Pick<SidebandApi, "render">,
  notes: string[],
  scope?: string,
): string {
  const text = diagnosticsAnnotationText(sb, notes, scope)
  return text === "" ? "" : `${DIAGNOSTICS_ANNOTATION_JOIN}${text}`
}
