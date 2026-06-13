/**
 * ANSI color helpers and small text-formatting utilities used by the
 * agent (and re-exported from the `agent` module).
 *
 * The SGR open sequences live in `src/palette.ts` (the agent-owned
 * single source of truth, also exported to plugins via the
 * `MINIMAL_AGENT_PALETTE` env). The wrappers here just close them.
 *
 * Split out of `src/agent.ts` to keep that file under the
 * `max-lines` lint budget. The public API is unchanged: every name
 * exported here is re-exported from `agent.ts` for back-compat.
 *
 * @module agent/ansi
 */

import { PALETTE } from "../palette.ts"

const _fg = (open: string) => (s: string) => `${open}${s}\x1b[39m`
const _attr = (open: string, close: string) => (s: string) => `${open}${s}${close}`
const _combo = (open: string, close: string) => (s: string) => `${open}${s}${close}`

/**
 * Palette of ANSI-wrapped color and attribute helpers. Every entry is a
 * pure `(s: string) => string` that wraps `s` in SGR open/close codes
 * drawn from {@link PALETTE}. Composable: `c.bold(c.cyan("x"))` works
 * because each helper closes the attribute it opens.
 */
export const c = {
  dim: _attr("\x1b[2m", "\x1b[22m"),
  cyan: _fg(PALETTE.cyan),
  blue: _fg(PALETTE.blue),
  magenta: _fg(PALETTE.magenta),
  yellow: _fg(PALETTE.yellow),
  green: _fg(PALETTE.green),
  red: _fg(PALETTE.red),
  bold: _attr("\x1b[1m", "\x1b[22m"),
  italic: _attr("\x1b[3m", "\x1b[23m"),
  underline: _attr("\x1b[4m", "\x1b[24m"),
  brightCyan: _fg(PALETTE.brightCyan),
  brightYellow: _fg(PALETTE.brightYellow),
  brightGreen: _fg(PALETTE.brightGreen),
  brightRed: _fg(PALETTE.brightRed),
  brightMagenta: _fg(PALETTE.brightMagenta),
  boldCyan: _combo("\x1b[1;36m", "\x1b[22;39m"),
  boldGreen: _combo("\x1b[1;32m", "\x1b[22;39m"),
  boldRed: _combo("\x1b[1;31m", "\x1b[22;39m"),
  boldYellow: _combo("\x1b[1;33m", "\x1b[22;39m"),
  dimCyan: _combo("\x1b[2;36m", "\x1b[22;39m"),
  dimRed: _combo("\x1b[2;31m", "\x1b[22;39m"),
  faintWhite: _combo("\x1b[2;37m", "\x1b[22;39m"),
  // Strikethrough (SGR 9 / 29). Independent of bold/dim/fg, so it composes
  // with `c.dim` etc. without sharing close codes.
  strike: _attr("\x1b[9m", "\x1b[29m"),

  // Modern "Cool Summer" palette (Saturated & Powerful)
  orange: _fg(PALETTE.orange),
  pink: _fg(PALETTE.pink),
  purple: _fg(PALETTE.purple),
  lime: _fg(PALETTE.lime),
  sky: _fg(PALETTE.sky),
  violet: _fg(PALETTE.violet),
  gold: _fg(PALETTE.gold),
}

/**
 * Re-dim a thinking chunk so any embedded SGR resets don't break the
 * dim envelope. The reset sequences `\x1b[0m` / `\x1b[m` / `\x1b[22m` are
 * followed by a fresh `\x1b[2m` so the rest of the chunk stays faint.
 *
 * `\x1b[m` (empty parameter) is the same full reset as `\x1b[0m`; markdown
 * renderers emit it to close spans, and without re-asserting faint after it
 * the formatter path would lose dimness mid-block while the raw-chunk path
 * (which feeds plain text with no interior resets) stays faint throughout.
 *
 * @param s - Raw thinking text (may contain SGR sequences).
 * @returns The same content wrapped + interior-fixed for dim display.
 */
