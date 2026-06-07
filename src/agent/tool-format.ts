/**
 * Tool input/output formatting for the agentic transcript: header
 * lines, continuation rows, and bordered output previews shown
 * inline between the `╭` and `╰` frames.
 *
 * Split out of `src/agent.ts` to keep that file under the `max-lines`
 * lint budget. Names are re-exported from `agent.ts` for back-compat
 * with existing consumers (`session-replay.ts`, tests, etc.).
 *
 * @module agent/tool-format
 */

import { shouldSoftSplit, splitBashSegments } from "../bash-split.ts"
import type { ToolUseBlock } from "../client.ts"
import { displayWidth, expandTabs, truncateDisplayWidth } from "../term-width.ts"
import { countLines, type TruncationInfo } from "../tools/truncation.ts"
import { truncHint } from "../truncate-hint.ts"

import { c } from "./ansi.ts"

/**
 * Per-tool char cap for the bordered tool **header** line ("╭ Bash $ ..."),
 * applied only when the input field truly overflows. The cap is generous
 * (500 chars for Bash, 200 for the JSON fallback) : much wider than the
 * old 80-ch hard slice that often cut Bash commands mid-token. We never
 * pad to terminal width; if the line overflows the terminal cells, the
 * terminal wraps and that's fine.
 */
const HEADER_BASH_MAX = 500
const HEADER_JSON_MAX = 200

/**
 * Trim `s` to at most `max` characters, preferring a word boundary so we
 * don't cut mid-token. The primary failure mode of the old hard slice
 * was things like `… | head...(+4ch)` : four characters short of
 * `head -50`, useless. Here we walk back to the last whitespace within
 * the trailing 15% of the budget and prefer it over a hard cut. If no
 * whitespace exists in that window (single-token blob), we fall through
 * to the hard cut so we never balloon past `max` itself.
 */
function trimAtWordBoundary(s: string, max: number): string {
  if (s.length <= max) return s
  const slack = Math.floor(max * 0.15)
  const window = s.slice(0, max)
  // Find the last whitespace within the last `slack` chars of the window.
  const wsIdx = window.search(/\s\S*$/)
  if (wsIdx >= max - slack) return s.slice(0, wsIdx)
  return window
}

/**
 * Max continuation lines we render for a multi-line Bash command in the
 * bordered block before collapsing the rest into a `> ... +NL more` row.
 * Generous enough to show typical heredocs / for-loops / function bodies
 * without dominating the screen.
 */
const BASH_CONT_MAX_LINES = 8

/**
 * Format a `tool_use` block's input for the bordered tool header. Picks
 * the most informative field per tool (command for Bash, file_path for
 * file tools, pattern for search tools). Falls back to JSON-stringified
 * input for unknown tools.
 *
 * Returns ONLY the header line (single-line, no embedded newlines).
 * Multi-line Bash commands render their continuation via the sibling
 * {@link formatToolInputContinuation} : the caller writes those after the
 * header as `│ ...` rows inside the same bordered block.
 *
 * # Style: programmer-native + dot-separated chunks
 *
 * Beyond the primary field (path/pattern/command), each tool can carry
 * "subordinate" inputs : `offset`/`limit` for Read, `replace_all` for
 * Edit, `path`/`glob`/`-i`/`-A`/etc. for Grep. Surfacing them in the
 * header is what lets the user see *what was actually run* (e.g.
 * "Read first 4 lines" vs. "Read whole file" : same tool name, very
 * different operation).
 *
 * The vocabulary is "Style A" : programmer-native shorthand:
 *
 *  - **Read**: `<path> · L<start>-<end>` (closed range, 1-indexed to match
 *    the body's line-number gutter), or `· from L<start>` (open-ended,
 *    `offset` only). Bare reads (neither set) render byte-identical to
 *    the pre-extras form.
 *  - **Edit**: `<path> · g` for `replace_all` (sed `s/.../.../g` flavor).
 *  - **Glob**: `<pattern> · in <path>` when `path` is set.
 *  - **Grep**: regex flags appended to the pattern (`/foo/i` for `-i`,
 *    `/foo/m` for `multiline`, `/foo/im` for both). Modifiers chain after
 *    ` · `: `in <path>` (where), `<glob>` (filter), `↓N`/`↑N`/`↕N` (after/
 *    before/around context : `-C` takes precedence over `-A`/`-B` since
 *    it's symmetric), `≤N` (`head_limit`), `count`/`paths` (output mode).
 *
 * The ` · ` mid-dot is the same separator used in the truncation footer
 * (`shown 15/1831 L · 8.0 KB/1.5 MB · cut at L1000`), keeping a single
 * visual language across the tool block.
 *
 * Truncation strategy:
 *  - **Bash**: first line only (multi-line continuation rendered separately
 *    by {@link formatToolInputContinuation}); word-boundary trim at 500 chars.
 *  - **Read/Write/Edit/Glob/Grep**: file_path / pattern only : typically
 *    well under 200 chars; no truncation in the common case. Composed
 *    Grep headers (all flags set) come in under ~80 cells in practice;
 *    if real usage ever overflows, prioritize pattern → path → context.
 *  - **Unknown**: JSON.stringify, hard slice at 200 chars (unknown tools
 *    have unknown shape, so word boundaries aren't meaningful).
 */
