/**
 * Engine rules for the tool transcript preview that also change what the
 * model sees.
 *
 * - {@link TOOL_PREVIEW_LINES}: the per-tool line budget of the transcript
 *   preview. The engine uses it for the live stream cut and for the
 *   model-only `<ma::agent::output-preview>` annotation, so the model knows
 *   how much of the body the user saw.
 * - {@link computeTuiElision}: the shown/total line gap behind that
 *   annotation.
 * - {@link formatDiagnosticsAnnotation}: the model-facing
 *   `<ma::agent::diagnostics>` block.
 *
 * The host formatter (`ToolTranscriptFormatter`) styles the rows. It must
 * use the same budget, so the annotation matches the screen.
 *
 * @module agent/tool-preview-budget
 */

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

/** Cells of the `"  │ "` gutter before each body row. */
export const TOOL_PREVIEW_GUTTER_WIDTH = 4

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

/**
 * Build the model-facing `<ma::agent::diagnostics>` annotation from the
 * plugin `notes`. Returns `""` when there are no notes.
 */
export function formatDiagnosticsAnnotation(notes: string[], scope?: string): string {
  const clean = notes.filter((n) => typeof n === "string" && n.trim().length > 0)
  if (clean.length === 0) return ""
  const inner = clean.join("\n")
  const scopeAttr = scope === "ad-hoc" ? ' scope="ad-hoc"' : ""
  return `\n\n<ma::agent::diagnostics count="${clean.length}"${scopeAttr}>\n${inner}\n</ma::agent::diagnostics>`
}
