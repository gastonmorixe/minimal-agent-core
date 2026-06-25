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

import { c } from "./style/ansi.ts"

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

/** Render a semantic command notice block into scrollback lines. */
export function renderCommandNoticeBlock(block: CommandNoticeBlock): string[] {
  const accent = colorize(block.color)
  const icon = block.icon ? `${c.bold(accent(block.icon))} ` : ""
  const title = c.bold(accent(block.title))
  const info = block.info ? `  ${c.dim(block.info)}` : ""
  const timestamp = block.timestamp ? `  ${c.dim(block.timestamp)}` : ""
  const rows = [`  ${c.dimCyan("╭")} ${icon}${title}${info}${timestamp}`]

  const body = block.body ?? []
  if (body.length > 0) {
    rows.push(`  ${c.dimCyan("│")}`)
    for (const line of body)
      rows.push(line.length === 0 ? `  ${c.dimCyan("│")}` : `  ${c.dimCyan("│")} ${line}`)
    rows.push(`  ${c.dimCyan("│")}`)
  }

  rows.push(block.footer ? `  ${c.dimCyan("╰")} ${c.dim(block.footer)}` : `  ${c.dimCyan("╰")}`)
  return rows
}