export function formatToolInput(tool: ToolUseBlock, cols?: number, headerKey?: string): string {
  const input = tool.input
  // Declarative header field (plugin tools): when the manifest names a
  // `headerKey` AND the input carries a non-empty string there, surface
  // exactly that value instead of the raw `{"k":"v"}` JSON fallback. This
  // is what lets a plugin tool paint a clean identifying header (the URL
  // for Fetch) synchronously, the instant the call starts — before the
  // handler has produced its richer `displayHeader`. Checked first so it
  // wins over the generic per-tool branches below for plugin tools (which
  // never match the built-in names anyway), but the guard keeps it inert
  // for built-ins and for malformed/absent fields.
  if (headerKey) {
    const v = input[headerKey]
    if (typeof v === "string" && v.length > 0) return v
  }
  if (tool.name === "Bash" && input.command) {
    const cmd = String(input.command)
    const firstNl = cmd.indexOf("\n")
    const firstLine = firstNl === -1 ? cmd : cmd.slice(0, firstNl)
    // Width-aware soft-split: when the first \n-line would overflow the
    // available terminal cells, route through `splitBashSegments` and
    // use only the lead segment in the header. The remaining segments
    // are emitted as `↳`-prefixed continuation rows by
    // `formatToolInputContinuation`, followed by the existing PS2 `> `
    // rows for any subsequent \n-lines (heredoc bodies, inline scripts).
    //
    // Soft-split applies to the FIRST \n-line independent of whether
    // there are more \n-lines after it : early versions gated this on
    // `firstNl === -1`, which made multi-line commands (python3 -c with
    // embedded \n, heredocs, for-loops) bypass soft-split entirely and
    // let the long first line truncate+wrap. Reported by user, May 2026.
    //
    // Default `cols` rule: when neither arg nor TTY width is available
    // (e.g. unit tests, piped output), treat as Infinity so we never
    // trigger soft-split : the lead-only header would otherwise be a
    // regression for non-TTY callers.
    const effectiveCols = cols ?? process.stdout.columns ?? Number.POSITIVE_INFINITY
    const headerBody = shouldSoftSplit(firstLine, effectiveCols)
      ? splitBashSegments(firstLine).lead || firstLine
      : firstLine
    const trimmed = trimAtWordBoundary(headerBody, HEADER_BASH_MAX)
    const charsCut = headerBody.length - trimmed.length
    const truncated = charsCut > 0 ? `${trimmed}${truncHint(charsCut, "ch")}` : trimmed
    // Header line only : continuation rendered by formatToolInputContinuation.
    return `$ ${truncated}`
  }
  if (tool.name === "Read" && input.file_path) {
    const path = String(input.file_path)
    // `offset` is zero-based in the schema; `execRead` prints body lines
    // 1-indexed (`${start + i + 1}\t…`), so we surface the same 1-indexed
    // range here and the header promise matches what the body shows.
    // Bare reads (no offset/limit) render byte-identical to the
    // pre-extras form : the common case is undisturbed.
    const off = typeof input.offset === "number" ? input.offset : undefined
    const lim = typeof input.limit === "number" ? input.limit : undefined
    if (off === undefined && lim === undefined) return path
    const startL = (off ?? 0) + 1
    if (lim !== undefined) return `${path} · L${startL}-${startL + lim - 1}`
    return `${path} · from L${startL}`
  }
  if (tool.name === "Write" && input.file_path) {
    return String(input.file_path)
  }
  if (tool.name === "Edit" && input.file_path) {
    const path = String(input.file_path)
    // `g` flag : borrowed from sed's `s/old/new/g`. Cheap, recognizable,
    // attaches the modifier visually to the path it modifies.
    return input.replace_all ? `${path} · g` : path
  }
  if (tool.name === "Glob" && input.pattern) {
    const pat = String(input.pattern)
    return input.path ? `${pat} · in ${input.path}` : pat
  }
  if (tool.name === "Grep" && input.pattern) {
    // Pattern carries its own JS-regex flags: `i` for -i, `m` for
    // multiline. Then ` · ` between major chunks: where (path, then
    // optional glob filter), context (↑↓↕N), head limit (≤N), output
    // mode. `-n` (line numbers) is intentionally not surfaced : it's the
    // default and would just clutter.
    const flags = `${input["-i"] ? "i" : ""}${input.multiline ? "m" : ""}`
    const parts: string[] = [`/${input.pattern}/${flags}`]
    if (input.path) parts.push(`in ${input.path}`)
    if (input.glob) parts.push(String(input.glob))
    // Context arrows. `-C N` (or its `context` alias) takes precedence :
    // it's symmetric so `↕` reads more naturally than two arrows. When
    // only `-A`/`-B` are set, render whichever (or both) are present.
    const ctxC = (input["-C"] as number | undefined) ?? (input.context as number | undefined)
    if (typeof ctxC === "number") {
      parts.push(`↕${ctxC}`)
    } else {
      if (typeof input["-A"] === "number") parts.push(`↓${input["-A"]}`)
      if (typeof input["-B"] === "number") parts.push(`↑${input["-B"]}`)
    }
    if (typeof input.head_limit === "number") parts.push(`≤${input.head_limit}`)
    if (input.output_mode === "count") parts.push("count")
    else if (input.output_mode === "files_with_matches") parts.push("paths")
    return parts.join(" · ")
  }
  const json = JSON.stringify(input)
  const charsCut = json.length > HEADER_JSON_MAX ? json.length - HEADER_JSON_MAX : 0
  return charsCut > 0 ? `${json.slice(0, HEADER_JSON_MAX)}${truncHint(charsCut, "ch")}` : json
}

