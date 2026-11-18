/**
 * The clamp engine of the universal tool-output guardrail, with its parts
 * separate (SPEC v6.1 D2, DECISIONS D-H). Core-internal module.
 *
 * `./truncation.ts` re-exports only the names that it exported at a38c86b
 * (the public surface of `@minimal-agent/core/host/truncation`). The U1b
 * names (`truncateToolOutputParts`, `TruncationFacts`, `TruncationParts`,
 * `renderTruncatedNotice`, `joinTruncationParts`, `TRUNCATION_NOTICE_JOIN`)
 * live here, and no `host-public` module re-exports this file (review W4).
 *
 * @module tools/truncation-parts
 */

import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"

import { type TruncatedFacts, truncatedNoticeText } from "./tool-result-text.ts"

/** Hard byte ceiling for any single tool result body (excluding the notice). */
export const MAX_TOOL_OUTPUT_BYTES = 64_000

/** Hard line ceiling for any single tool result body. */
export const MAX_TOOL_OUTPUT_LINES = 1_000

/**
 * Hard per-line character ceiling for any tool result body (all tools).
 *
 * Mega-lines (minified webpack bundles, single-line JSON dumps) defeat
 * line-based shells (`head -N`), the line budget, and TUI preview math.
 * Clamp each newline-delimited segment before the byte/line budgets so a
 * single pathological line cannot dominate the model-facing payload.
 *
 * This is the *model/buffer* cap. The TUI has a much tighter display-width
 * cap (`TOOL_PREVIEW_LINE_WIDTH`, ~200 cells) applied at render time.
 */
export const MAX_TOOL_OUTPUT_LINE_CHARS = 8_192

/** Input of the clamp: the tool name and the source measurements. */
export interface TruncateCtx {
  /** Tool name; selects the per-tool resume hint. */
  tool?: string
  /** Total bytes the underlying source produced, if known. */
  totalBytes?: number
  /** Total lines the underlying source produced, if known. */
  totalLines?: number
  /** Zero-based line offset already applied (Read with `offset`). */
  startLine?: number
}

/**
 * Structured render-time view of "what happened to this tool result", emitted
 * by `truncateToolOutput` alongside the model-facing string. A host
 * reads this to draw a bare-facts footer (`shown N/M L · X/Y B · cut at L`)
 * without parsing the trailing `[truncated: ...]` notice that lives inside
 * `content` for the model. Audiences are split: model gets the verbose
 * notice with action verbs in `content`; user gets the structured summary
 * via this object. The host view gets it in the tool outcome event.
 */
export interface TruncationInfo {
  /** Tool name (mirrors `ctx.tool`). */
  tool?: string
  /** True iff the body was clamped. When false, all `shown*` == `total*`. */
  truncated: boolean
  /** Bytes shown to the model after clamping (and to the TUI body preview). */
  shownBytes: number
  /** Lines shown to the model after clamping. */
  shownLines: number
  /** Total bytes the underlying source produced, if known. */
  totalBytes?: number
  /** Total lines the underlying source produced, if known. */
  totalLines?: number
  /** Absolute last-line index visible (= `startLine + shownLines`). */
  cutLine: number
  /** Zero-based line offset already applied (Read with `offset`). */
  startLine?: number
}

/**
 * Typed truncation facts (DECISIONS D-H, W2 U1b). Data only: the notice text
 * reads only the legacy facts, so no model byte changes. Core copies the
 * typed facts (not `truncated` and not `noticeTotalLines`) into the attrs of
 * the `output-truncated` annotation.
 *
 * Positions: "source" is the text after the per-line clamp
 * ({@link clampLinesCounted}). The byte cut and the line cut read the
 * source, not the original output.
 */
