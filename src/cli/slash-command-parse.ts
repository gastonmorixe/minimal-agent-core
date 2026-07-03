/**
 * Pure parser for slash-command lines.
 *
 * A submitted prompt is a "command line" when it begins with `/<name>` at
 * column 0, where `<name>` is a lowercase id (`[a-z0-9][a-z0-9_-]*`)
 * followed by either end-of-input or whitespace. Everything after the
 * first whitespace run is the raw argv, handed to the command handler
 * verbatim (the handler owns its own argument grammar).
 *
 * This is intentionally strict so ordinary prompts that merely contain a
 * slash are never mistaken for commands:
 *
 *   - `/usr/bin/env` → NOT a command (name is followed by `/`, not space/EOL)
 *   - `/`            → NOT a command (no name)
 *   - `path /foo`    → NOT a command (slash not at column 0)
 *   - `/loop`        → command `loop`, argv `""`
 *   - `/loop 5m ...` → command `loop`, argv `"5m ..."`
 *
 * Matching a name here does NOT mean the command exists — the host still
 * gates dispatch on the registry, so an unknown `/<name>` falls through to
 * a normal prompt. Keeping recognition (this module) separate from
 * resolution (the loader registry) is the Single-Responsibility split.
 *
 * Pure + dependency-free so it's exhaustively unit-testable.
 *
 * @module slash-command-parse
 */

/** A recognized command line, split into name + raw argv. */
export interface ParsedCommandLine {
  /** Command name without the leading slash, e.g. `"loop"`. Lowercase. */
  name: string
  /**
   * Everything after the name's trailing whitespace, trimmed. Empty
   * string when the command was invoked bare (`/loop`). May contain
   * embedded newlines for multi-line prompts (`/loop do X\nthen Y`).
   */
  argv: string
}

/**
 * `^/<name>` then either end-of-input or whitespace + the rest.
 *
 * - Group 1: the name (`[a-z0-9][a-z0-9_-]*`).
 * - Group 2: the raw argv (anything, incl. newlines), present only when a
 *   whitespace separator followed the name.
 *
 * `[\s\S]` rather than `.` so a multi-line paste is captured whole.
 */
const COMMAND_RE = /^\/([a-z0-9][a-z0-9_-]*)(?:[ \t]+([\s\S]*))?$/

/**
 * Parse a submitted line into `{name, argv}` when it is a command, else
 * `null`.
 *
 * The input is NOT pre-trimmed: a leading space before the slash means
 * "not a command" (matching shell intuition — an indented line is text).
 * A trailing newline (common from the editor) is tolerated because the
 * argv group consumes it and the result is trimmed.
 *
 * @param text - Raw submitted prompt text.
 * @returns The parsed command, or `null` when `text` is not a command line.
 */
export function parseCommandLine(text: string): ParsedCommandLine | null {
  if (text.length === 0 || text.charCodeAt(0) !== 47 /* "/" */) return null
  const m = COMMAND_RE.exec(text)
  if (!m) return null
  const name = m[1]
  if (name === undefined) return null
  const argv = (m[2] ?? "").trim()
  return { name, argv }
}

/**
 * Cheap predicate: does `text` even start like a command (`/` + a name
 * char)? Useful for overlays that want to react on every keystroke
 * without running the full regex. Does not guarantee
 * {@link parseCommandLine} will return non-null (e.g. `/usr/bin`).
 *
 * @param text - Current buffer text.
 * @returns True when `text` starts with `/` followed by a name-start char.
 */
export function looksLikeCommand(text: string): boolean {
  if (text.length < 2) return false
  if (text.charCodeAt(0) !== 47) return false
  return /[a-z0-9]/.test(text[1] ?? "")
}
