/**
 * Host-owned rendering for plugin command notices.
 *
 * Plugins may return semantic {@link CommandNoticeBlock} data from a slash
 * command; this module turns that data into scrollback rows using the agent's
 * TUI chrome. Legacy `notice.lines` remains supported by the command handler
 * path, but framed boxes should use this renderer so plugins do not copy host
 * frame glyphs or color policy.
 *
 * @module ui/command-notice
 */

import type { CommandNoticeBlock } from "@minimal-agent/plugin-api/types/plugin"

import { displayWidth, wordWrap } from "../term-width.ts"

import { c } from "./style/ansi.ts"

/**
 * Cells the `"  │ "` gutter consumes on every body row (2 lead spaces + glyph +
 * 1 space). Mirrors the tool-transcript renderer's gutter accounting so a
 * framed notice wraps to the same inner width as a tool-result block.
 */
const NOTICE_GUTTER_WIDTH = 4
/** Leave one column free at the right edge (wide-glyph off-by-one guard). */
const NOTICE_WRAP_SAFETY = 1

/** Hard caps so a malformed / hostile bus payload can't flood scrollback. */
const MAX_BODY_ROWS = 200
const MAX_ROW_LEN = 4_000

/**
 * Coerce an untrusted bus payload into a {@link CommandNoticeBlock}, or `null`
 * when it can't be salvaged. Used by the host's `notification.emit` listener:
 * the `block` field arrives from a plugin over the fire-and-forget EventBus,
 * so we validate shape and clamp sizes before handing it to the frame
 * renderer. We do NOT re-escape `body` rows: by contract the plugin already
 * produced human-facing, ANSI-styled, terminal-safe lines (the model-facing
 * declaw lives on the plugin's separate inbox-attachment path, not here).
 */
export function coerceNoticeBlock(input: unknown): CommandNoticeBlock | null {
  if (!input || typeof input !== "object") return null
  const o = input as Record<string, unknown>
  const title = typeof o.title === "string" ? o.title.trim() : ""
  if (title.length === 0) return null
  const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)
  const clampRow = (s: string): string => (s.length > MAX_ROW_LEN ? s.slice(0, MAX_ROW_LEN) : s)
  const body = Array.isArray(o.body)
    ? o.body
        .filter((r): r is string => typeof r === "string")
        .slice(0, MAX_BODY_ROWS)
        .map(clampRow)
    : undefined
  return {
    title: clampRow(title),
    icon: str(o.icon),
    info: str(o.info),
    timestamp: str(o.timestamp),
    color: str(o.color),
    footer: str(o.footer),
    ...(body ? { body } : {}),
  }
}

function colorize(color: string | undefined): (s: string) => string {
  if (color && (c as Record<string, (s: string) => string>)[color]) {
    return (c as Record<string, (s: string) => string>)[color]
  }
  return c.gold
}

/**
 * Inner body width for a notice frame at terminal `cols`, or `undefined` when
 * width is unknown (non-TTY / tests) so callers fall back to no-wrap. Accounts
 * for the `"  │ "` gutter and a 1-cell right-edge safety margin.
 */
function noticeBodyWidth(cols: number | undefined): number | undefined {
  const raw = cols ?? process.stdout.columns
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined
  const max = Math.floor(raw) - NOTICE_GUTTER_WIDTH - NOTICE_WRAP_SAFETY
  return max > 0 ? max : undefined
}

/**
 * Render a semantic command notice block into scrollback lines.
 *
 * When `cols` is given (the live terminal width), body rows are word-wrapped to
 * the inner frame width and EACH fragment gets its own `│ ` gutter, mirroring
 * the tool-transcript renderer. Without this a body line wider than the
 * terminal hard-wraps at the terminal level into a gutterless orphan row,
 * tearing the frame (the intercom-toast tear, only visible at narrow widths).
 * Omitting `cols` preserves the legacy no-wrap behavior for tests / non-TTY.
 */
export function renderCommandNoticeBlock(block: CommandNoticeBlock, cols?: number): string[] {
  const accent = colorize(block.color)
  const icon = block.icon ? `${c.bold(accent(block.icon))} ` : ""
  const title = c.bold(accent(block.title))
  const info = block.info ? `  ${c.dim(block.info)}` : ""
  const timestamp = block.timestamp ? `  ${c.dim(block.timestamp)}` : ""
  const rows = [`  ${c.dimCyan("╭")} ${icon}${title}${info}${timestamp}`]

  const body = block.body ?? []
  if (body.length > 0) {
    const width = noticeBodyWidth(cols)
    rows.push(`  ${c.dimCyan("│")}`)
    for (const line of body) {
      if (line.length === 0) {
        rows.push(`  ${c.dimCyan("│")}`)
        continue
      }
      // Wrap to the inner width so a long line never reaches the terminal's
      // own wrap (which would drop the gutter). wordWrap is ANSI-aware and
      // hard-breaks a single token longer than the width. No width signal:
      // emit verbatim (legacy behavior).
      const frags =
        width !== undefined && displayWidth(line) > width ? wordWrap(line, width) : [line]
      for (const frag of frags) rows.push(`  ${c.dimCyan("│")} ${frag}`)
    }
    rows.push(`  ${c.dimCyan("│")}`)
  }

  rows.push(block.footer ? `  ${c.dimCyan("╰")} ${c.dim(block.footer)}` : `  ${c.dimCyan("╰")}`)
  return rows
}
