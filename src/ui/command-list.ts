/**
 * Shared renderer for one-shot CLI list commands.
 *
 * These commands are not part of the interactive live area, but they are still
 * terminal UI. Keeping their card/list chrome here avoids every command
 * re-declaring frame glyphs, spacing, colors, and output plumbing.
 *
 * @module ui/command-list
 */

import { type CommandOutput, writeCommandRows } from "./command-output.ts"
import { c } from "./style/ansi.ts"

export interface CommandListItem {
  /** Highlighted item id/name on the opening row. */
  title: string
  /** Optional body rows rendered under a `│` gutter. ANSI is preserved. */
  body?: string[]
  /** Optional closing-row text rendered dim after `╰`. */
  footer?: string
}

export interface CommandListSpec {
  title: string
  subtitle?: string
  items: CommandListItem[]
  summary?: string
}

/** Render a titled list of small framed cards. */
export function renderCommandList(spec: CommandListSpec): string[] {
  const rows = ["", `  ${c.bold(spec.title)}`]
  if (spec.subtitle) rows.push(`  ${c.dim(spec.subtitle)}`)
  rows.push("")

  for (const item of spec.items) {
    rows.push(`  ${c.dimCyan("╭")} ${c.cyan(item.title)}`)
    for (const bodyLine of item.body ?? []) {
      rows.push(bodyLine.length === 0 ? `  ${c.dimCyan("│")}` : `  ${c.dimCyan("│")} ${bodyLine}`)
    }
    rows.push(item.footer ? `  ${c.dimCyan("╰")} ${c.dim(item.footer)}` : `  ${c.dimCyan("╰")}`)
    rows.push("")
  }

  if (spec.summary) rows.push(`  ${c.dim(spec.summary)}`)
  return rows
}

/** Write rendered rows with one trailing newline. */
export function writeCommandList(
  spec: CommandListSpec,
  output: CommandOutput = process.stdout,
): void {
  writeCommandRows(renderCommandList(spec), output)
}
