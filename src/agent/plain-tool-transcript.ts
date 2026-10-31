/**
 * Plain-text default for the tool transcript formatter port.
 *
 * Core uses {@link PLAIN_TOOL_TRANSCRIPT} when the host gives no
 * `ToolTranscriptFormatter`. It keeps the block shape (`╭` header, `│`
 * body rows, `╰` closer) so a plain log stays readable. It writes no ANSI,
 * does no code highlight, and reads no terminal state. A terminal host (the
 * CLI) injects its own formatter for colors, soft splits, and width math.
 *
 * @module agent/plain-tool-transcript
 */

import {
  displayWidth,
  expandTabs,
  truncateDisplayWidth,
} from "@minimal-agent/core/plugin-api/utils/term-width"

import type { ToolUseBlock } from "../llm/messages.ts"
import type { Finding } from "../sdk/tool-lifecycle.ts"
import type { TruncationInfo } from "../tools/truncation.ts"
import { truncHint } from "../utils/truncate-hint.ts"

import {
  findAnnotationStart,
  TOOL_PREVIEW_GUTTER_WIDTH,
  TOOL_PREVIEW_LINES,
  TOOL_PREVIEW_LINES_DEFAULT,
} from "./tool-preview-budget.ts"
import type {
  StreamedTailOptions,
  ToolHeaderRowsOptions,
  ToolPreviewOptions,
  ToolTranscriptFormatter,
} from "./tool-transcript-port.ts"

/** Hard per-line cap (cells) for a plain body row. */
const PLAIN_LINE_WIDTH = 200
/** Cells kept free for the `...(+Nch)` marker when a line is cut. */
const HINT_RESERVE_WIDTH = 12
/** Char cap of the header input summary. */
const HEADER_SUMMARY_MAX = 200
/** Default max diagnostic rows before the `+N more` row. */
const FINDINGS_MAX_ROWS = 6

/** Cut `line` to `maxWidth` cells with the standard `...(+Nch)` marker. */
function clampBodyWithHint(line: string, maxWidth: number): string {
  if (displayWidth(line) <= maxWidth) return line
  const trimmed = truncateDisplayWidth(line, Math.max(1, maxWidth - HINT_RESERVE_WIDTH), "")
  // eslint-disable-next-line typescript-eslint/no-misused-spread
  const cut = [...line].length - [...trimmed].length
  return `${trimmed}${truncHint(cut, "ch")}`
}

/** Body width: the given width minus the gutter, capped at the hard cap. */
function effectiveBodyLineWidth(cols?: number): number {
  if (typeof cols !== "number" || !Number.isFinite(cols)) return PLAIN_LINE_WIDTH
  const termBased = Math.floor(cols) - TOOL_PREVIEW_GUTTER_WIDTH - 1
  return termBased > 0 ? Math.min(termBased, PLAIN_LINE_WIDTH) : PLAIN_LINE_WIDTH
}

/** One-line summary of the tool input for the header row. */
function summarizeInput(tool: ToolUseBlock, headerKey?: string): string {
  const input = tool.input
  const pick = (key: string): string | undefined => {
    const v = input[key]
    return typeof v === "string" && v.length > 0 ? v : undefined
  }
  const keyed = headerKey ? pick(headerKey) : undefined
  let text: string
  if (keyed !== undefined) text = keyed
  else if (tool.name === "Bash" && pick("command")) text = `$ ${pick("command")}`
  else text = pick("file_path") ?? pick("pattern") ?? pick("path") ?? JSON.stringify(input)
  const oneLine = text.replace(/\s*\n\s*/g, " ")
  return oneLine.length > HEADER_SUMMARY_MAX
    ? `${oneLine.slice(0, HEADER_SUMMARY_MAX)}${truncHint(oneLine.length - HEADER_SUMMARY_MAX, "ch")}`
    : oneLine
}

function formatToolHeaderRows(opts: ToolHeaderRowsOptions): string[] {
  const { tool, presentation, headerOverride, timeText } = opts
  const icon = presentation?.icon ? `${presentation.icon} ` : ""
  const content =
    headerOverride !== undefined ? headerOverride : summarizeInput(tool, presentation?.headerKey)
  const gap = headerOverride !== undefined ? " " : "  "
  const time = timeText !== undefined ? ` · ${timeText}` : ""
  const title = content.length === 0 ? tool.name : `${tool.name}${gap}${content}`
  return [`  ╭ ${icon}${title}${time}`, "  │"]
}

/** Bare-facts footer for an API-truncated body. */
function truncFooter(info: TruncationInfo, visible: number): string {
  const totalL = info.totalLines ?? info.shownLines
  const totalB = info.totalBytes ?? info.shownBytes
  return `shown ${visible}/${totalL} L · ${info.shownBytes} B/${totalB} B · cut at L${info.cutLine}`
}

/** `  <glyph> <text>`, or the bare glyph for empty text. */
function row(glyph: string, text: string): string {
  return text.length === 0 ? `  ${glyph}` : `  ${glyph} ${text}`
}

