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
import type { SidebandApi } from "../sideband/types.ts"
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
 * Prefixes of the model-only annotations at the end of
 * `tool_result.content`. They stack in a fixed order, so the earliest
 * last occurrence is the start of the annotation region.
 */
const ANNOTATION_PREFIXES = [
  "\n\n[truncated:",
  "\n\n[note:",
  "\n\n<ma::agent::output-preview",
  "\n\n<ma::agent::diagnostics",
  "\n\n<ma::agent::mode-active",
] as const

/**
 * Index of the start of the trailing annotation region of `content`, or
 * `-1` when there is none.
 */
export function findAnnotationStart(content: string): number {
  let earliest = -1
  for (const p of ANNOTATION_PREFIXES) {
    const i = content.lastIndexOf(p)
    if (i >= 0 && (earliest < 0 || i < earliest)) earliest = i
  }
  return earliest
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
): { shown: number; total: number } | null {
  const idx = findAnnotationStart(content)
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