/**
 * Continuation rows for a multi-line tool input : rendered as `│ ...` rows
 * between the header and the output. Currently emits rows only for
 * multi-line **Bash** commands; other tools have single-line headers.
 *
 * Each returned line carries a leading `> ` (mirroring bash's secondary
 * prompt) so it's visually distinguishable from output rows (which have
 * no prefix). Heredoc-shaped commands like:
 *
 * ```
 *   $ cat > /tmp/x.txt << "EOF"
 *   foo
 *   bar
 *   EOF
 * ```
 *
 * render as:
 *
 * ```
 *   ╭ » Bash  $ cat > /tmp/x.txt << "EOF"
 *   │ > foo
 *   │ > bar
 *   │ > EOF
 *   ╰ (no output)
 * ```
 *
 * Capped at {@link BASH_CONT_MAX_LINES} (default 8). Beyond the cap, a
 * synthetic last row reads `> ... +NL more` so the user knows the rest
 * was elided. Per-line word-boundary trim mirrors `formatToolInput`'s
 * 500-char Bash budget.
 */
export function formatToolInputContinuation(tool: ToolUseBlock, cols?: number): string[] {
  const input = tool.input
  if (tool.name !== "Bash" || !input.command) return []
  const cmd = String(input.command)
  const all = cmd.split("\n")
  const firstLine = all[0] ?? ""
  const tail = all.slice(1)
  const effectiveCols = cols ?? process.stdout.columns ?? Number.POSITIVE_INFINITY

  // Zone A : soft-split rows for the FIRST \n-line. Activates whenever
  // the first line would overflow AND has top-level operators
  // (`&&`, `||`, `|`, `;`) : independent of whether there are more
  // \n-lines after it. Each row is prefixed `↳ ` and leads with the
  // operator (shellcheck/shfmt convention). Visually distinct from
  // Zone B's `> ` PS2 rows.
  const softSplitRows: string[] = (() => {
    if (!shouldSoftSplit(firstLine, effectiveCols)) return []
    const { rest } = splitBashSegments(firstLine)
    if (rest.length === 0) return []
    return rest.map(({ op, body }) => {
      const segLine = `${op} ${body}`
      const trimmed = trimAtWordBoundary(segLine, HEADER_BASH_MAX)
      const charsCut = segLine.length - trimmed.length
      const finalBody = charsCut > 0 ? `${trimmed}${truncHint(charsCut, "ch")}` : trimmed
      return `↳ ${finalBody}`
    })
  })()

  // Zone B : PS2 (`> `) rows for subsequent \n-lines (heredoc bodies,
  // inline scripts, for-loop bodies). Existing behavior, preserved.
  const ps2Rows: string[] = tail.map((line) => {
    const trimmed = trimAtWordBoundary(line, HEADER_BASH_MAX)
    const charsCut = line.length - trimmed.length
    const body = charsCut > 0 ? `${trimmed}${truncHint(charsCut, "ch")}` : trimmed
    return `> ${body}`
  })

  // Combined cap. Concatenate Zone A then Zone B, then clip to
  // `BASH_CONT_MAX_LINES` with a single trailing elision row that
  // counts both elided categories together. Putting the cap on the
  // combined list (rather than per-zone) keeps the visual block from
  // ballooning when a model emits a long pipeline AND a multi-line
  // heredoc body in the same call.
  const combined = [...softSplitRows, ...ps2Rows]
  if (combined.length === 0) return []
  if (combined.length <= BASH_CONT_MAX_LINES) return combined
  const visible = combined.slice(0, BASH_CONT_MAX_LINES)
  const elided = combined.length - visible.length
  // Elision-row prefix mirrors whichever zone the LAST visible row
  // came from, so the eye stays oriented (`↳` if we cut inside the
  // operator-split zone, `>` if we cut inside the heredoc zone).
  const lastPrefix = visible[visible.length - 1].startsWith("↳ ") ? "↳" : ">"
  visible.push(`${lastPrefix} ${truncHint(elided, "L")} more`)
  return visible
}

/**
 * Cell count of the indent that continuation rows need *after* their
 * `  │ ` frame so the `↳`/`>` sigil aligns directly under the start of
 * the command body in the header row.
 *
 * Header layout (live agent):
 *
 * ```
 *   ╭ » Bash  $ cd /Users/...
 *               ^ command body starts here (col 14)
 * ```
 *
 * Continuation layout (what this indent achieves):
 *
 * ```
 *   │           ↳ && git push ...
 *               ^ ↳ aligned with `c` of `cd` (col 14)
 * ```
 *
 * The math walks the visible cells in the header BEFORE the command
 * body: icon (if any) + trailing space + label + 2-space gap + `$ `
 * sigil. Stripped ANSI is implicit because callers pass the bare text
 * (`tool.name`, manifest `icon`) not the colored render.
 *
 * Returns `0` for non-Bash tools (no continuation rows exist there
 * today). For Bash:
 *  - with `»` icon → 10 cells of padding
 *  - without icon (session-replay header) → 8 cells of padding
 *
 * Two emit sites consume this: `agent.ts` (live agent transcript) and
 * `session-replay.ts` (--resume scrollback rehydration). Keeping the
 * arithmetic in one helper makes both stay in sync if header shape
 * changes later.
 */
export function toolContinuationIndentCells(toolName: string, iconText?: string): number {
  if (toolName !== "Bash") return 0
  const iconCells = iconText ? displayWidth(iconText) + 1 : 0
  const labelCells = displayWidth(toolName)
  const gapCells = 2
  const cmdSigilCells = 2 // "$ " from formatToolInput
  return iconCells + labelCells + gapCells + cmdSigilCells
}

