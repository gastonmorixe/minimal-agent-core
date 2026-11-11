/**
 * Private truncation helper for the debug request dump
 * (`src/llm/transport/debug.ts`): the `...(+N<unit>)` dialect.
 *
 * Not public. The CLI owns the terminal copy of `truncHint`
 * (`minimal-agent-cli/src/ui/style/truncate-hint.ts`). Keep the two
 * idioms in step so a user sees the same shape in a debug `messages:`
 * dump and in a tool transcript header.
 *
 * Design notes:
 *
 *  - **No color in here.** Callers wrap the composed string in `c.dim`,
 *    `c.red`, etc. Returning bare characters avoids ANSI nesting bugs
 *    where an inner reset (`\x1b[22m`) would prematurely close an outer
 *    dim wrapper.
 *
 *  - **Distinct from `src/tools/truncation.ts`.** That module produces a
 *    structured `[truncated: shown N of M bytes, ...]` notice that goes
 *    back to the *model* as a resume hint. This module is for *humans*
 *    looking at the TUI.
 *
 *  - **Unit codes** are deliberately terse to keep the hint short:
 *      `ch` = characters
 *      `B`  = bytes
 *      `L`  = lines
 *    Add new units sparingly — every new code is a small cognitive tax
 *    on users skimming the transcript.
 */

/** Unit suffix appended after the elided count. See module docs. */
export type TruncUnit = "ch" | "B" | "L"

/**
 * Compact "how much was elided" suffix, e.g. `...(+312ch)` or `...(+4L)`.
 *
 * Returns the empty string when `n <= 0` so callers can do
 * `body + truncHint(remaining)` without guarding the zero case.
 */
function truncHint(n: number, unit: TruncUnit = "ch"): string {
  if (n <= 0) return ""
  return `...(+${n}${unit})`
}

/**
 * Slice `s` to `max` characters and append a `truncHint` describing
 * how many characters were cut. Returns `s` unchanged when it already
 * fits.
 *
 * This is the shared implementation behind client.ts's `truncate()`
 * (which additionally honors `--verbose` and `--show-hidden-chars`)
 * and any other call site that needs a one-shot string clamp with
 * a visible elision marker.
 */
export function clampWithHint(s: string, max: number, unit: TruncUnit = "ch"): string {
  if (s.length <= max) return s
  return s.slice(0, max) + truncHint(s.length - max, unit)
}
