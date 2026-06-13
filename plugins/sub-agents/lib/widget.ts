/**
 * The live fleet widget — a multi-line string the supervisor heartbeat returns
 * for the sticky bottom live area. One header row, up to `maxRows` worker rows,
 * a `+N more` overflow line. The running glyph cycles by `tick` so the panel
 * visibly breathes; the widget collapses to `null` (zero footprint) when no
 * worker is active, so a single-agent session looks exactly as it does today.
 *
 * Pure: takes records + render options, returns a string or null. The core
 * multi-row live-area seam (split a slot value on `"\n"`) makes this paint.
 *
 * @module sub-agents/lib/widget
 */

import { ANSI, color, fmtElapsed, fmtTokens, GLYPHS, SPINNER } from "./style.ts"
import { fleetStats, type SubagentRecord, type SubagentStatus } from "./types.ts"

/** Options for {@link renderWidget}. */
export interface WidgetOptions {
  readonly ansi: boolean
  /** Monotonic tick (drives the breathing spinner). */
  readonly tick: number
  /** Epoch ms (for elapsed times). */
  readonly nowMs: number
  /** The lead session id (its first 4 chars label the fleet). */
  readonly leadSid: string
  /** Max worker rows before the `+N more` overflow line. Default 6. */
  readonly maxRows?: number
  /** Token total above which the fleet total is painted GOLD (cost warning). */
  readonly tokenBudget?: number
}

function shortSid(sid: string): string {
  return sid.replace(/-/g, "").slice(0, 4)
}

/** The "what is it doing / what did it do" trailing column for one row. */
function rowDetail(r: SubagentRecord, ansi: boolean): string {
  const s = r.status
  switch (s.kind) {
    case "running": {
      const act = (s.progress.lastActivity ?? s.progress.lastTool ?? "working")
        .replace(/\s+/g, " ")
        .trim()
      const tools = color(ansi, ANSI.DGRAY, `${s.progress.tools} tools`)
      const tok = color(ansi, ANSI.DGRAY, fmtTokens(s.progress.tokens))
      const dot = color(ansi, ANSI.DGRAY, GLYPHS.bullet)
      return `${clip(act, 40)} ${dot} ${tools} ${dot} ${tok}`
    }
    case "done": {
      const arrow = color(ansi, ANSI.DGRAY, "→")
      return `${color(ansi, ANSI.DIM, clip(s.result.short, 38))} ${arrow} ${color(ansi, ANSI.LGRAY, `AgentResult ${r.id}`)}`
    }
    case "incomplete":
      return color(ansi, ANSI.GOLD, `⚠ no deliverable · ${clip(s.reason, 34)}`)
    case "failed":
      return color(ansi, ANSI.RED, clip(s.error, 48))
    case "stopped":
      return color(ansi, ANSI.DIM, s.reason ? clip(s.reason, 48) : "stopped")
    case "queued":
      return color(ansi, ANSI.DIM, "queued…")
    default: {
      throw new Error(`unhandled status kind: ${String(s satisfies never)}`)
    }
  }
}

function elapsedFor(r: SubagentRecord, nowMs: number): string {
  const s = r.status
  if (s.kind === "running") return fmtElapsed(nowMs - Date.parse(s.startedAt))
  if (s.kind === "done" || s.kind === "failed" || s.kind === "stopped")
    return s.kind === "done" ? "done" : ""
  return ""
}

function spinFor(s: SubagentStatus, tick: number, ansi: boolean): string {
  if (s.kind === "running")
    return color(ansi, ANSI.SKY, SPINNER[tick % SPINNER.length] ?? GLYPHS.running)
  if (s.kind === "done") return color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, GLYPHS.done)
  if (s.kind === "incomplete") return color(ansi, `${ANSI.GOLD}${ANSI.BOLD}`, GLYPHS.incomplete)
  if (s.kind === "queued") return color(ansi, ANSI.DIM, GLYPHS.queued)
  return color(ansi, `${ANSI.RED}${ANSI.BOLD}`, GLYPHS.failed)
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

/** Sort key so the widget shows running first, then queued, then most-recent terminal. */
function rowRank(s: SubagentStatus): number {
  switch (s.kind) {
    case "running":
      return 0
    case "queued":
      return 1
    case "failed":
      return 2
    case "incomplete":
      return 3
    case "done":
      return 4
    case "stopped":
      return 5
    default: {
      throw new Error(`unhandled status kind: ${String(s satisfies never)}`)
    }
  }
}

/**
 * Render the fleet widget, or `null` when no worker is active (queued or
 * running) — the fleet is done, so the sticky area collapses to nothing.
 */
export function renderWidget(
  records: readonly SubagentRecord[],
  opts: WidgetOptions,
): string | null {
  const stats = fleetStats(records)
  const active = stats.queued + stats.running
  if (active === 0) return null

  const ansi = opts.ansi
  const maxRows = opts.maxRows ?? 6
  const dot = color(ansi, ANSI.DGRAY, GLYPHS.bullet)

  // Header: ◈ fleet <sid> · ◐ R · ✔ D · ⚠ I · ✘ F · <tok> tok
  const brand = color(ansi, `${ANSI.SKY}${ANSI.BOLD}`, GLYPHS.brand)
  const fleetLabel = color(ansi, ANSI.LGRAY, `fleet ${shortSid(opts.leadSid)}`)
  const run = `${color(ansi, ANSI.SKY, GLYPHS.running)} ${color(ansi, ANSI.SKY, String(stats.running))}`
  const done = `${color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, GLYPHS.done)} ${color(ansi, ANSI.LIME, String(stats.done))}`
  const fail = `${color(ansi, `${ANSI.RED}${ANSI.BOLD}`, GLYPHS.failed)} ${color(ansi, ANSI.RED, String(stats.failed))}`
  // Incomplete count: shown only when non-zero so a clean fleet stays uncluttered.
  const inc =
    stats.incomplete > 0
      ? ` ${dot} ${color(ansi, `${ANSI.GOLD}${ANSI.BOLD}`, GLYPHS.incomplete)} ${color(ansi, ANSI.GOLD, String(stats.incomplete))}`
      : ""
  const overBudget = opts.tokenBudget !== undefined && stats.tokens > opts.tokenBudget
  const tok = color(ansi, overBudget ? ANSI.GOLD : ANSI.DGRAY, `${fmtTokens(stats.tokens)} tok`)
  const header = ` ${brand} ${fleetLabel} ${dot} ${run} ${dot} ${done}${inc} ${dot} ${fail} ${dot} ${tok}`

  // Rows, ranked; cap at maxRows.
  const ordered = [...records].sort((a, b) => rowRank(a.status) - rowRank(b.status))
  const shown = ordered.slice(0, maxRows)
  const lines = [header]
  for (const r of shown) {
    const spin = spinFor(r.status, opts.tick, ansi)
    const id = color(ansi, ANSI.BOLD, r.id.padEnd(3))
    const label = color(ansi, ANSI.LGRAY, r.label.padEnd(9).slice(0, 9))
    const el = color(ansi, ANSI.DGRAY, elapsedFor(r, opts.nowMs).padStart(5))
    const detail = rowDetail(r, ansi)
    lines.push(`   ${spin} ${id} ${label} ${el}  ${detail}`)
  }
  if (ordered.length > shown.length) {
    const more = ordered.length - shown.length
    lines.push(color(ansi, ANSI.DGRAY, `   … +${more} more ${GLYPHS.bullet} ListAgents for all`))
  }
  return lines.join("\n")
}