export interface TruncationFacts {
  /** True when the clamp cut the output. The `output-truncated` gate reads this value (review W2). */
  readonly truncated: boolean
  /** Tool name, `""` when unknown. Selects the per-tool hint of the notice. */
  readonly tool: string
  /** UTF-8 bytes of the kept text (the text before the notice). */
  readonly shownBytes: number
  /** Total bytes of the original output: `ctx.totalBytes`, else measured. */
  readonly totalBytes: number
  /** Lines of the kept text (`0` for an empty kept text). */
  readonly shownLines: number
  /**
   * Total lines of the source file, in file-line units (the same units as
   * `cutLine` and `nextOffset`): `ctx.totalLines`, else
   * `(ctx.startLine ?? 0)` + the measured lines of the output (F9).
   */
  readonly totalLines: number
  /**
   * True when the caller gave `totalLines` (`ctx.totalLines !== undefined`).
   * False when core measured the total lines itself (a plugin tool or a tool
   * that gives no total).
   */
  readonly totalLinesKnown: boolean
  /**
   * Renderer input only (not an annotation attr, review S1). The total-lines
   * number that the notice text shows ("N/M lines"): the legacy value,
   * `ctx.totalLines`, else the measured lines of the output (no `startLine`
   * added). Equals `info.totalLines`.
   */
  readonly noticeTotalLines: number
  /** `startLine + shownLines`. The notice shows it as "line N" and as the Read `offset=N` hint. */
  readonly cutLine: number
  /**
   * UTF-8 byte offset in the source where the kept text ends. Equals
   * `shownBytes` and the "cut at byte N" number of the notice. When
   * `longLines > 0` it is not an offset in the original output.
   */
  readonly cutByte: number
  /** True when a shown line is not complete: `lastLinePartial`, or the per-line clamp cut a shown line. */
  readonly cutMidLine: boolean
  /** Number of lines (in the full source, shown or not) that the per-line clamp cut. */
  readonly longLines: number
  /** The per-line character cap ({@link MAX_TOOL_OUTPUT_LINE_CHARS}). */
  readonly lineCharCap: number
  /**
   * True when the cut ended inside a line: the kept text is not empty, does
   * not end with `"\n"`, and the source does not have `"\n"` after it.
   */
  readonly lastLinePartial: boolean
  /**
   * Zero-based line offset where a next read can start, in file lines (F9):
   * the first line that is not complete in the kept text. It is
   * `cutLine - 1` when the source line at the cut is not complete (a
   * partial line, or the empty segment after a kept text that ends with
   * `"\n"`), else `cutLine`. It is not more than `totalLines` and not less
   * than `startLine`. When `startLine > totalLines` (a read past the end),
   * it is `startLine`. `nextOffset >= totalLines` means no line is left.
   */
  readonly nextOffset: number
}

/**
 * The parts of a clamp result (SPEC v6.1 D2). The old joined string is
 * `kept` when `facts.truncated` is false, else `kept + TRUNCATION_NOTICE_JOIN + notice`.
 */
export interface TruncationParts {
  /** The kept body text, with no notice. */
  readonly kept: string
  /** The rendered `[truncated: ...]` notice. `""` when not truncated or with no text provider. */
  readonly notice: string
  /** Frozen copy of the host info (unchanged shape). Not the object that a host gets (review W2). */
  readonly info: Readonly<TruncationInfo>
  /** Typed facts (D-H). Frozen. Present also when not truncated. The notice is rendered from this value. */
  readonly facts: TruncationFacts
}

/** The bytes between the kept text and the notice (truncation.ts join, SPEC D5 row 1). */
export const TRUNCATION_NOTICE_JOIN = "\n\n"

/**
 * Render the `[truncated: ...]` notice from the typed facts. The one renderer
 * of the notice: the clamp and the `output-truncated` annotation both call it
 * with the resolver that the caller gives (no default resolver, review W1),
 * so the notice text and the facts come from one value (D-B gate).
 * The 7 legacy facts and the 6 M3c facts reach the text kind. The built-in
 * provider reads only the legacy facts, so the bytes do not change.
 * The text reads `noticeTotalLines` (the legacy total), not the typed
 * `totalLines` (F9). A facts value with no `noticeTotalLines` uses `totalLines`.
 */
