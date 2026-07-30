/**
 * Print-format for one-shot inspection commands (`models`, `providers`, …).
 *
 * Distinct from `--format` (generic-endpoint **wire surface**) and from
 * `--output-format` (non-interactive agent answer stream). Inspection
 * commands should emit structured data through this channel so TUI /
 * stdout / JSON / Markdown stay swapable without importing each other.
 *
 * Default `text` preserves today's console table. Task 4 expands renderers
 * and migrates other list commands onto the same seam.
 *
 * @module cli/print-format
 */

export type PrintFormat = "text" | "json" | "md" | "xml"

const PRINT_FORMATS = new Set<PrintFormat>(["text", "json", "md", "xml"])

/** Parse a CLI/env print-format token; unknown values fall back to `text`. */
export function parsePrintFormat(raw: string | undefined): PrintFormat {
  if (!raw) return "text"
  const normalized = raw.trim().toLowerCase()
  // Common aliases for the default console/TUI surface.
  if (normalized === "tui" || normalized === "console" || normalized === "stdout") return "text"
  if (PRINT_FORMATS.has(normalized as PrintFormat)) return normalized as PrintFormat
  return "text"
}

/** True when the format is a structured document (not the human table). */
export function isStructuredPrintFormat(format: PrintFormat): boolean {
  return format !== "text"
}