/**
 * Per-tool body line budget for the bordered transcript preview. Tuned by
 * shape of typical output:
 *  - **Bash**: 10 lines : output is variable; 10 covers "exit code + last
 *    few lines" without dominating the screen.
 *  - **Read**: 15 lines : content is dense (line-numbered) and structural;
 *    a few extra lines is high-value.
 *  - **Grep**: 12 lines : content mode; for files-only / count modes
 *    we'd want more, but those are explicit user choices and rarely hit
 *    the cap.
 *  - **Glob**: 25 lines : paths are short, dense, easy to scan.
 *  - **Default**: 10 lines : sensible mid-range for unknown tools.
 *
 * These are TUI display caps, not API caps. The model still sees up to
 * the universal {@link MAX_TOOL_OUTPUT_LINES} (1000 lines) per
 * `tool_result.content`. See `src/tools/truncation.ts` for the API cap.
 */
export const TOOL_PREVIEW_LINES: Record<string, number> = {
  Bash: 10,
  Read: 15,
  Grep: 12,
  Glob: 25,
  Edit: 1000, // diff display channel; effectively unbounded
  Write: 1000,
}
export const TOOL_PREVIEW_LINES_DEFAULT = 10

/**
 * Four flavors of model-only annotation can ride at the end of
 * `tool_result.content`:
 *
 *  - `\n\n[truncated: ...]`              : universal API-cap notice
 *    (see `tools/truncation.ts`).
 *  - `\n\n[note: ...]`                   : streak tracker note
 *    (see `tools/feedback-tracker.ts`).
 *  - `\n\n<ma::agent::output-preview …>…</ma::agent::output-preview>` : TUI elision hint
 *    (this file).
 *  - `\n\n<ma::agent::mode-active id="…" since="…" />`    : active-mode stamp
 *    (this file). Always last : it's the freshest signal the model
 *    should re-read at the very tail of each tool_result.
 *
 * Order at end of content is fixed (above). `findAnnotationStart`
 * returns the index of the EARLIEST true annotation (= start of the
 * annotation region) so callers can slice the body cleanly. Using
 * per-pattern `lastIndexOf` (not a single regex with `.match()`)
 * hardens against the case where the body itself legitimately
 * contains the prefix (e.g. a `Read` of a log that happens to
 * include the string `[truncated:`) : the last occurrence is the
 * real annotation, body-internal occurrences are earlier.
 *
 * Convention note: `[truncated:]` and `[note:]` are legacy
 * bracket-string shapes. New annotations use the `<ma::…>` XML-like
 * namespace (TODOS.md#T-ca2ce1). When the legacy ones are eventually
 * retrofitted (cross-version replay-breaking change), this collapses
 * to a single `<ma::…>` test.
 */
const ANNOTATION_PREFIXES = [
  "\n\n[truncated:",
  "\n\n[note:",
  "\n\n<ma::agent::output-preview",
  "\n\n<ma::agent::mode-active",
] as const

function findAnnotationStart(content: string): number {
  let earliest = -1
  for (const p of ANNOTATION_PREFIXES) {
    const i = content.lastIndexOf(p)
    if (i >= 0 && (earliest < 0 || i < earliest)) earliest = i
  }
  return earliest
}

/**
 * Compute the TUI vs body line gap for the `<ma::agent::output-preview>` annotation.
 * Returns `null` when the body fits in the per-tool budget or there's no
 * body at all.
 *
 * Strips any trailing annotation from `content` before counting lines, so
 * re-application of the note is idempotent (a peer agent's prior note in
 * historical content doesn't double up). The line count is taken AFTER
 * stripping, so the note reads "user saw N of M lines of *what you saw*"
 * : accurate even when the API ALSO truncated (in which case `[truncated:]`
 * carries the separate source→model ratio).
 */
export function computeTuiElision(
  content: string,
  tool: string,
): { shown: number; total: number } | null {
  const idx = findAnnotationStart(content)
  const body = idx >= 0 ? content.slice(0, idx) : content
  if (!body) return null
  // Allocation-free line count (see countLines). This runs on the model's
  // full tool_result content; counting by scanning avoids materializing a
  // per-line array we'd immediately discard (Bug 4).
  const total = countLines(body)
  const budget = TOOL_PREVIEW_LINES[tool] ?? TOOL_PREVIEW_LINES_DEFAULT
  if (total <= budget) return null
  return { shown: budget, total }
}

/**
 * Per-tool hint body for `<ma::agent::output-preview>`. Bash is the worst offender
 * (model often picks it as a "render visual content to the user" channel
 * even though the transcript clamps at 10 lines), so we point it at the
 * right channel explicitly. Other tools get a gentler "summarize for the
 * user" nudge.
 */
export function tuiPreviewHint(tool: string): string {
  switch (tool) {
    case "Bash":
      return (
        "the user only saw a fraction of this output. If you used Bash to " +
        "render visual content (ASCII art, ANSI TUI preview, formatted " +
        "tables) for the user, put it in your text reply instead : the " +
        "user reads that in full."
      )
    default:
      return (
        "the user only saw a fraction of this output. If you intended this " +
        "for the user, summarize the key parts in your text reply (the " +
        "user reads it in full)."
      )
  }
}

