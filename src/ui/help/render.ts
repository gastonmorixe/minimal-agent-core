/**
 * Shared terminal help renderer.
 *
 * Commands hand over structured rows; this module owns ANSI-aware alignment.
 * That keeps help output consistent without each command manually counting
 * escape-colored columns.
 *
 * @module ui/help/render
 */

import { displayWidth } from "../../term-width.ts"

export interface HelpRow {
  term: string
  summary: string
}

export interface HelpSection {
  title: string
  note?: string
  rows: HelpRow[]
}

export interface HelpRenderOptions {
  indent?: number
  rowIndent?: number
  gap?: number
}

/** Render a sequence of help sections with aligned row summaries. */
export function renderHelpSections(
  sections: readonly HelpSection[],
  opts: HelpRenderOptions = {},
): string[] {
  const indent = " ".repeat(opts.indent ?? 2)
  const rowIndent = " ".repeat(opts.rowIndent ?? 4)
  const gap = " ".repeat(opts.gap ?? 2)
  const lines: string[] = []

  for (const section of sections) {
    if (lines.length > 0) lines.push("")
    lines.push(`${indent}${section.title}${section.note ? ` ${section.note}` : ""}`)
    if (section.rows.length === 0) continue
    const termWidth = Math.max(...section.rows.map((row) => displayWidth(row.term)))
    for (const row of section.rows) {
      lines.push(`${rowIndent}${padVisible(row.term, termWidth)}${gap}${row.summary}`)
    }
  }

  return lines
}

/** Pad an ANSI-colored string to a target visible cell width. */
export function padVisible(text: string, width: number): string {
  const pad = Math.max(0, width - displayWidth(text))
  return `${text}${" ".repeat(pad)}`
}