export const faintThinkingChunk = (s: string): string => {
  const trailingNewline = s.endsWith("\n")
  const body = trailingNewline ? s.slice(0, -1) : s
  if (body.length === 0) return trailingNewline ? "\n" : ""
  const redimmed = body
    .replaceAll("\x1b[0m", "\x1b[0m\x1b[2m")
    .replaceAll("\x1b[m", "\x1b[m\x1b[2m")
    .replaceAll("\x1b[22m", "\x1b[22m\x1b[2m")
  return `\x1b[2m${redimmed}\x1b[22m${trailingNewline ? "\n" : ""}`
}

/**
 * Render an "aborted prompt echo" block: a faint, struck-through
 * reproduction of the user's just-rolled-back submission, prefixed with a
 * bold-red `✘` badge and an `ABORTED` label. Replaces the old single-line
 * `⊘ aborted by user : prompt restored to editor` footer.
 *
 * The motivation: when a user aborts and re-submits, both the original
 * prompt (committed to scrollback at submit time) and the re-submitted
 * prompt look identical : bold pink `❯` followed by the same text. This
 * echo block sits between them in faint+strikethrough form so the
 * sequence reads unambiguously: "this got rolled back; the next bold
 * prompt is the one that was actually answered."
 *
 * Format:
 * ```
 *   ✘ ABORTED · ❯ <line 1, dim+strikethrough>
 *     <line 2, dim+strikethrough, indented>
 *     <line 3, dim+strikethrough, indented>
 * ```
 *
 * Mode-aware: when `activeModeLabel` is supplied (e.g. `"ASK"`) it sits
 * between the separator and the arrow, matching the live prompt's
 * `ASK ❯` shape (also dimmed):
 * ```
 *   ✘ ABORTED · ASK ❯ <text…>
 * ```
 *
 * The `✘` (U+2718 HEAVY BALLOT X) is the same glyph + bold-red treatment
 * the tasks plugin uses for canceled rows and the armed-quit footer uses
 * for the post-abort heading : one visual vocabulary across the agent
 * for "this thing got stopped." Previously this used `c.dimRed("⊘")`
 * which was a thin outline at low contrast and visually disappeared on
 * antialiased fonts.
 *
 * Pure / no IO; the caller writes the returned string (followed by `\n`)
 * to the compositor's scrollback stream.
 *
 * The per-call `opts` bag carries `activeModeLabel`: the active mode
 * label (e.g. `"ASK"`), or null/undefined for default mode. Uppercased
 * on display.
 *
 * @param text - The original user prompt text. Multi-line input is split
 *   on `\n`; each line is dimmed + strikethrough separately so terminal
 *   attribute state never leaks across line boundaries.
 * @returns Multi-line string ready to write to the scrollback stream.
 */
export function formatAbortedEcho(
  text: string,
  opts: { activeModeLabel?: string | null } = {},
): string {
  const badge = c.boldRed("✘")
  const label = c.dim("ABORTED")
  const sep = c.dim("·")
  const modeLabel = opts.activeModeLabel ? ` ${c.dim(opts.activeModeLabel.toUpperCase())}` : ""
  const arrow = c.dim("❯")
  const head = `  ${badge} ${label} ${sep}${modeLabel} ${arrow}`

  // wrap: dim + strikethrough, with both attributes opened/closed per
  // line so multi-line output never relies on terminals carrying SGR
  // state across `\n` (some don't).
  const wrap = (line: string) => c.dim(c.strike(line))

  // Strip exactly one trailing newline so a buffer like "foo\n" doesn't
  // emit a phantom empty struck row. Interior blank lines are preserved.
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text
  const lines = normalized.split("\n")
  const first = `${head} ${wrap(lines[0] ?? "")}`
  // Continuation lines: 4-space indent (2 outer + 2 inner) so they
  // visually nest under the badge rather than aligning under the content
  // of line 1 : keeps the block compact for long submissions and makes
  // the `✘ ABORTED` anchor unambiguous as the "left margin" of the echo.
  const rest = lines.slice(1).map((l) => `    ${wrap(l)}`)
  return [first, ...rest].join("\n")
}