/**
 * Hard per-line cap for body lines. Protects against pathological cases
 * (e.g. a 10_000-char minified JSON line in a `Read` result) on terminals
 * wider than this value : without the cap, one mega-line would still
 * dominate the preview even when it physically fits. 300 cells is
 * generous enough to read most code and structured output.
 *
 * The terminal width takes precedence when narrower : see
 * {@link effectiveBodyLineWidth}. Lines are truncated **at render time**
 * with the current `process.stdout.columns` (or the snapshot the caller
 * passed via `opts.cols`), so a body line never overflows the visible
 * column count and the terminal never has to wrap it. Scrollback is
 * permanent : a later resize does not re-render older blocks, but every
 * new tool block paints correctly under the new width.
 */
const TOOL_PREVIEW_LINE_WIDTH = 300
export const TOOL_PREVIEW_GUTTER_WIDTH = 4
const TOOL_PREVIEW_WRAP_SAFETY_WIDTH = 1

/**
 * Compute the safe body width for a tool transcript line as
 * `terminal_cols - gutter - wrap_safety`. Returns `undefined` when the
 * caller has no width signal (non-TTY contexts like unit tests where
 * `process.stdout.columns` is also unset). That sentinel lets the
 * display-channel branch (Edit/Write diffs) opt out of clamping when
 * width is unknown : tests get deterministic full-width output, and
 * production gets a real number.
 *
 * The `gutter` accounts for the `"  │ "` (or `"  ╰ "`) prefix every row
 * carries (4 cells); the 1-cell `WRAP_SAFETY` keeps a column free at the
 * right edge so a single off-by-one in a wide-glyph terminal can't tip
 * the line into a wrap.
 */
function toolPreviewBodyWidth(cols?: number): number | undefined {
  const raw = cols ?? process.stdout.columns
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined
  const max = Math.floor(raw) - TOOL_PREVIEW_GUTTER_WIDTH - TOOL_PREVIEW_WRAP_SAFETY_WIDTH
  return max > 0 ? max : 0
}

/**
 * Body-line render width for the main preview path : the effective
 * `min(terminal_cols - gutter - safety, TOOL_PREVIEW_LINE_WIDTH)`.
 *
 * Always returns a positive integer. When the terminal width signal is
 * missing OR pathologically small (≤ gutter), falls back to the fixed
 * hard cap so the behavior in unit tests (no TTY, no `cols` argument)
 * stays deterministic at 300 cells. In production with a real TTY the
 * terminal-derived width almost always wins (e.g. an 127-col terminal
 * gives 127 − 4 − 1 = 122, well below the 300 cap).
 *
 * Mirrors the semantic of `toolPreviewBodyWidth` but collapses the
 * "no width" sentinel to the hard cap so callers don't need a separate
 * fallback branch.
 */
export function effectiveBodyLineWidth(cols?: number): number {
  const termBased = toolPreviewBodyWidth(cols)
  if (termBased === undefined || termBased <= 0) return TOOL_PREVIEW_LINE_WIDTH
  return Math.min(termBased, TOOL_PREVIEW_LINE_WIDTH)
}

function clampToolPreviewBodyLine(line: string, maxWidth: number | undefined): string {
  if (maxWidth === undefined || displayWidth(line) <= maxWidth) return line
  // Delegate to the shared `clampBodyWithHint` so the display branch
  // (Edit/Write diffs, tasks plugin display, etc.) gets the same
  // `...(+Nch)` truncation marker the content path has been emitting
  // since the May 2026 width-clamp work. Previously this used a bare
  // `truncateDisplayWidth(line, maxWidth, "...")` which dropped the
  // count, leaving the user unable to tell at-a-glance how much got
  // cut off the end of a long task title (or any other plugin-rendered
  // line). One canonical truncation idiom across all transcript rows.
  return clampBodyWithHint(line, maxWidth)
}

/**
 * Width budget reserved for the `truncHint("ch")` marker
 * (`...(+NNNNch)`) when a body line is clamped. The marker is appended
 * AFTER the trim, so the trim itself must leave room for it inside
 * `maxWidth` : otherwise `body = trimmed + hint` exceeds the visible
 * column count and the terminal soft-wraps the row into the gutter.
 *
 * 12 cells covers `"...(+99999ch)"` (worst realistic case for `head -c`
 * sized output) ; rare overshoots (cut > 99_999 chars) drift one cell
 * past the cap, far below the `WRAP_SAFETY` slop on the outside of the
 * row. Picked over an iterative "compute hint width, re-trim" loop for
 * simplicity : the lost 1–2 body cells are imperceptible.
 */
const TOOL_PREVIEW_HINT_RESERVE_WIDTH = 12

/**
 * Trim a body line to `maxWidth` cells with the standard `...(+Nch)`
 * truncation marker. Reserves {@link TOOL_PREVIEW_HINT_RESERVE_WIDTH}
 * cells for the marker so the rendered total (`trimmed + hint`) never
 * exceeds `maxWidth`. Returns the line unmodified when it already fits.
 *
 * Shared by the live Bash stream renderer (`flushLineToBuffer`) and the
 * batched `formatToolPreview` body path so both paths produce identical
 * shape under identical widths.
 */
export function clampBodyWithHint(line: string, maxWidth: number): string {
  if (displayWidth(line) <= maxWidth) return line
  const trimWidth = Math.max(1, maxWidth - TOOL_PREVIEW_HINT_RESERVE_WIDTH)
  const trimmed = truncateDisplayWidth(line, trimWidth, "")
  // eslint-disable-next-line typescript-eslint/no-misused-spread
  const cpCut = [...line].length - [...trimmed].length
  return `${trimmed}${truncHint(cpCut, "ch")}`
}

