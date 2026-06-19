/**
 * Scrollback tool-block renderers for the sub-agents tools. Each returns the
 * `{header, body, footer}` content slots the host frames with `╭ ◈ <Tool> …`
 * chrome (the `TUIResult.displayHeader` / `display` / `displayFooter`
 * contract). House palette + glyphs, shared with the `tasks` plugin.
 *
 * Pure. ANSI on/off via the `ansi` flag for testability.
 *
 * @module sub-agents/lib/render
 */

import { ANSI, color, fmtElapsed, fmtTokens, GLYPHS, statusGlyph, statusLabel } from "./style.ts"
import { fleetStats, type SubagentRecord } from "./types.ts"

/** The `{header, body, footer}` slots a tool result fills. */
export interface DisplayParts {
  readonly header: string
  readonly body: string
  readonly footer: string
}

/** Shorten a model id to its tier word when possible: `claude-sonnet-4-6` → `sonnet`. */
export function shortModel(model: string): string {
  const m = model.toLowerCase()
  for (const tier of ["opus", "sonnet", "haiku", "fable"]) {
    if (m.includes(tier)) return tier
  }
  return model
}

function shortSid(sid: string): string {
  return sid.replace(/-/g, "").slice(0, 6)
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max - 1).trimEnd()}…`
}

/**
 * Trim and line-cap a spawn task for the transcript display block.
 *
 * Each line's whitespace runs are collapsed to single spaces, but newlines
 * are PRESERVED so the task's paragraph / list structure survives. Leading
 * and trailing blank lines are dropped. When the line count exceeds
 * `maxLines` the excess is replaced with a `… +N more lines` marker row.
 *
 * The compositor's display channel ({@link formatToolPreview}) handles
 * per-line width clamping via {@link clampBodyWithHint} with the live
 * terminal width, so this function intentionally does NOT cap individual
 * line length.
 */
function clipTask(s: string, maxLines: number): string {
  const raw = s.split("\n")
  // Collapse in-line whitespace (preserve newlines).
  const clean = raw.map((l) => l.replace(/[ \t]+/g, " ").trim())
  // Drop leading/trailing blank lines.
  let start = 0
  while (start < clean.length && clean[start].length === 0) start++
  let end = clean.length
  while (end > start && clean[end - 1].length === 0) end--
  const trimmed = clean.slice(start, end)
  if (trimmed.length <= maxLines) return trimmed.join("\n")
  const visible = trimmed.slice(0, maxLines)
  const elided = trimmed.length - maxLines
  return `${visible.join("\n")}\n… +${elided} more lines`
}

// ---------------------------------------------------------------------------
// SpawnAgent
// ---------------------------------------------------------------------------

/** Header content for a SpawnAgent result: `↗ A2 · worker · sonnet · fork`. */
export function renderSpawnHeader(r: SubagentRecord, ansi: boolean): string {
  const dot = color(ansi, ANSI.DIM, GLYPHS.bullet)
  const arrow = color(ansi, ANSI.GOLD, GLYPHS.spawn)
  const id = color(ansi, `${ANSI.GOLD}${ANSI.BOLD}`, r.id)
  const type = color(ansi, ANSI.LGRAY, r.label)
  const model = color(ansi, ANSI.DIM, shortModel(r.model))
  const iso = color(ansi, ANSI.DIM, r.isolation)
  return `${arrow} ${id} ${dot} ${type} ${dot} ${model} ${dot} ${iso}`
}

/** Full SpawnAgent display: intent line + the background handle footer. */
export function renderSpawnDisplay(r: SubagentRecord, ansi: boolean): DisplayParts {
  const pid = r.status.kind === "running" ? r.status.pid : undefined
  const footerBits = [
    color(ansi, ANSI.SKY, "running in background"),
    ...(pid !== undefined ? [color(ansi, ANSI.DIM, `pid ${pid}`)] : []),
    color(ansi, ANSI.DIM, `session ${shortSid(r.sid)}…`),
  ]
  const dot = color(ansi, ANSI.DIM, GLYPHS.bullet)
  return {
    header: renderSpawnHeader(r, ansi),
    body: color(ansi, ANSI.DIM, clipTask(r.task, 20)),
    footer: ` ${footerBits.join(` ${dot} `)}`,
  }
}

// ---------------------------------------------------------------------------
// ListAgents (fleet snapshot)
// ---------------------------------------------------------------------------

function fleetRow(r: SubagentRecord, ansi: boolean, nowMs: number): string {
  const id = color(ansi, ANSI.BOLD, r.id.padEnd(3))
  const glyph = statusGlyph(r.status, ansi)
  const label = color(ansi, ANSI.LGRAY, r.label.padEnd(9).slice(0, 9))
  const st = statusLabel(r.status, ansi).padEnd(8)
  let trail = ""
  const s = r.status
  if (s.kind === "running") {
    const el = fmtElapsed(nowMs - Date.parse(s.startedAt))
    trail = `${el}  ${color(ansi, ANSI.DGRAY, `${s.progress.tools} tools ${GLYPHS.bullet} ${fmtTokens(s.progress.tokens)}`)}`
  } else if (s.kind === "done") {
    trail = `${color(ansi, ANSI.DIM, clip(s.result.short, 28))} ${color(ansi, ANSI.DGRAY, "→")} ${color(ansi, ANSI.LGRAY, `AgentResult ${r.id}`)}`
  } else if (s.kind === "incomplete") {
    trail = color(ansi, ANSI.GOLD, `⚠ no deliverable · ${clip(s.reason, 30)}`)
  } else if (s.kind === "failed") {
    trail = color(ansi, ANSI.RED, clip(s.error, 36))
  } else if (s.kind === "stopped") {
    trail = color(ansi, ANSI.DIM, s.reason ? clip(s.reason, 36) : "stopped")
  }
  return `  ${id} ${glyph}  ${label} ${st}  ${trail}`.trimEnd()
}

/** Footer summary: `◐ 2 running · ✔ 1 done · ✘ 0 failed · 47.9k tok`. */
export function renderFleetFooter(records: readonly SubagentRecord[], ansi: boolean): string {
  const s = fleetStats(records)
  const dot = color(ansi, ANSI.DIM, GLYPHS.bullet)
  const parts = [
    `${color(ansi, ANSI.SKY, GLYPHS.running)} ${color(ansi, ANSI.SKY, `${s.running} running`)}`,
    `${color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, GLYPHS.done)} ${color(ansi, ANSI.LIME, `${s.done} done`)}`,
    ...(s.incomplete > 0
      ? [
          `${color(ansi, `${ANSI.GOLD}${ANSI.BOLD}`, GLYPHS.incomplete)} ${color(ansi, ANSI.GOLD, `${s.incomplete} incomplete`)}`,
        ]
      : []),
    `${color(ansi, `${ANSI.RED}${ANSI.BOLD}`, GLYPHS.failed)} ${color(ansi, ANSI.RED, `${s.failed} failed`)}`,
    color(ansi, ANSI.DGRAY, `${fmtTokens(s.tokens)} tok`),
  ]
  return ` ${parts.join(` ${dot} `)}`
}

/** Full ListAgents display. Empty fleet renders a hint. */
export function renderFleetDisplay(
  records: readonly SubagentRecord[],
  ansi: boolean,
  nowMs: number,
): DisplayParts {
  const s = fleetStats(records)
  const dot = color(ansi, ANSI.DIM, GLYPHS.bullet)
  if (records.length === 0) {
    return {
      header: color(ansi, `${ANSI.DIM}${ANSI.ITALIC}`, "no sub-agents"),
      body: color(ansi, ANSI.DIM, "  SpawnAgent({task, agent}) to delegate work"),
      footer: "",
    }
  }
  const incSeg =
    s.incomplete > 0 ? ` ${dot} ${color(ansi, ANSI.GOLD, `${s.incomplete} incomplete`)}` : ""
  const header = `${color(ansi, ANSI.LGRAY, "fleet")} ${dot} ${color(ansi, ANSI.SKY, `${s.running} running`)} ${dot} ${color(ansi, ANSI.LIME, `${s.done} done`)}${incSeg} ${dot} ${color(ansi, ANSI.DGRAY, `${fmtTokens(s.tokens)} tok`)}`
  const rows = records.map((r) => fleetRow(r, ansi, nowMs))
  // Trailing blank row → the host renders a bare `│` spacer before the
  // `╰ <footer>` summary, mirroring the blank `│` line the header already
  // gets. Without it the last worker row butts straight against the footer.
  const body = [...rows, ""].join("\n")
  return { header, body, footer: renderFleetFooter(records, ansi) }
}

// ---------------------------------------------------------------------------
// AgentResult
// ---------------------------------------------------------------------------

/** Full AgentResult display: the distilled deliverable. */
export function renderResultDisplay(r: SubagentRecord, ansi: boolean): DisplayParts {
  const dot = color(ansi, ANSI.DIM, GLYPHS.bullet)
  const arrow = color(ansi, ANSI.LIME, GLYPHS.report)
  const id = color(ansi, `${ANSI.LIME}${ANSI.BOLD}`, r.id)
  const type = color(ansi, ANSI.LGRAY, r.label)
  if (r.status.kind === "done") {
    const res = r.status.result
    const artifacts =
      res.artifacts && res.artifacts.length > 0
        ? `\n${color(ansi, ANSI.DGRAY, `artifacts: ${res.artifacts.join(", ")}`)}`
        : ""
    return {
      header: `${arrow} ${id} ${dot} ${type} ${dot} ${statusLabel(r.status, ansi)}`,
      body: `${res.short}${artifacts}`,
      footer: ` ${color(ansi, ANSI.LIME, "done")} ${dot} ${color(ansi, ANSI.DGRAY, `${fmtTokens(res.tokens)} tok ${GLYPHS.bullet} ${res.tools} tools`)}`,
    }
  }
  // Incomplete is TERMINAL (not "yet"): the worker finished with no deliverable.
  // Surface it loudly in gold so the lead treats it as a red flag, not a pass.
  if (r.status.kind === "incomplete") {
    const warnArrow = color(ansi, ANSI.GOLD, GLYPHS.incomplete)
    // When findings were salvaged despite the contract miss, show them — a gold
    // warning line on top, then the recovered synthesis, so the lead sees the
    // work isn't lost (the A2/A3 data-loss fix is visible here, not just in the
    // model-facing content). With no salvage we keep the recognizable
    // "NO DELIVERABLE" wording (also correct for a truly-silent worker).
    const warnLine = color(
      ansi,
      ANSI.GOLD,
      r.status.salvage
        ? `FILE MISSING — ${r.status.reason}. Findings salvaged below (verify; re-spawn only if needed):`
        : `NO DELIVERABLE — ${r.status.reason}. Not a success; re-spawn if still needed.`,
    )
    const body = r.status.salvage ? `${warnLine}\n\n${r.status.salvage}` : warnLine
    return {
      header: `${warnArrow} ${color(ansi, `${ANSI.GOLD}${ANSI.BOLD}`, r.id)} ${dot} ${type} ${dot} ${statusLabel(r.status, ansi)}`,
      body,
      footer: ` ${color(ansi, ANSI.DGRAY, `${fmtTokens(r.status.tokens)} tok ${GLYPHS.bullet} ${r.status.tools} tools`)}`,
    }
  }
  // Not done yet (or failed): report state honestly.
  return {
    header: `${arrow} ${id} ${dot} ${type} ${dot} ${statusLabel(r.status, ansi)}`,
    body: color(ansi, ANSI.DIM, `${r.id} is ${r.status.kind}; no final result yet.`),
    footer: "",
  }
}

// ---------------------------------------------------------------------------
// StopAgent
// ---------------------------------------------------------------------------

/** Full StopAgent display. */
export function renderStopDisplay(r: SubagentRecord, ansi: boolean): DisplayParts {
  const dot = color(ansi, ANSI.DIM, GLYPHS.bullet)
  const glyph = color(ansi, `${ANSI.RED}${ANSI.BOLD}`, GLYPHS.failed)
  const id = color(ansi, ANSI.BOLD, r.id)
  const reason = r.status.kind === "stopped" && r.status.reason ? r.status.reason : undefined
  return {
    header: `${glyph} ${id} ${dot} ${color(ansi, ANSI.LGRAY, r.label)}`,
    body: "",
    footer: ` ${color(ansi, ANSI.DIM, `stopped${reason ? ` ${GLYPHS.bullet} ${reason}` : ""}`)}`,
  }
}
