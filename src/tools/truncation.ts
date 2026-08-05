/**
 * Universal tool-output guardrail.
 *
 * Every tool result passes through {@link truncateToolOutput} as the very
 * last step in `executeTool` (in `../tools.ts`). The clamp enforces
 * one byte budget and one line budget — whichever is hit first wins —
 * and appends a single-line, machine-readable notice the model can use to
 * decide a follow-up call without guessing.
 *
 * Notice shape (one line):
 *
 *   [truncated: shown <N> of <M> bytes, <sL>/<tL> lines; cut at byte <B>, line <L>. <hint>]
 *
 * `<M>` and `<tL>` are `unknown` when the source size is genuinely unknown
 * (e.g. a streamed Bash spawn we killed mid-output).
 */

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

/**
 * Hard ceiling on the pre-clamp body persisted for the blob store (`_raw`).
 * Truncation still fires against the full in-memory body when a tool
 * produced one, but we refuse to keep multi-MB "recovery" blobs for a
 * single call (Adrian 2026-08-05: 7.2 MB webpack line).
 */
export const MAX_TOOL_RAW_BYTES = 256_000

import { truncationHint, truncationNotice } from "./PROMPTS.ts"

export interface TruncateCtx {
  /** Tool name; selects the per-tool resume hint. */
  tool?: string
  /** Total bytes the underlying source produced, if known. */
  totalBytes?: number
  /** Total lines the underlying source produced, if known. */
  totalLines?: number
  /** Zero-based line offset already applied (Read with `offset`). */
  startLine?: number
  /** Verbatim hint to use instead of the per-tool default. */
  hint?: string
}

/**
 * Structured render-time view of "what happened to this tool result", emitted
 * by {@link truncateToolOutput} alongside the model-facing string. The TUI
 * reads this to draw a bare-facts footer (`shown N/M L · X/Y B · cut at L`)
 * without parsing the trailing `[truncated: ...]` notice that lives inside
 * `content` for the model. Audiences are split: model gets the verbose
 * notice with action verbs in `content`; user gets the structured summary
 * via this object. See `formatToolPreview` in `src/agent.ts`.
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
 * Clamp `output` to the byte/line budgets and emit a structured
 * {@link TruncationInfo} alongside the model-facing string. When nothing
 * was cut, `info.truncated === false` and `content` equals `output`
 * unchanged. When clamping happens, `content` includes the trailing
 * `[truncated: ...]` notice (model-facing, with action-verb hint), and
 * `info` carries the same numbers in machine-readable form (TUI-facing,
 * no hints).
 */
/**
 * Count newline-delimited segments WITHOUT allocating an array, matching
 * `s.split("\n").length` exactly (`""` → 1). The hot-path caller
 * ({@link truncateToolOutput}) runs this on the full, possibly multi-MB
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
 * Clip every newline-delimited segment longer than `maxChars`, appending
 * a short `...(+Nch)` marker so the model can see that a mega-line was
 * shortened. Allocation-conscious: the common under-budget case (whole
 * body shorter than `maxChars`) is a single length check and returns the
 * input byte-identical.
 */
export function clampToolOutputLines(
  output: string,
  maxChars: number = MAX_TOOL_OUTPUT_LINE_CHARS,
): { text: string; clamped: boolean } {
  if (output.length === 0 || output.length <= maxChars) {
    return { text: output, clamped: false }
  }
  let clamped = false
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
      clamped = true
    }
    if (!first) out += "\n"
    out += line
    first = false
    if (nl === -1) break
    start = nl + 1
  }
  return { text: out, clamped }
}

/**
 * Cap a pre-clamp body destined for the blob store. UTF-8 safe.
 * Returns the input unchanged when already under budget.
 */
export function clampToolRaw(raw: string, maxBytes: number = MAX_TOOL_RAW_BYTES): string {
  if (Buffer.byteLength(raw, "utf8") <= maxBytes) return raw
  return sliceUtf8(raw, maxBytes)
}

/**
 * Applies the universal tool-output guardrail: clamps a body that exceeds
 * the per-line, byte, or line cap (cutting on a UTF-8 boundary), appends a
 * structured truncation notice, and reports the original totals either way
 * so the TUI can show size stats. Untruncated bodies pass through
 * byte-identical.
 */
export function truncateToolOutput(
  output: string,
  ctx: TruncateCtx = {},
): { content: string; info: TruncationInfo } {
  // Per-line clamp first. A single 7 MB webpack line must not reach the
  // byte/line budgets (or the TUI) intact, and must not force
  // `split("\n")` / codepoint spreads over multi-megabyte strings.
  const lineClamped = clampToolOutputLines(output)
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

  if (!overBytes && !overLines && !lineClamped.clamped) {
    // Pass-through: still report the totals so the TUI can show
    // "1L · 87ch" style stats even when nothing was clamped. The body
    // and the totals coincide.
    return {
      content: source,
      info: {
        tool: ctx.tool,
        truncated: false,
        shownBytes: bytes,
        shownLines: lines,
        totalBytes,
        totalLines,
        cutLine: (ctx.startLine ?? 0) + lines,
        startLine: ctx.startLine,
      },
    }
  }

  // Snap to a line boundary first when the line budget hit.
  let kept = source
  if (overLines) kept = source.split("\n").slice(0, MAX_TOOL_OUTPUT_LINES).join("\n")
  // Then clamp bytes (handles post-line-clamp overflow of many medium lines).
  if (Buffer.byteLength(kept, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    kept = sliceUtf8(kept, MAX_TOOL_OUTPUT_BYTES)
    // Try to end on a newline if we're close enough — keeps line counts clean.
    const nl = kept.lastIndexOf("\n")
    if (nl >= MAX_TOOL_OUTPUT_BYTES * 0.9) kept = kept.slice(0, nl)
  }

  const shownBytes = Buffer.byteLength(kept, "utf8")
  const shownLines = kept.length === 0 ? 0 : countLines(kept)
  const cutLine = (ctx.startLine ?? 0) + shownLines
  const totalB = String(totalBytes)
  const totalL = String(totalLines)
  const hint = ctx.hint ?? defaultHint(ctx.tool, cutLine)

  const content = truncationNotice({
    kept,
    shownBytes,
    totalBytes: totalB,
    shownLines,
    totalLines: totalL,
    cutLine,
    hint,
  })
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
  return { content, info }
}

function defaultHint(tool: string | undefined, cutLine: number): string {
  return truncationHint(tool, cutLine, MAX_TOOL_OUTPUT_BYTES)
}

/** Truncate `s` to at most `maxBytes` UTF-8 bytes, never splitting a codepoint. */
function sliceUtf8(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8")
  if (buf.length <= maxBytes) return s
  let end = maxBytes
  // Back off off any utf-8 continuation byte (10xxxxxx).
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString("utf8")
}

// IMPORTANT: Never redact session IDs. Pattern-based (any `…session-id`/
// `session_id`/`sessionId` variant) so provider-specific header names —
// e.g. a vendor's `x-<vendor>-session-id` — are covered without naming
// any provider in core.
const SESSION_ID_KEY_RE = /session[-_]?id/i

/** True for every metadata key except session-id variants, which must stay visible for debugging. */
export function shouldRedact(key: string): boolean {
  return !SESSION_ID_KEY_RE.test(key)
}