function formatToolPreview(
  content: string,
  isError?: boolean,
  display?: string,
  opts?: ToolPreviewOptions,
): string[] {
  if (display !== undefined && !isError) {
    const footer = opts?.footer
    const body = footer === undefined ? display.replace(/\n$/, "") : display
    const lines = body.length === 0 ? [] : body.split("\n")
    const out = lines.map((line, i) =>
      row(footer === undefined && i === lines.length - 1 ? "╰" : "│", line),
    )
    if (footer !== undefined || lines.length === 0) out.push(row("╰", footer ?? ""))
    return out
  }
  const noticeIdx = findAnnotationStart(content)
  const body = noticeIdx >= 0 ? content.slice(0, noticeIdx) : content
  const maxLines = TOOL_PREVIEW_LINES[opts?.tool ?? ""] ?? TOOL_PREVIEW_LINES_DEFAULT
  const allLines = (body || "(no output)").split("\n")
  const visible = allLines.slice(0, maxLines)
  const width = effectiveBodyLineWidth(opts?.cols)
  let footer: string | null = null
  if (opts?.info?.truncated) footer = truncFooter(opts.info, visible.length)
  else if (allLines.length > visible.length) {
    footer = `shown ${visible.length}/${opts?.info?.totalLines ?? allLines.length} L`
  }
  const out = visible.map((line, i) =>
    row(
      i === visible.length - 1 && footer === null ? "╰" : "│",
      clampBodyWithHint(expandTabs(line, TOOL_PREVIEW_GUTTER_WIDTH), width),
    ),
  )
  if (footer !== null) out.push("  ┊", row("╰", footer))
  return out
}

function renderStreamedTail(opts: StreamedTailOptions): void {
  const { bufferedLastLine, streamedLineCount, budget, truncInfo, writeTranscript } = opts
  const visibleCount = Math.min(streamedLineCount, budget)
  let footer: string | null = null
  if (truncInfo?.truncated) footer = truncFooter(truncInfo, visibleCount)
  else if (streamedLineCount > budget) {
    footer = `shown ${visibleCount}/${truncInfo?.totalLines ?? streamedLineCount} L`
  }
  if (bufferedLastLine === null) {
    writeTranscript(row("╰", footer ?? "(no output)"))
    return
  }
  if (footer === null) {
    writeTranscript(row("╰", bufferedLastLine))
    return
  }
  writeTranscript(row("│", bufferedLastLine))
  writeTranscript("  ┊")
  writeTranscript(row("╰", footer))
}

function renderFindingsPanel(
  findings: Finding[],
  opts: { cols?: number; maxRows?: number } = {},
): string[] {
  if (findings.length === 0) return []
  const rank = { error: 0, warning: 1, info: 2 } as const
  const sorted = [...findings].sort((a, b) => rank[a.severity] - rank[b.severity])
  const maxRows = opts.maxRows ?? FINDINGS_MAX_ROWS
  const width = effectiveBodyLineWidth(opts.cols)
  const out: string[] = []
  for (const f of sorted.slice(0, maxRows)) {
    const loc =
      typeof f.line === "number" ? `${f.line}${typeof f.col === "number" ? `:${f.col}` : ""} ` : ""
    const code = f.code ? `${f.code} ` : ""
    out.push(row("│", clampBodyWithHint(`● ${loc}${code}${f.message}`, width)))
  }
  const hidden = sorted.length - Math.min(sorted.length, maxRows)
  if (hidden > 0) out.push(row("┊", `+${hidden} more`))
  const count = (sev: Finding["severity"]): number =>
    sorted.filter((f) => f.severity === sev).length
  const errors = count("error")
  const warnings = count("warning")
  const infos = count("info")
  const parts: string[] = []
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? "error" : "errors"}`)
  if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? "warning" : "warnings"}`)
  if (infos > 0) parts.push(`${infos} info`)
  const badge = errors > 0 ? "✘" : warnings > 0 ? "▲" : "●"
  out.push(row("╰", `${badge} ${parts.join(" · ")}`))
  return out
}

/** Plain-text {@link ToolTranscriptFormatter}: block glyphs, no ANSI, no highlight. */
export const PLAIN_TOOL_TRANSCRIPT: ToolTranscriptFormatter = {
  formatToolHeaderRows,
  formatToolPreview,
  formatRefusalRows: (message, refusedBy) => [
    row("│", `⊘ ${message}`),
    row("╰", `(refused by ${refusedBy})`),
  ],
  formatModeCloseRow: (labelDisplay) => row("╰", `active mode: ${labelDisplay}`),
  formatStreamBodyRow: (line) => row("│", line),
  clampBodyWithHint,
  effectiveBodyLineWidth,
  renderStreamedTail,
  reopenFrameCloser: (line) => (/^ {0,2}╰/.test(line) ? line.replace("╰", "│") : line),
  renderFindingsPanel,
  resolveFileLanguage: () => null,
  highlightReadBody: async () => null,
  highlightUnifiedDiff: async () => null,
}
