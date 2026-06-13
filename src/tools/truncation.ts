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
 * Applies the universal tool-output guardrail: clamps a body that exceeds
 * the byte or line cap (cutting on a UTF-8 boundary), appends a structured
 * truncation notice, and reports the original totals either way so the TUI
 * can show size stats. Untruncated bodies pass through byte-identical.
 */
export function truncateToolOutput(
  output: string,
  ctx: TruncateCtx = {},
): { content: string; info: TruncationInfo } {
  const bytes = Buffer.byteLength(output, "utf8")
  // Allocation-free count (see countLines). Keeps the empty-string guard:
  // `"".split("\n").length` is 1, but truncation has always reported 0
  // lines for an empty body, so preserve that exactly.
  const lines = output.length === 0 ? 0 : countLines(output)
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
  const shownLines = kept.length === 0 ? 0 : countLines(kept)
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
    case "Fetch":
      // Plugin tool. Clamped by the agent now that raw is recoverable
      // via the blob store. Steer toward narrowing rather than re-fetch.
      return `the full body is preserved at the \`<ma::agent::raw-output … />\` path below; use Read on that path, or re-call Fetch with a CSS \`selector\` to scope to a specific element.`
    case "WebSearch":
      return `lower \`count\`, narrow the query, or use the result's \`url\` to Fetch a specific page.`
    default:
      // Plugin tools we don't know about land here. The pointer footer
      // appended by the agent below tells the model where to find the
      // full bytes, so the "narrower parameters" copy doesn't strand it.
      return `re-run with narrower parameters; the full body is preserved at the \`<ma::agent::raw-output … />\` path below.`
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

// IMPORTANT: Never redact session IDs. Pattern-based (any `…session-id`/
// `session_id`/`sessionId` variant) so provider-specific header names —
// e.g. a vendor's `x-<vendor>-session-id` — are covered without naming
// any provider in core.
const SESSION_ID_KEY_RE = /session[-_]?id/i

/** True for every metadata key except session-id variants, which must stay visible for debugging. */
export function shouldRedact(key: string): boolean {
  return !SESSION_ID_KEY_RE.test(key)
}