/**
 * Outer-row clamp for a fully-composed transcript line including its
 * gutter prefix (`  ╭ …` / `  │ …` / `  ╰ …`). When `cols` is known
 * and the row's display width exceeds it, truncate to fit with the
 * standard `...(+Nch)` hint marker; otherwise pass through verbatim.
 *
 * Used by `writeToolHeader` to catch the cases the inner soft-split
 * machinery doesn't cover : Bash commands with no operators that
 * overflow, long single-path Read/Write/Edit/Glob/Grep headers,
 * generic JSON-fallback headers. The body preview path already
 * handles this in `formatToolPreview` (see `clampBodyWithHint`).
 *
 * Trade-off: when a header truly overflows, the trailing time-hint
 * suffix (` · 07:30:26`) gets eaten by the trim. That's preferable to
 * the alternative (preserve time, lose the path tail) since the path
 * tail is far more semantically valuable than the timestamp.
 */
export function clampTranscriptRow(row: string, cols?: number): string {
  if (cols === undefined || !Number.isFinite(cols) || cols <= 0) return row
  const maxWidth = Math.floor(cols) - TOOL_PREVIEW_WRAP_SAFETY_WIDTH
  if (maxWidth <= 0) return row
  return clampBodyWithHint(row, maxWidth)
}

/**
 * Format the body of a `tool_result` for the bordered transcript preview.
 *
 * Audience split (this matters): the **model** receives the full clamped
 * `content` including the trailing `[truncated: shown N of M bytes ...]`
 * notice with its action-verb resume hint. The **TUI** (you, looking at
 * the transcript) receives this function's output: the body preview only,
 * plus a bare-facts footer (`shown N/M L · X/Y B · cut at L`) when
 * truncation happened. No verbs, no advice : those go to the model where
 * they're actionable.
 *
 * The `info` parameter, when supplied (see `executeTool`'s `_truncInfo`),
 * is the source of truth for the footer. Without it we fall back to the
 * pre-info legacy behavior (slice at 200 chars + `...(+Nch)` hint) so
 * older callers keep working.
 *
 * Per-tool body line budgets live in {@link TOOL_PREVIEW_LINES}; per-line
 * display width is capped at {@link TOOL_PREVIEW_LINE_WIDTH}.
 */

/**
 * True when `line` is the **outer frame closer** of a tool transcript block
 * (the bottom-left `╰` glyph in the gutter). The live-area sink uses this
 * signal to add one blank row of breathing room before the next block.
 *
 * The discriminator must be specific to the **outer-gutter** position
 * (immediately after the 2 leading spaces and any ANSI prefix), NOT a
 * blanket "anywhere in the line" check : body content can legitimately
 * carry `╰` as a tree-last connector (e.g. the tasks plugin's `treeLast`
 * glyph in the subtask block), in titles, in user-supplied filenames,
 * etc. A blanket match misclassifies those rows as block-closers and
 * the sink emits an extra `\n`, producing a bare blank row with no `│`
 * gutter behind it.
 *
 * Recognized shapes (all match):
 *   "  ╰ 5 done · 1 doing · 2 todo"
 *   "  \x1b[36m╰\x1b[0m  0/3"
 *   "  \x1b[36;2m╰\x1b[0m"               (just the glyph, no body)
 *
 * Non-matches (body rows that happen to contain ╰):
 *   "  │        ╰  ○  #abc  Add regression test"   ← tasks treeLast
 *   "  │ note: file named ╰.txt"                   ← body content
 */
