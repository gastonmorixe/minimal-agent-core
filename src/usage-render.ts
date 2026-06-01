/**
 * Pure ASCII renderer for {@link UsageReport}s.
 *
 * Produces an array of ANSI-styled lines (no trailing newlines) so the same
 * output drives BOTH the `usage` CLI command (printed to stdout) and the
 * `/usage` live-area overlay (painted into the editor decoration band).
 *
 * Two render surfaces:
 *   - {@link renderUsageReport}: the full report (totals header + provider
 *     bar chart + model bar chart), for the CLI.
 *   - {@link renderUsageOverlay}: a compact, height-bounded variant for the
 *     footer overlay, with a period-tab strip and a key hint.
 *
 * The bar glyphs reuse the 1/8th-block ramp from the quota-status footer so
 * the two surfaces look like the same product.
 *
 * @module usage-render
 */

import { c } from "./agent/ansi.ts"
import { modelShortLabel } from "./llm/model-label.ts"
import { displayWidth } from "./term-width.ts"
import {
  USAGE_PERIODS,
  type UsageBreakdownRow,
  type UsagePeriod,
  type UsageReport,
  type UsageTotals,
} from "./usage-stats.ts"

/** 1/8th-block ramp (shared visual language with quota-status). */
const SLICES = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉", "█"] as const
const EMPTY_CELL = "░"

/** Compact token count: `0`, `847`, `12.3k`, `1.2M`, `3.4B`. */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—"
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`
  return String(n)
}

/** Compact USD: `$0.00`, `$1.23`, `$45.60`, `$1.2k`. Sub-cent shows `<$0.01`. */
export function fmtUSD(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00"
  if (n < 0.01) return "<$0.01"
  if (n >= 1000) return `$${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return `$${n.toFixed(2)}`
}

/** Human label for a period id (from the catalog; falls back to the id). */
export function periodLabel(period: UsagePeriod): string {
  return USAGE_PERIODS.find((p) => p.id === period)?.label ?? period
}

/**
 * Render a horizontal bar of `cells` width filling `value/max`, using the
 * 1/8th ramp. Returns `{full, empty}` so the caller colors them separately.
 */
function bar(value: number, max: number, cells: number): { full: string; empty: string } {
  if (max <= 0 || value <= 0) return { full: "", empty: EMPTY_CELL.repeat(cells) }
  const frac = Math.min(1, value / max)
  const eighths = Math.max(0, Math.min(cells * 8, Math.round(frac * cells * 8)))
  const full = Math.floor(eighths / 8)
  const part = eighths % 8
  return {
    full: "█".repeat(full) + (part ? SLICES[part]! : ""),
    empty: EMPTY_CELL.repeat(Math.max(0, cells - full - (part ? 1 : 0))),
  }
}

/** Pad a styled label to a fixed DISPLAY width (ANSI-aware). */
function padLabel(label: string, width: number): string {
  const w = displayWidth(label)
  if (w >= width) return label
  return label + " ".repeat(width - w)
}

/** A `[R]` / `[E]` / `[~]` marker describing a totals block's provenance. */
function provenanceMark(t: UsageTotals): string {
  if (t.turns === 0) return ""
  if (t.estimatedTurns === 0) return c.green("[R]")
  if (t.estimatedTurns === t.turns) return c.yellow("[E]")
  return c.yellow("[~]") // mixed real + estimated
}

/**
 * One breakdown row as a bar line:
 *   `anthropic   ███████████░░░░  1.2M  $4.56  [R]`
 *
 * @param labelFn - Maps the row key to a display label (e.g. model short label).
 */
function renderRow(
  row: UsageBreakdownRow,
  maxTokens: number,
  opts: { labelWidth: number; barCells: number; tokWidth: number; labelFn: (k: string) => string },
): string {
  const label = padLabel(c.cyan(opts.labelFn(row.key)), opts.labelWidth)
  const { full, empty } = bar(row.totals.tokens, maxTokens, opts.barCells)
  const barStr = c.lime(full) + c.dim(empty)
  const tok = fmtTokens(row.totals.tokens).padStart(opts.tokWidth)
  const cost = row.totals.costUSD > 0 ? `  ${c.dim(fmtUSD(row.totals.costUSD))}` : ""
  const mark = row.totals.estimatedTurns > 0 ? `  ${provenanceMark(row.totals)}` : ""
  return `  ${label} ${barStr} ${c.faintWhite(tok)}${cost}${mark}`
}

/** Render a labeled breakdown section (a heading + bar rows). */
function renderSection(
  heading: string,
  rows: UsageBreakdownRow[],
  opts: { labelWidth: number; barCells: number; labelFn: (k: string) => string },
): string[] {
  if (rows.length === 0) return []
  const maxTokens = rows.reduce((m, r) => Math.max(m, r.totals.tokens), 0)
  const tokWidth = rows.reduce((m, r) => Math.max(m, fmtTokens(r.totals.tokens).length), 0)
  const out: string[] = [`  ${c.bold(heading)}`]
  for (const row of rows) {
    out.push(renderRow(row, maxTokens, { ...opts, tokWidth }))
  }
  return out
}

/**
 * The totals header line, e.g.:
 *   `Total  1.2M tok  ·  in 90k  out 30k  cache-r 1.0M  cache-w 8k  ·  $4.56  ·  42 turns  [R]`
 */
