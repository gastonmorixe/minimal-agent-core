/**
 * Shared glyphs + palette for the sub-agents TUI (scrollback blocks and the
 * live fleet widget). Pure monochrome unicode (no nerd-font, no color-emoji),
 * matching the `tasks` plugin so a worker and a task read as one visual
 * language. See `private/subagent-research-and-plan/TUI.md`.
 *
 * @module sub-agents/lib/style
 */

import type { SubagentStatus } from "./types.ts"

/** Glyphs. Status glyphs are intentionally shared with the `tasks` plugin. */
export const GLYPHS = {
  brand: "◈", // U+25C8 sub-agents identity (distinct from tasks' ○)
  queued: "○", // U+25CB
  running: "◐", // U+25D0  (the widget cycles ◐◓◑◒ for a pulse)
  done: "✔", // U+2714
  incomplete: "⚠", // U+26A0  clean exit but no deliverable captured
  failed: "✘", // U+2718
  spawn: "↗", // U+2197  delegation arrow
  report: "↘", // U+2198  result-came-back arrow
  frameTL: "╭",
  frameML: "│",
  frameBL: "╰",
  bullet: "·",
} as const

/** Frames of the running spinner, cycled by tick for the live widget. */
export const SPINNER = ["◐", "◓", "◑", "◒"] as const

export const ANSI = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  LIME: "\x1b[38;5;118m", // done
  SKY: "\x1b[38;5;45m", // running
  RED: "\x1b[31m", // failed
  GOLD: "\x1b[38;5;214m", // spawn / cost-over-budget
  DGRAY: "\x1b[38;5;240m", // frame chrome
  LGRAY: "\x1b[38;5;246m", // secondary chrome
} as const

/** Wrap `text` in ANSI codes when `ansi` is true; identity otherwise. */
export function color(ansi: boolean, codes: string, text: string): string {
  return ansi ? `${codes}${text}${ANSI.RESET}` : text
}

/** The status glyph for a worker, colored by state. */
export function statusGlyph(s: SubagentStatus, ansi: boolean): string {
  switch (s.kind) {
    case "queued":
      return color(ansi, ANSI.DIM, GLYPHS.queued)
    case "running":
      return color(ansi, ANSI.SKY, GLYPHS.running)
    case "done":
      return color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, GLYPHS.done)
    case "incomplete":
      return color(ansi, `${ANSI.GOLD}${ANSI.BOLD}`, GLYPHS.incomplete)
    case "failed":
      return color(ansi, `${ANSI.RED}${ANSI.BOLD}`, GLYPHS.failed)
    case "stopped":
      return color(ansi, `${ANSI.RED}${ANSI.BOLD}`, GLYPHS.failed)
    default: {
      const _exhaustive: never = s
      throw new Error(`unhandled status kind: ${String(_exhaustive)}`)
    }
  }
}

/** A one-word status label colored by state (for headers/rows). */
export function statusLabel(s: SubagentStatus, ansi: boolean): string {
  switch (s.kind) {
    case "queued":
      return color(ansi, ANSI.DIM, "queued")
    case "running":
      return color(ansi, ANSI.SKY, "running")
    case "done":
      return color(ansi, ANSI.LIME, "done")
    case "incomplete":
      return color(ansi, ANSI.GOLD, "incomplete")
    case "failed":
      return color(ansi, ANSI.RED, "failed")
    case "stopped":
      return color(ansi, ANSI.RED, "stopped")
    default: {
      const _exhaustive: never = s
      throw new Error(`unhandled status kind: ${String(_exhaustive)}`)
    }
  }
}

/** Format a token count compactly: 950 → "950", 9100 → "9.1k", 612000 → "612k". */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return `${Math.round(n / 1000)}k`
}

/** Format an elapsed-ms duration: "0m31", "1m22", "1h04". Empty under 1s. */
export function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return ""
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, "0")}`
}
