/**
 * Locale-aware submitted-at timestamp rendering for prompt scrollback.
 *
 * The TUI prefixes each submitted prompt with a dim wall-clock stamp so
 * the user can glance at when a turn was sent:
 *
 *     `6/30/26 7:28:44 PM ❯ [prompt]`
 *
 * The stamp is assembled from two standalone `Intl.DateTimeFormat` formatters
 * (one for the short date, one for the medium time) instead of a single
 * formatter with both `dateStyle` and `timeStyle`. A combined formatter
 * inserts a separator between the two halves that is locale-dependent and
 * almost always a comma in en-US (`6/30/26, 7:28:44 PM`). Splitting the
 * formatters lets us join the halves with a plain space, which is the
 * spacing the user asked for.
 *
 * Pure helpers shared by the live REPL (commit rendering) and session
 * replay, so both paths render byte-identical stamps.
 *
 * @module scrollback-submitted-at
 */
import { ansiStyle as c } from "@minimal-agent/plugin-api/utils/ansi"

/**
 * Configured rendering style for submitted prompt timestamps.
 *
 * - `"inline-locale"` — dim stamp prefix before the prompt arrow (default).
 * - `"off"` / `false` — no stamp rendered.
 */
export type SubmittedAtStyle = false | "off" | "inline-locale"

/** Optional config shape for the submitted-at feature. */
export interface SubmittedAtConfig {
  style?: SubmittedAtStyle
}

/** Style applied when the user leaves the option unset. */
export const DEFAULT_SUBMITTED_AT_STYLE: SubmittedAtStyle = "inline-locale"

/**
 * Short-date formatter (e.g. `6/30/26`). Locale and timezone are inherited
 * from the host runtime, so the stamp matches what the user sees in their
 * menu bar.
 */
const DATE_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "short",
})

/**
 * Medium-time formatter (e.g. `7:28:44 PM`). Kept separate from
 * {@link DATE_FORMATTER} so we control the join character ourselves.
 */
const TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  timeStyle: "medium",
})

/**
 * Normalize the raw user config value for submitted prompt timestamps.
 *
 * Returns the value when it matches one of the accepted literals, otherwise
 * `undefined` so the caller falls back to the default. Never throws.
 */
export function normalizeSubmittedAtStyle(value: unknown): SubmittedAtStyle | undefined {
  if (value === false || value === "off" || value === "inline-locale") return value
  return undefined
}

/**
 * Return whether submitted prompt timestamps should be rendered at all.
 *
 * Treats an unset (`undefined`) style as the default, so callers can pass
 * the raw config value straight through.
 */
export function submittedAtEnabled(style: SubmittedAtStyle | undefined): boolean {
  return (style ?? DEFAULT_SUBMITTED_AT_STYLE) === "inline-locale"
}

/**
 * Format a submitted-at timestamp using the host locale and timezone.
 *
 * Joins the short date and medium time with a single space. Combining both
 * styles in one `Intl.DateTimeFormat` would insert `, ` between the halves
 * in en-US; splitting the formatters avoids that and gives
 * `6/30/26 7:28:44 PM` instead of `6/30/26, 7:28:44 PM`.
 */
export function formatSubmittedAt(at: Date): string {
  return `${DATE_FORMATTER.format(at)} ${TIME_FORMATTER.format(at)}`
}

/**
 * Build the dim inline prefix placed before the prompt arrow.
 *
 * Returns the formatted stamp wrapped in a dim SGR sequence and trailed by
 * a single space, e.g. `\e[2m6/30/26 7:28:44 PM\e[22m `. Callers just
 * prepend this to the first rendered prompt line.
 */
export function buildSubmittedAtPrefix(at: Date): string {
  return `${c.dim(formatSubmittedAt(at))} `
}

/**
 * Prefix the first rendered prompt line with the submitted-at timestamp.
 *
 * Returns a shallow copy so the caller's array is not mutated. An empty
 * input returns an empty array (no stamp on zero lines).
 */
export function prefixSubmittedAtLines(lines: readonly string[], at: Date): string[] {
  if (lines.length === 0) return []
  const out = lines.slice()
  out[0] = `${buildSubmittedAtPrefix(at)}${out[0]}`
  return out
}