function renderTotalsLines(t: UsageTotals): string[] {
  if (t.turns === 0) {
    return [`  ${c.dim("no usage recorded in this period")}`]
  }
  const head = `  ${c.bold("Total")} ${c.boldCyan(fmtTokens(t.tokens))} ${c.dim("tok")}  ${provenanceMark(t)}`
  const breakdown =
    t.estimatedTurns === t.turns
      ? // Fully estimated: no billed split / cost to show.
        `    ${c.dim("(estimated from transcript text — no billed usage saved)")}`
      : `    ${c.dim("in")} ${fmtTokens(t.input)}  ${c.dim("out")} ${fmtTokens(t.output)}  ${c.dim("cache-r")} ${fmtTokens(t.cacheRead)}  ${c.dim("cache-w")} ${fmtTokens(t.cacheCreate)}  ${c.dim("·")}  ${c.green(fmtUSD(t.costUSD))}`
  const turns = `    ${c.dim(`${t.turns} turn${t.turns === 1 ? "" : "s"}${t.estimatedTurns > 0 && t.estimatedTurns < t.turns ? ` · ${t.estimatedTurns} estimated` : ""}`)}`
  return [head, breakdown, turns]
}

/** Label a model id compactly (provider-tagged short label, e.g. `anth-4.8`). */
function modelShort(k: string): string {
  if (k === "unknown") return "unknown"
  return modelShortLabel(k) || k
}

export interface RenderUsageOpts {
  /** Total render width in columns. Default 80. */
  cols?: number
}

/**
 * Render the FULL usage report (CLI surface): a period heading, the totals
 * header, then the per-provider and per-model bar charts.
 */
export function renderUsageReport(report: UsageReport, opts: RenderUsageOpts = {}): string[] {
  const cols = Math.max(48, opts.cols ?? 80)
  const out: string[] = []
  const since =
    report.period === "all" ? "all time" : `since ${new Date(report.startMs).toLocaleString()}`
  out.push("")
  out.push(
    `  ${c.bold(c.brightCyan(`Token usage — ${periodLabel(report.period)}`))}  ${c.dim(since)}`,
  )
  out.push("")
  out.push(...renderTotalsLines(report.totals))
  out.push("")

  // Bar cells: reserve space for label + count columns.
  const labelWidth = 14
  const barCells = Math.max(8, Math.min(40, cols - labelWidth - 24))

  const prov = renderSection("By provider", report.byProvider, {
    labelWidth,
    barCells,
    labelFn: (k) => k,
  })
  out.push(...prov)
  if (prov.length > 0) out.push("")
  out.push(
    ...renderSection("By model", report.byModel, {
      labelWidth,
      barCells,
      labelFn: modelShort,
    }),
  )
  out.push("")
  return out
}

/**
 * Render the COMPACT overlay surface (`/usage` footer): a period-tab strip,
 * the totals header, a short model breakdown, and a key hint. Height-bounded
 * by `maxRows` so it fits the live area without scrolling the prompt away.
 *
 * @param report - The active period's report.
 * @param opts.cols - Render width.
 * @param opts.maxRows - Max breakdown rows to show (default 6).
 */
export function renderUsageOverlay(
  report: UsageReport,
  opts: { cols?: number; maxRows?: number } = {},
): string[] {
  const cols = Math.max(48, opts.cols ?? 80)
  const maxRows = opts.maxRows ?? 6
  const out: string[] = []

  // Period tab strip: [Today] Last 24h  Last 30d  ... (active highlighted).
  const tabs = USAGE_PERIODS.map((p) =>
    p.id === report.period ? c.boldCyan(`[${p.label}]`) : c.dim(p.label),
  ).join("  ")
  out.push(`  ${tabs}`)

  // Totals (condensed to two lines).
  const t = report.totals
  if (t.turns === 0) {
    out.push(`  ${c.dim("no usage recorded in this period")}`)
  } else {
    out.push(
      `  ${c.bold("Total")} ${c.boldCyan(fmtTokens(t.tokens))} ${c.dim("tok")}` +
        (t.estimatedTurns < t.turns ? `  ${c.green(fmtUSD(t.costUSD))}` : "") +
        `  ${provenanceMark(t)}  ${c.dim(`${t.turns} turn${t.turns === 1 ? "" : "s"}`)}`,
    )
  }

  // Model breakdown (top N), compact bars.
  const labelWidth = 12
  const barCells = Math.max(6, Math.min(24, cols - labelWidth - 22))
  const rows = report.byModel.slice(0, maxRows)
  const maxTokens = rows.reduce((m, r) => Math.max(m, r.totals.tokens), 0)
  const tokWidth = rows.reduce((m, r) => Math.max(m, fmtTokens(r.totals.tokens).length), 0)
  for (const row of rows) {
    out.push(renderRow(row, maxTokens, { labelWidth, barCells, tokWidth, labelFn: modelShort }))
  }
  if (report.byModel.length > maxRows) {
    out.push(`  ${c.dim(`… +${report.byModel.length - maxRows} more model(s)`)}`)
  }

  // Key hint.
  out.push(`  ${c.dim("← →")} ${c.dim("period")}   ${c.dim("Esc")} ${c.dim("close")}`)
  return out
}
