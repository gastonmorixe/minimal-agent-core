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

export function normalizeSubmittedAtStyle(value: unknown): SubmittedAtStyle | undefined {
  if (value === false || value === "off" || value === "inline-locale") return value
  return undefined
}

export function submittedAtEnabled(style: SubmittedAtStyle | undefined): boolean {
  return (style ?? DEFAULT_SUBMITTED_AT_STYLE) === "inline-locale"
}

export function formatSubmittedAt(at: Date): string {
  return FORMATTER.format(at)
}

export function buildSubmittedAtPrefix(at: Date): string {
  return `${c.dim(formatSubmittedAt(at))} `
}

export function prefixSubmittedAtLines(lines: readonly string[], at: Date): string[] {
  if (lines.length === 0) return []
  const out = lines.slice()
  out[0] = `${buildSubmittedAtPrefix(at)}${out[0]}`
  return out
}