export function renderTruncatedNotice(
  text: SyntheticTextResolver,
  facts: Pick<
    TruncationFacts,
    "tool" | "shownBytes" | "totalBytes" | "shownLines" | "totalLines" | "cutLine"
  > &
    Partial<
      Pick<
        TruncationFacts,
        | "noticeTotalLines"
        | "cutMidLine"
        | "longLines"
        | "lineCharCap"
        | "lastLinePartial"
        | "nextOffset"
        | "totalLinesKnown"
      >
    >,
): string {
  const noticeFacts: TruncatedFacts = {
    tool: facts.tool,
    shownBytes: facts.shownBytes,
    totalBytes: facts.totalBytes,
    shownLines: facts.shownLines,
    totalLines: facts.noticeTotalLines ?? facts.totalLines,
    cutLine: facts.cutLine,
    maxToolOutputBytes: MAX_TOOL_OUTPUT_BYTES,
    // The M3c facts: only the ones that the caller gave. A provider can ignore them.
    ...(facts.cutMidLine !== undefined && { cutMidLine: facts.cutMidLine }),
    ...(facts.longLines !== undefined && { longLines: facts.longLines }),
    ...(facts.lineCharCap !== undefined && { lineCharCap: facts.lineCharCap }),
    ...(facts.lastLinePartial !== undefined && { lastLinePartial: facts.lastLinePartial }),
    ...(facts.nextOffset !== undefined && { nextOffset: facts.nextOffset }),
    ...(facts.totalLinesKnown !== undefined && { totalLinesKnown: facts.totalLinesKnown }),
  }
  return truncatedNoticeText(text, noticeFacts)
}

/** Join clamp parts into the old model string (byte-identical to the old `content`). */
export function joinTruncationParts(
  parts: Pick<TruncationParts, "kept" | "notice"> & {
    readonly facts: Pick<TruncationFacts, "truncated">
  },
): string {
  return parts.facts.truncated
    ? `${parts.kept}${TRUNCATION_NOTICE_JOIN}${parts.notice}`
    : parts.kept
}

/**
 * Count newline-delimited segments WITHOUT allocating an array, matching
 * `s.split("\n").length` exactly (`""` → 1). The hot-path caller
 * (`truncateToolOutput`) runs this on the full, possibly multi-MB
 * tool body on the synchronous critical section; `split("\n").length`
 * there allocates one string per line just to read `.length` and discards
 * it in the common under-budget case, which shows up as a UI stall on a
 * big body (Bug 4). Scanning for `\n` allocates nothing.
 */
export function countLines(s: string): number {
  let n = 1
  let i = s.indexOf("\n")
  while (i !== -1) {
    n++
    i = s.indexOf("\n", i + 1)
  }
  return n
}

/**
 * The per-line clamp of `clampToolOutputLines`. Also gives the number of
 * lines that the clamp cut (`longLines`) and their zero-based indexes.
 */
export function clampLinesCounted(
  output: string,
  maxChars: number,
): { text: string; longLines: number; longLineIndexes: number[] } {
  if (output.length === 0 || output.length <= maxChars) {
    return { text: output, longLines: 0, longLineIndexes: [] }
  }
  const longLineIndexes: number[] = []
  let index = 0
  let out = ""
  let start = 0
  let first = true
  while (true) {
    const nl = output.indexOf("\n", start)
    const end = nl === -1 ? output.length : nl
    let line = output.slice(start, end)
    if (line.length > maxChars) {
      const cut = line.length - maxChars
      line = `${line.slice(0, maxChars)}...(+${cut}ch)`
      longLineIndexes.push(index)
    }
    index++
    if (!first) out += "\n"
    out += line
    first = false
    if (nl === -1) break
    start = nl + 1
  }
  return { text: out, longLines: longLineIndexes.length, longLineIndexes }
}

