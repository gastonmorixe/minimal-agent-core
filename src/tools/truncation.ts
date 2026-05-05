/**
 * Universal tool-output guardrail.
 *
 * Every tool result passes through {@link truncateToolOutput} as the very
 * last step in {@link import("../tools.ts").executeTool}. The clamp enforces
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
export function truncateToolOutput(
  output: string,
  ctx: TruncateCtx = {},
): { content: string; info: TruncationInfo } {
  const bytes = Buffer.byteLength(output, "utf8")
  const lines = output.length === 0 ? 0 : output.split("\n").length
  const overBytes = bytes > MAX_TOOL_OUTPUT_BYTES
  const overLines = lines > MAX_TOOL_OUTPUT_LINES
  if (!overBytes && !overLines) {
    // Pass-through: still report the totals so the TUI can show
    // "1L · 87ch" style stats even when nothing was clamped. The body
    // and the totals coincide.
    return {
      content: output,
      info: {
        tool: ctx.tool,
        truncated: false,
        shownBytes: bytes,
        shownLines: lines,
        totalBytes: ctx.totalBytes ?? bytes,
        totalLines: ctx.totalLines ?? lines,
        cutLine: (ctx.startLine ?? 0) + lines,
        startLine: ctx.startLine,
      },
    }
  }

  // Snap to a line boundary first when the line budget hit.
  let kept = output
  if (overLines) kept = output.split("\n").slice(0, MAX_TOOL_OUTPUT_LINES).join("\n")
  // Then clamp bytes (handles single huge lines and post-line-clamp overflow).
  if (Buffer.byteLength(kept, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    kept = sliceUtf8(kept, MAX_TOOL_OUTPUT_BYTES)
    // Try to end on a newline if we're close enough — keeps line counts clean.
    const nl = kept.lastIndexOf("\n")
    if (nl >= MAX_TOOL_OUTPUT_BYTES * 0.9) kept = kept.slice(0, nl)
  }

  const shownBytes = Buffer.byteLength(kept, "utf8")
  const shownLines = kept.length === 0 ? 0 : kept.split("\n").length
  const cutLine = (ctx.startLine ?? 0) + shownLines
  const totalB = ctx.totalBytes != null ? String(ctx.totalBytes) : "unknown"
  const totalL = ctx.totalLines != null ? String(ctx.totalLines) : "unknown"
  const hint = ctx.hint ?? defaultHint(ctx.tool, cutLine, shownBytes)

  const content =
    kept +
    `\n\n[truncated: shown ${shownBytes} of ${totalB} bytes, ` +
    `${shownLines}/${totalL} lines; cut at byte ${shownBytes}, line ${cutLine}. ${hint}]`
  const info: TruncationInfo = {
    tool: ctx.tool,
    truncated: true,
    shownBytes,
    shownLines,
    totalBytes: ctx.totalBytes,
    totalLines: ctx.totalLines,
    cutLine,
    startLine: ctx.startLine,
  }
  return { content, info }
}

function defaultHint(tool: string | undefined, cutLine: number, shownBytes: number): string {
  switch (tool) {
    case "Read":
      return `to continue, call Read with offset=${cutLine} (and limit as needed).`
    case "Grep":
      return `narrow with a more specific pattern, glob, or smaller -A/-B/-C; or raise head_limit explicitly.`
    case "Bash":
      return `output exceeded ${MAX_TOOL_OUTPUT_BYTES} bytes; re-run piping through \`head -c ${shownBytes}\`, \`sed -n\`, or \`awk\` to bound output.`
    case "Glob":
      return `narrow the pattern or search a subdirectory.`
    default:
      return `re-run with narrower parameters.`
  }
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

// IMPORTANT: Never redact session IDs
export function shouldRedact(key: string): boolean {
  const NEVER_REDACT = ["session-id", "session_id", "sessionId", "x-claude-code-session-id"]
  return !NEVER_REDACT.some((nr) => key.toLowerCase().includes(nr.toLowerCase()))
}
