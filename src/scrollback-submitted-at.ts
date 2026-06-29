/**
 * Locale-aware submitted-at timestamp rendering for prompt scrollback.
 *
 * Pure helpers shared by live REPL commit rendering and session replay.
 */
import { ansiStyle as c } from "@minimal-agent/plugin-api/utils/ansi"

export type SubmittedAtStyle = false | "off" | "inline-locale"

export interface SubmittedAtConfig {
  style?: SubmittedAtStyle
}

export const DEFAULT_SUBMITTED_AT_STYLE: SubmittedAtStyle = "inline-locale"

const FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
  timeStyle: "medium",
})

/** Normalize the user config value for submitted prompt timestamps. */
export function normalizeSubmittedAtStyle(value: unknown): SubmittedAtStyle | undefined {
  if (value === false || value === "off" || value === "inline-locale") return value
  return undefined
}

/** Return whether submitted prompt timestamps should be rendered. */
export function submittedAtEnabled(style: SubmittedAtStyle | undefined): boolean {
  return (style ?? DEFAULT_SUBMITTED_AT_STYLE) === "inline-locale"
}

/** Format a submitted-at timestamp using the host locale and timezone. */
export function formatSubmittedAt(at: Date): string {
  return FORMATTER.format(at)
}

/** Build the dim inline prefix placed before the prompt arrow. */
export function buildSubmittedAtPrefix(at: Date): string {
  return `${c.dim(formatSubmittedAt(at))} `
}

/** Prefix the first rendered prompt line with the submitted-at timestamp. */
export function prefixSubmittedAtLines(lines: readonly string[], at: Date): string[] {
  if (lines.length === 0) return []
  const out = lines.slice()
  out[0] = `${buildSubmittedAtPrefix(at)}${out[0]}`
  return out
}
