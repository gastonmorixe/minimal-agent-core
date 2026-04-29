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
 * Clamp `output` to the byte/line budgets and append a structured truncation
 * notice when anything was cut. Returns `output` unchanged when within budget.
 */
export function truncateToolOutput(output: string, ctx: TruncateCtx = {}): string {
  const bytes = Buffer.byteLength(output, "utf8")
  const lines = output.length === 0 ? 0 : output.split("\n").length
  const overBytes = bytes > MAX_TOOL_OUTPUT_BYTES
  const overLines = lines > MAX_TOOL_OUTPUT_LINES
  if (!overBytes && !overLines) return output

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

  return (
    kept +
    `\n\n[truncated: shown ${shownBytes} of ${totalB} bytes, ` +
    `${shownLines}/${totalL} lines; cut at byte ${shownBytes}, line ${cutLine}. ${hint}]`
  )
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