// Match the outer-gutter `╰`: start-of-line, optional ≤2 leading spaces
// (the gutter indent), then any number of ANSI CSI SGR sequences
// (`\x1b[<digits-and-semicolons>m`), then the `╰` glyph. Anchored at
// `^` so it cannot fire on `╰` appearing later in the body.
//
// Why CSI-only: every glyph emitted at this position goes through one of
// the `c.*` color combinators in this file, which exclusively use SGR
// (CSI `m`) sequences : we don't need to handle OSC / DCS / etc. here.
const OUTER_FRAME_CLOSE_RE = /^ {0,2}(?:\x1b\[[\d;]*m)*╰/

/**
 * Detect whether a transcript line is the outermost-gutter `╰` closer of
 * a tool block (as opposed to a body line that incidentally contains the
 * `╰` glyph — e.g. tasks subtree connectors, Bash grep output, Edit diff
 * bodies). Used by `runReplLiveArea`'s transcript sink to decide whether
 * to emit the extra trailing `\n` that visually separates one tool block
 * from the next.
 *
 * Strict anchor at `^`, ≤2 leading spaces (the outer gutter indent),
 * optional SGR CSI sequences for color, then `╰`. NOT a substring match —
 * see regression coverage in `src/agent.outer-frame-close.test.ts`.
 */
export function isOuterFrameClose(line: string): boolean {
  return OUTER_FRAME_CLOSE_RE.test(line)
}

/**
 * Render a tool's result block for the transcript: the rows between
 * `╭ <header>` (written separately by the caller) and the closing `╰`.
 * Inserts the `│ ` gutter on each row, applies the per-tool body line
 * budget (`TOOL_PREVIEW_LINES`), and appends a structured footer for
 * truncation / line-count overflow when applicable.
 *
 * When `display` is provided AND `isError` is falsy, the pre-rendered
 * ANSI string (Edit/Write diffs, plugin custom payloads) is emitted
 * verbatim without truncation — diffs and structured renders are the
 * point of the override channel.
 *
 * @param content   Raw tool output (model-facing payload); may carry a
 *                  trailing `[truncated: ...]` notice which is stripped
 *                  before display (the human-facing footer carries the
 *                  same facts in compact form).
 * @param isError   When true, render bias toward visibility (no display
 *                  override, no overflow trim).
 * @param display   Optional pre-rendered ANSI payload to use instead of
 *                  the truncated `content`.
 * @param opts      `tool` (line budget), `info` (truncation facts for
 *                  the footer), `footer` (display-mode footer override),
 *                  `cols` (per-line clamp width).
 */
export function formatToolPreview(
  content: string,
  isError?: boolean,
  display?: string,
  opts?: { tool?: string; info?: TruncationInfo; footer?: string; cols?: number },
): string[] {
  // If the tool provided a pre-rendered display string (e.g. ANSI-colored
  // unified diff from Edit/Write), render it as-is, line by line, with the
  // standard `│ ... └` connector gutter. Per-line clamp to the live
  // terminal width still applies so a 400-char diff line in a 90-col
  // terminal doesn't soft-wrap into the gutter ; we don't apply the 300-
  // cell preview cap here (diffs are the point on wide terminals). When
  // the caller has no width signal (e.g. unit tests with no TTY and no
  // `opts.cols`), `toolPreviewBodyWidth` returns `undefined` and
  // `clampToolPreviewBodyLine` becomes a no-op : full-width verbatim
  // output for tests, terminal-aware clamping in production.
  if (display !== undefined && !isError) {
    const out: string[] = []
    const footer = opts?.footer
    const bodyWidth = toolPreviewBodyWidth(opts?.cols)
    const body = footer === undefined ? display.replace(/\n$/, "") : display
    const dlines = body.length === 0 ? [] : body.split("\n")
    if (dlines.length === 0 && footer === undefined) {
      out.push(`  ${c.dimCyan("╰")}`)
      return out
    }
    for (let i = 0; i < dlines.length; i++) {
      const connector = footer === undefined && i === dlines.length - 1 ? "╰" : "│"
      const line = clampToolPreviewBodyLine(dlines[i], bodyWidth)
      out.push(
        line.length === 0 ? `  ${c.dimCyan(connector)}` : `  ${c.dimCyan(connector)} ${line}`,
      )
    }
    if (footer !== undefined) {
      const footerLine = clampToolPreviewBodyLine(footer, bodyWidth)
      out.push(
        footerLine.length === 0 ? `  ${c.dimCyan("╰")}` : `  ${c.dimCyan("╰")} ${footerLine}`,
      )
    }
    return out
  }

  const tool = opts?.tool
  const info = opts?.info
  const color = isError ? c.red : c.dim

  // 1. Strip ALL model-only trailing annotations from what we display to
  //    the human. Three flavors today : `[truncated: ...]`, `[note: ...]`,
  //    `<ma::agent::output-preview ...>...</ma::agent::output-preview>` (see
  //    `findAnnotationStart`). They live at end-of-content separated by
  //    `\n\n` and stack in a fixed order, so the earliest of their
  //    last-occurrences is the start of the annotation region and we slice
  //    from there. The structured `info` (when supplied) carries the same
  //    truncation numbers in machine form : we render those as the
  //    bare-facts footer instead.
  const noticeIdx = findAnnotationStart(content)
  let body = noticeIdx >= 0 ? content.slice(0, noticeIdx) : content

  // 2. Per-line width clamp (display-width-aware so wide chars / emoji /
  //    CJK don't blow past the budget). The clamp is the effective body
  //    width : `min(terminal_cols - gutter, TOOL_PREVIEW_LINE_WIDTH)`.
  //    Without the terminal-width factor an N-cell preview line in an
  //    M-col terminal where N > M would soft-wrap and produce the
  //    "  │ start..." / "...end of line" split scrollback (user-reported,
  //    May 2026). Scrollback never re-renders on resize, but every new
  //    tool block paints under the live width. See {@link
  //    effectiveBodyLineWidth} for the cap rationale and {@link
  //    clampBodyWithHint} for the hint-reserve detail.
  const maxLines = TOOL_PREVIEW_LINES[tool ?? ""] ?? TOOL_PREVIEW_LINES_DEFAULT
  const allLines = (body || "(no output)").split("\n")
  const visible = allLines.slice(0, maxLines)
  const linesElided = allLines.length - visible.length
  const lineWidth = effectiveBodyLineWidth(opts?.cols)
  // Expand `\t` to spaces using the gutter as the starting column. A
  // literal tab is a 0-cell glyph under `displayWidth` but the
  // terminal renders it as an advance to the next tab stop, so
  // without this the body row can overflow the visible columns by up
  // to one tab-size and wrap into the gutter. Common offender is
  // Read's `<linenum>\t<content>` format (see `expandTabs` rationale).
  const renderedLines: string[] = visible.map((line) =>
    clampBodyWithHint(expandTabs(line, TOOL_PREVIEW_GUTTER_WIDTH), lineWidth),
  )

  // 3. Build the footer.
  //    The footer always reads "shown <visible-in-TUI> / <real-source-total>"
  //    : one ratio, two domains. The user immediately sees how much of the
  //    underlying tool result they're actually looking at.
  //    - API truncation present (info.truncated): include byte ratio
  //      (model-shown / source-total) and the cut line.
  //    - TUI-only elision (long body but the API did not clamp): just the
  //      line ratio. Bytes are uniformative when nothing was cut at the API.
  //    - Body fits within budget AND no API truncation: no footer at all.
  let footerStat: string | null = null
  if (info?.truncated) {
    footerStat = formatTruncFooter(info, visible.length)
  } else if (linesElided > 0) {
    const totalLines = info?.totalLines ?? allLines.length
    footerStat = `shown ${visible.length}/${totalLines} L`
  }

  // 4. Stitch lines + footer with the bordered gutter.
  //    When a truncation footer is present we slot a `┊` (light-dotted
  //    vertical) row between the last body line and the `╰ <footer>` row.
  //    The dotted glyph reads as "something has been cut here" : visually
  //    foreshadowing the bare-facts footer below it (e.g. `shown 10/520 L`).
  //    No `┊` is emitted on a clean run (body fits, no API clamp): in that
  //    case there's nothing missing, so the body just closes with `╰`.
  const out: string[] = []
  const totalRender = renderedLines.length
  for (let i = 0; i < totalRender; i++) {
    // Last rendered line is `╰` only when there's no footer below it.
    const isLast = i === totalRender - 1 && footerStat === null
    const connector = isLast ? "╰" : "│"
    out.push(`  ${c.dimCyan(connector)} ${color(renderedLines[i])}`)
  }
  if (footerStat !== null) {
    out.push(`  ${c.dimCyan("┊")}`)
    out.push(`  ${c.dimCyan("╰")} ${c.dim(footerStat)}`)
  }
  return out
}

/**
 * Emit the closing rows for a tool whose body was already streamed `│`-line
 * by `│`-line into scrollback (live, while the child process ran). We held
 * back the LAST emitted line so we can either:
 *
 *   - rewrite it as `╰ <line>` when there's nothing to summarize (clean
 *     run, body fits in budget, no truncation), OR
 *   - emit it as `│ <line>`, then a `┊` truncation separator, then a
 *     `╰ <footer>` row when there IS something to say (truncation, elision,
 *     or zero-output abort). The `┊` reads as "something cut here" and
 *     visually foreshadows the bare-facts footer (e.g. `shown 10/520 L`).
 *
 * Scrollback is permanent : once a `│` row is written we can't rewrite it
 * : so the buffered-last-line trick is the only way to keep the close
 * glyph attached to the body in the no-footer case.
 *
 * Mirrors the audience-split invariant in {@link formatToolPreview}: footer
 * carries bare facts (lines / bytes / cut location); no verbs / advice.
 * Mirrors its `┊`-before-`╰` convention too, so streamed and non-streamed
 * tool blocks have identical shape from the user's eye.
 */
export function renderStreamedTail(opts: {
  bufferedLastLine: string | null
  streamedLineCount: number
  budget: number
  truncInfo?: TruncationInfo
  isError?: boolean
  writeTranscript: (line: string) => void
}): void {
  const { bufferedLastLine, streamedLineCount, budget, truncInfo, isError, writeTranscript } = opts
  const visibleCount = Math.min(streamedLineCount, budget)
  const color = isError ? c.red : c.dim

  let footer: string | null = null
  if (truncInfo?.truncated) {
    footer = formatTruncFooter(truncInfo, visibleCount)
  } else if (streamedLineCount > budget) {
    const totalLines = truncInfo?.totalLines ?? streamedLineCount
    footer = `shown ${visibleCount}/${totalLines} L`
  }

  if (bufferedLastLine === null) {
    // Stream produced nothing (shouldn't happen : caller only invokes us
    // when didStream=true, which implies at least one flushLineToBuffer
    // call). Defensive close glyph anyway. Skip the `┊` separator: with
    // zero body rows above it, a dotted divider has nothing to "cut from"
    // and would just look like floating noise.
    writeTranscript(`  ${c.dimCyan("╰")} ${c.dim(footer ?? "(no output)")}`)
    return
  }

  if (footer === null) {
    writeTranscript(`  ${c.dimCyan("╰")} ${color(bufferedLastLine)}`)
    return
  }

  writeTranscript(`  ${c.dimCyan("│")} ${color(bufferedLastLine)}`)
  writeTranscript(`  ${c.dimCyan("┊")}`)
  writeTranscript(`  ${c.dimCyan("╰")} ${c.dim(footer)}`)
}

/**
 * Format a {@link TruncationInfo} as the bare-facts footer string.
 * No verbs, no advice : totals and cut location only.
 *
 * Format: `shown <V>/<T> L · <X>/<Y> B · cut at L<L>`
 *
 *   - **V** = lines visible in the TUI right now (`tuiVisible` argument).
 *     This is what the user is looking at : the most user-relevant count.
 *   - **T** = total lines the underlying source produced (`info.totalLines`).
 *     The denominator the user cares about ("how big was this really?").
 *   - **X** = bytes shown to the model (`info.shownBytes`). Note: this is
 *     model-domain, not user-domain : the user sees fewer body bytes than
 *     the model when the TUI body budget is below the API cap. Showing
 *     model-bytes here gives the user the size of the actual `tool_result`
 *     ride-back, which is what tokens are spent on.
 *   - **Y** = total bytes from the source (`info.totalBytes`).
 *   - **L** = cut line index (`info.cutLine`).
 */
function formatTruncFooter(info: TruncationInfo, tuiVisible: number): string {
  const totalL = info.totalLines ?? info.shownLines
  const totalB = info.totalBytes ?? info.shownBytes
  const lineFrag = `shown ${tuiVisible}/${totalL} L`
  const byteFrag = `${formatBytes(info.shownBytes)}/${formatBytes(totalB)}`
  const cutFrag = `cut at L${info.cutLine}`
  return `${lineFrag} · ${byteFrag} · ${cutFrag}`
}

/** Format byte counts with K/M suffix for compactness. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
