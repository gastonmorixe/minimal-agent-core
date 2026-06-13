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