/** Truncate `s` to at most `maxBytes` UTF-8 bytes, never splitting a codepoint. */
export function sliceUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8")
  if (buf.length <= maxBytes) return s
  let end = maxBytes
  // Back off off any utf-8 continuation byte (10xxxxxx).
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString("utf8")
}

/** Freeze a parts object. The info is a frozen copy (review W2). */
function frozenParts(
  kept: string,
  notice: string,
  info: TruncationInfo,
  facts: TruncationFacts,
): TruncationParts {
  return Object.freeze({ kept, notice, info: Object.freeze({ ...info }), facts })
}

/**
 * The clamp of `truncateToolOutput`, with its parts separate (SPEC v6.1
 * D2): the kept text, the rendered notice, a frozen copy of the host info
 * and the typed facts. `text` is required: no code path renders the notice
 * with an implicit default resolver (review W1).
 */
export function truncateToolOutputParts(
  output: string,
  ctx: TruncateCtx,
  text: SyntheticTextResolver,
): TruncationParts {
  // Per-line clamp first. A single 7 MB webpack line must not reach the
  // byte/line budgets (or the TUI) intact, and must not force
  // `split("\n")` / codepoint spreads over multi-megabyte strings.
  const lineClamped = clampLinesCounted(output, MAX_TOOL_OUTPUT_LINE_CHARS)
  const source = lineClamped.text

  const bytes = Buffer.byteLength(source, "utf8")
  // Allocation-free count (see countLines). Keeps the empty-string guard:
  // `"".split("\n").length` is 1, but truncation has always reported 0
  // lines for an empty body, so preserve that exactly.
  const lines = source.length === 0 ? 0 : countLines(source)
  const overBytes = bytes > MAX_TOOL_OUTPUT_BYTES
  const overLines = lines > MAX_TOOL_OUTPUT_LINES
  // Totals prefer the caller's source measurements (pre-line-clamp) so the
  // TUI footer can still say "7.2 MB" when we only kept an 8 KB head.
  const totalBytes = ctx.totalBytes ?? Buffer.byteLength(output, "utf8")
  const totalLines = ctx.totalLines ?? (output.length === 0 ? 0 : countLines(output))
  // Typed fact (F9): file-line units, the same as `cutLine`. Without
  // `ctx.totalLines`, the measured count is slice lines, so add `startLine`.
  // `totalLines` above stays the legacy value of the info and the notice text.
  const startLine = ctx.startLine ?? 0
  const fileTotalLines = ctx.totalLines === undefined ? startLine + totalLines : totalLines

  if (!overBytes && !overLines && lineClamped.longLines === 0) {
    // Pass-through: still report the totals so the TUI can show
    // "1L · 87ch" style stats even when nothing was clamped. The body
    // and the totals coincide.
    const cutLine = startLine + lines
    const info: TruncationInfo = {
      tool: ctx.tool,
      truncated: false,
      shownBytes: bytes,
      shownLines: lines,
      totalBytes,
      totalLines,
      cutLine,
      startLine: ctx.startLine,
    }
    const facts = makeFacts({
      truncated: false,
      tool: ctx.tool ?? "",
      shownBytes: bytes,
      totalBytes,
      shownLines: lines,
      totalLines: fileTotalLines,
      totalLinesKnown: ctx.totalLines !== undefined,
      noticeTotalLines: totalLines,
      startLine,
      cutLine,
      longLines: 0,
      longShown: false,
      lastLinePartial: false,
      cutLineOpen: false,
    })
    return frozenParts(source, "", info, facts)
  }

  // Snap to a line boundary first when the line budget hit.
  let kept = source
  if (overLines) kept = source.split("\n").slice(0, MAX_TOOL_OUTPUT_LINES).join("\n")
  // Then clamp bytes (handles post-line-clamp overflow of many medium lines).
  if (Buffer.byteLength(kept, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    kept = sliceUtf8(kept, MAX_TOOL_OUTPUT_BYTES)
    // Try to end on a newline if we're close enough — keeps line counts clean.
    // Known old bug (M3c, not fixed here: 0 byte change): `nl` is a UTF-16
    // index and the right side is a byte count, so a multibyte text can keep
    // a trailing "\n". The facts below handle that case (review W3).
    const nl = kept.lastIndexOf("\n")
    if (nl >= MAX_TOOL_OUTPUT_BYTES * 0.9) kept = kept.slice(0, nl)
  }

  const shownBytes = Buffer.byteLength(kept, "utf8")
  const shownLines = kept.length === 0 ? 0 : countLines(kept)
  const cutLine = startLine + shownLines
  const tool = ctx.tool ?? ""
  // Facts only (D-H). `kept` is a prefix of `source` (UTF-16 units on both
  // sides). The source line at the cut is complete only when the source has
  // "\n" right after `kept`. When it is not complete and `kept` ends with
  // "\n", no char of that line is shown: `countLines` counts an empty
  // segment, and the cut is at a line boundary (review W3).
  const cutLineOpen =
    kept.length > 0 && kept.length < source.length && source.charCodeAt(kept.length) !== 10
  const lastLinePartial = cutLineOpen && !kept.endsWith("\n")
  // Source lines with at least one shown char (the empty segment is not shown).
  const linesWithText = cutLineOpen && !lastLinePartial ? shownLines - 1 : shownLines
  const longShown = lineClamped.longLineIndexes.some((i) => i < linesWithText)

  const facts = makeFacts({
    truncated: true,
    tool,
    shownBytes,
    totalBytes,
    shownLines,
    totalLines: fileTotalLines,
    totalLinesKnown: ctx.totalLines !== undefined,
    noticeTotalLines: totalLines,
    startLine,
    cutLine,
    longLines: lineClamped.longLines,
    longShown,
    lastLinePartial,
    cutLineOpen,
  })
  // The kind owns the bracketed notice and its per-tool hint. Core keeps the
  // body and the join, so the provider never sees tool output. The notice is
  // rendered from the facts value (one source, D-B gate).
  const notice = renderTruncatedNotice(text, facts)
  const info: TruncationInfo = {
    tool: ctx.tool,
    truncated: true,
    shownBytes,
    shownLines,
    totalBytes,
    totalLines,
    cutLine,
    startLine: ctx.startLine,
  }
  return frozenParts(kept, notice, info, facts)
}

/** Build the frozen facts. The derived facts have one definition here. */
function makeFacts(f: {
  truncated: boolean
  tool: string
  shownBytes: number
  totalBytes: number
  shownLines: number
  totalLines: number
  totalLinesKnown: boolean
  noticeTotalLines: number
  startLine: number
  cutLine: number
  longLines: number
  longShown: boolean
  lastLinePartial: boolean
  /** The source line at the cut is not complete in the kept text. */
  cutLineOpen: boolean
}): TruncationFacts {
  const next = f.cutLineOpen ? f.cutLine - 1 : f.cutLine
  return Object.freeze({
    truncated: f.truncated,
    tool: f.tool,
    shownBytes: f.shownBytes,
    totalBytes: f.totalBytes,
    shownLines: f.shownLines,
    totalLines: f.totalLines,
    totalLinesKnown: f.totalLinesKnown,
    noticeTotalLines: f.noticeTotalLines,
    cutLine: f.cutLine,
    cutByte: f.shownBytes,
    cutMidLine: f.lastLinePartial || f.longShown,
    longLines: f.longLines,
    lineCharCap: MAX_TOOL_OUTPUT_LINE_CHARS,
    lastLinePartial: f.lastLinePartial,
    // Not more than totalLines; not less than startLine (review S2).
    nextOffset: Math.max(f.startLine, Math.min(next, f.totalLines)),
  })
}
