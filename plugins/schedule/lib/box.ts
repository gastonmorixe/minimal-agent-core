/**
 * Colored box renderer for the schedule plugin's TUI surfaces.
 *
 * Commands (`/loop`, `/schedule`) can only return `{ kind:"notice", lines }`,
 * and the host writes those lines to scrollback VERBATIM (ANSI preserved). So
 * to make a command render in the same rounded box the host draws around tool
 * calls, we build that chrome ourselves here as raw ANSI and hand it back as
 * `lines`. The shape mirrors `src/agent/tool-format.ts` exactly so a `/loop`
 * confirmation is indistinguishable from a `CronCreate` tool box:
 *
 *   ╭─ ⟳ loop  every 10s · next in 8s            16:14:02
 *   │
 *   │  find economic news important to the markets and make a brief
 *   │
 *   ╰─ v3muss8a · expires in 7d · cancel /schedule cancel v3muss8a
 *
 * Chrome rules (copied from the host so the two never drift):
 *   - opening `╭─` is DIM, the body `│` and closing `╰─` carry the box COLOR,
 *   - the icon + title are bold + color, the header tail + footer are dim,
 *   - one blank gutter line pads above/below the body for breathing room.
 *
 * TUI-only: this emits ANSI, so it must never feed a model-facing tool-result
 * `content` field. The pure (ANSI-free) helpers live in ./format.ts.
 *
 * @module schedule/lib/box
 */

import { PALETTE } from "@minimal-agent/plugin-api/utils/palette"

import { cadenceLabel, clipPrompt, kindGlyph, relativeTime } from "./format.ts"
import { nextFireMs } from "./scheduler.ts"
import type { CronEntry } from "./store.ts"

const RESET = "\x1b[0m"
const DIM = "\x1b[2m"
const BOLD = "\x1b[1m"

/** A named box color → its SGR open string. Defaults to gold. */
export type BoxColor = "gold" | "lime" | "sky" | "red"
function sgr(color: BoxColor): string {
  return PALETTE[color] ?? PALETTE.gold
}

const dim = (s: string) => `${DIM}${s}${RESET}`

export interface BoxSpec {
  /** Leading glyph (e.g. `⟳` or `⧗`). Rendered bold + color. */
  icon: string
  /** Box title (e.g. `loop`, `schedule`). Rendered bold + color. */
  title: string
  /** Dim header tail after the title (e.g. `every 10s · next in 8s`). */
  info?: string
  /** Dim, trailing on the header line (e.g. a `HH:MM:SS` stamp). */
  timestamp?: string
  /** Body content lines (rendered as-is; may contain their own ANSI). */
  body: string[]
  /** Dim footer text after the closing `╰─`. */
  footer?: string
  /** Box color for the gutter + icon + title. Default `gold`. */
  color?: BoxColor
}

/**
 * Render a {@link BoxSpec} into colored scrollback lines (no trailing newline;
 * the caller joins with `\n`). Matches the host tool-box chrome so a command
 * box and a tool box look identical.
 */
export function renderBox(spec: BoxSpec): string[] {
  const color = sgr(spec.color ?? "gold")
  const gut = `${color}│${RESET}` // body gutter, colored
  const lines: string[] = []

  // Header: dim ╭─, bold+color icon + title, dim info, dim timestamp.
  const head =
    `${dim("╭─")} ${BOLD}${color}${spec.icon}${RESET} ${BOLD}${color}${spec.title}${RESET}` +
    (spec.info ? `  ${dim(spec.info)}` : "") +
    (spec.timestamp ? `  ${dim(spec.timestamp)}` : "")
  lines.push(head)

  // Body, padded with one blank gutter line above + below for breathing room.
  if (spec.body.length > 0) {
    lines.push(gut)
    for (const b of spec.body) lines.push(`${gut} ${b}`)
    lines.push(gut)
  }

  // Footer: colored ╰─ + dim text (or a bare closing corner).
  lines.push(spec.footer ? `${color}╰─${RESET} ${dim(spec.footer)}` : `${color}╰─${RESET}`)
  return lines
}

/**
 * One colored task row for a `/schedule list` body: bold gold kind glyph, dim
 * id, the cadence, a dim relative next-fire, and a dim clipped prompt. The
 * glyph (⟳ recurring / ⧗ one-shot) is the focal point.
 */
export function coloredEntryLine(e: CronEntry, now: number): string {
  const next = nextFireMs(e, now)
  const when = next === null ? "—" : relativeTime(next, now)
  const glyph = `${BOLD}${PALETTE.gold}${kindGlyph(e)}${RESET}`
  return (
    `${glyph} ${dim(e.id)}  ${cadenceLabel(e)}  ${dim(`(${when})`)}  ` + dim(clipPrompt(e.prompt))
  )
}
