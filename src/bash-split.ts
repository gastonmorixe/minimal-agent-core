/**
 * Pure utility for splitting a single-line shell command at top-level
 * shell operators (`&&`, `||`, `|`, `;`).
 *
 * # Why this module exists
 *
 * The TUI renders Bash tool calls inside a bordered block. When the
 * model emits a one-line pipeline like
 *
 *   `cd /a/very/long/path && grep -n -i "foo|bar" file.md | head -10`
 *
 * the line is *technically* one logical command (no `\n`s), so the
 * existing `\n`-aware continuation machinery doesn't trigger. The
 * terminal then hard-wraps the line at column N with zero awareness of
 * shell syntax — it cuts mid-token, the `&&` and `|` get visually lost,
 * and the user can't quickly see the structure of the pipeline.
 *
 * This module provides the syntax-aware splitter that the renderer uses
 * to break the header at logical operator boundaries instead. The
 * renderer side decides *when* to invoke the split (only when the line
 * would overflow) — see {@link shouldSoftSplit}.
 *
 * # Why pure / dependency-free
 *
 * - **Reusable.** A "what does this command do?" preview, a structured
 *   tool-call log, a syntax-highlighted history viewer — all want the
 *   same operator decomposition.
 * - **Testable.** No mocks of `process.stdout.columns`, no compositor,
 *   no rendering — the tokenizer is a pure function from `string` to
 *   `{ lead, rest }`.
 * - **Cheap.** Single-pass character scan, no regex backtracking, no
 *   allocations beyond the result.
 *
 * # What this module does NOT try to do
 *
 * It is **not** a full POSIX shell parser. We intentionally:
 *
 * - Do not understand heredocs (`<<EOF`). They require `\n` already, so
 *   the existing `\n`-split path handles them upstream.
 * - Do not understand reserved words (`if`/`then`/`fi`, `case`/`esac`,
 *   `for`/`do`/`done`). Multi-line control structures take the `\n`
 *   path; one-line `if cmd; then x; fi` flavours will split at the `;`
 *   tokens, which is reasonable visually.
 * - Do not split on bare `&` (background). Backgrounding is rare in
 *   interactive tool calls, and splitting `cmd1 & cmd2` would visually
 *   suggest a sequence, which is misleading.
 * - Do not handle ANSI-C `$'...'` quoting differently from `'...'` —
 *   close enough for the splitter's purpose since the body of either is
 *   never a top-level operator.
 *
 * # Operator semantics (broadest-to-narrowest, matched longest-first)
 *
 * - `&&` — AND-list (run RHS only if LHS exits 0)
 * - `||` — OR-list (run RHS only if LHS exits non-zero)
 * - `|`  — pipe (stdout of LHS to stdin of RHS)
 * - `;`  — sequence (always run RHS after LHS)
 *
 * Multi-character operators are listed first in {@link BASH_OPERATORS}
 * so the prefix probe doesn't mis-match `&&` as `&` + `&`.
 *
 * @module bash-split
 */

import { displayWidth } from "./term-width.ts"

/**
 * Default cell budget consumed by the bordered Bash tool header before
 * the command body starts. Mirrors the shape
 *
 *     `  ╭ » Bash  $ `
 *      ↑↑↑↑↑↑↑↑↑↑↑↑↑↑
 *      14 cells
 *
 * (2 leading spaces, `╭`, space, `»`, space, `Bash`, two spaces, `$`,
 * space). Callers can override the value if their prefix differs.
 *
 * Keeping this here rather than baking the literal 14 into
 * {@link shouldSoftSplit} means the splitter can be reused by other
 * renderers (different prefixes) without duplicating the predicate.
 */
export const BASH_HEADER_PREFIX_CELLS_DEFAULT = 14

/**
 * Top-level shell operators we split on, in **longest-prefix-first**
 * order. The order is load-bearing: when probing at index `i` the
 * tokenizer walks this list and takes the first match, so multi-char
 * operators must come before any of their single-char prefixes
 * (`&&` ↛ `&`, `||` ↛ `|`).
 *
 * `as const` makes the array literal a readonly tuple of string
 * literals, so `BashOperator` is a precise union rather than `string`.
 */
export const BASH_OPERATORS = ["&&", "||", "|", ";"] as const

/** A single shell operator we split on. */
export type BashOperator = (typeof BASH_OPERATORS)[number]

/**
 * One non-leading segment in a split command — the operator that joins
 * it to the previous segment, plus the trimmed body.
 *
 * Example: `splitBashSegments("a && b | c")` returns
 *   `{ lead: "a", rest: [{op:"&&", body:"b"}, {op:"|", body:"c"}] }`
 *
 * The renderer typically prints each rest entry as
 *   `↳ <op> <body>`
 * on its own row.
 */
export type BashSegment = {
  /** The operator that joins this segment to the segment before it. */
  op: BashOperator
  /** The trimmed body of the segment (no leading/trailing whitespace). */
  body: string
}

/**
 * Result of splitting a shell command at top-level operators.
 *
 * - `lead` — the first segment, before any operator. Trimmed. May be
 *   empty when the input starts with a (pathological) bare operator.
 * - `rest` — zero or more `{op, body}` pairs in source order. Empty
 *   bodies are dropped (so a trailing `cmd1 &&` collapses to just
 *   `{lead:"cmd1", rest:[]}`).
 */
export type BashSplitResult = {
  lead: string
  rest: BashSegment[]
}

/**
 * Split a single-line shell command at **top-level** operators (`&&`,
 * `||`, `|`, `;`), respecting quotes, escapes, and subshell /
 * parameter-expansion nesting.
 *
 * # Tokenizer rules
 *
 * - **Backslash escape (`\`)** — the next character is consumed verbatim
 *   regardless of context (even inside the operator probe). This means
 *   `\&\&` is never matched as `&&`.
 * - **Quotes** — `'…'`, `"…"`, and `` `…` `` open a quoted region;
 *   operator probing is suppressed until the matching closing quote.
 *   Quotes do not nest (entering `"` while inside `'` is part of the
 *   single-quoted body, etc.).
 * - **Subshell / parameter expansion** — `$(`, `${`, and bare `(`
 *   increment a depth counter; matching `)` / `}` decrement it.
 *   Operator probing is suppressed while depth > 0. Nested subshells
 *   work because depth is a counter, not a flag.
 * - **Operator probe** — at each top-level position the tokenizer walks
 *   {@link BASH_OPERATORS} in order and takes the first match. Order is
 *   load-bearing (multi-char before single-char prefix).
 *
 * # Whitespace
 *
 * Each segment body is `.trim()`-ed before being returned. Empty
 * trailing bodies (e.g. `cmd1 &&` with nothing after) are dropped, since
 * an empty continuation row would just be visual noise.
 *
 * # Pathological inputs
 *
 * - Empty string → `{lead: "", rest: []}`.
 * - Bare operator (`"&&"`) → `{lead: "", rest: []}` (empty body dropped).
 * - Unbalanced parens (`"echo $(foo"`) → depth never returns to 0, so
 *   the rest of the input is treated as inside the subshell. We do not
 *   try to "recover"; this is fine for a renderer-side splitter, since
 *   the worst outcome is "no split, hard-wrap as before".
 *
 * @example No operators
 *   splitBashSegments("echo hello")
 *   // → { lead: "echo hello", rest: [] }
 *
 * @example Mixed pipeline
 *   splitBashSegments("cd /tmp && grep foo bar | wc -l")
 *   // → { lead: "cd /tmp", rest: [
 *   //       {op:"&&", body:"grep foo bar"},
 *   //       {op:"|",  body:"wc -l"},
 *   //   ] }
 *
 * @example Quote-protected operator
 *   splitBashSegments('echo "a && b"')
 *   // → { lead: 'echo "a && b"', rest: [] }
 */
export function splitBashSegments(cmd: string): BashSplitResult {
  // State.
  const out: BashSegment[] = []
  let lead = ""
  let leadAssigned = false
  let buf = ""
  let pendingOp: BashOperator | null = null
  let quote: '"' | "'" | "`" | null = null
  let depth = 0

  /**
   * Commit the current `buf` as either the lead (first time) or as the
   * body of the segment introduced by `pendingOp`. Empty bodies are
   * dropped.
   */
  const flushSegment = (): void => {
    const body = buf.trim()
    if (!leadAssigned) {
      lead = body
      leadAssigned = true
    } else if (pendingOp !== null && body.length > 0) {
      out.push({ op: pendingOp, body })
    }
    buf = ""
  }

  let i = 0
  while (i < cmd.length) {
    const ch = cmd[i]

    // Backslash escape — consume next char verbatim (or the trailing
    // backslash if at EOL). Works in any context: an escaped `&` will
    // never be re-probed as the start of `&&`.
    if (ch === "\\") {
      buf += ch
      if (i + 1 < cmd.length) {
        buf += cmd[i + 1]
        i += 2
      } else {
        i += 1
      }
      continue
    }

    // Quoted region — pass through until the matching close quote.
    if (quote !== null) {
      if (ch === quote) quote = null
      buf += ch
      i += 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch as '"' | "'" | "`"
      buf += ch
      i += 1
      continue
    }

    // Subshell / parameter expansion — depth tracking.
    // `$(...)` and `${...}` are two-char openers; `(` alone is also a
    // valid grouping (subshell). We do not distinguish — depth tracking
    // is sufficient to suppress operator probing.
    if (ch === "$" && i + 1 < cmd.length && (cmd[i + 1] === "(" || cmd[i + 1] === "{")) {
      depth += 1
      buf += cmd.slice(i, i + 2)
      i += 2
      continue
    }
    if (ch === "(") {
      depth += 1
      buf += ch
      i += 1
      continue
    }
    if ((ch === ")" || ch === "}") && depth > 0) {
      depth -= 1
      buf += ch
      i += 1
      continue
    }

    // Top-level operator probe. Suppressed while inside subshell/expansion.
    if (depth === 0) {
      const op = matchOperator(cmd, i)
      if (op !== null) {
        flushSegment()
        pendingOp = op
        i += op.length
        continue
      }
    }

    // Default — accumulate.
    buf += ch
    i += 1
  }

  // Final segment.
  flushSegment()

  return { lead, rest: out }
}

/**
 * Probe `cmd` at position `i` for a {@link BASH_OPERATORS} match.
 * Returns the matched operator string (longest-first wins) or `null`.
 *
 * Kept as a small helper for clarity; inlined-equivalent for hot paths.
 */
function matchOperator(cmd: string, i: number): BashOperator | null {
  for (const op of BASH_OPERATORS) {
    if (cmd.startsWith(op, i)) return op
  }
  return null
}

/**
 * Predicate: should the renderer soft-split this command?
 *
 * Returns `true` when the command's display width plus the header
 * prefix would exceed the available terminal columns. The predicate is
 * the activation gate for the renderer — short commands stay on one
 * line, only overflow triggers the multi-row layout.
 *
 * @param cmd the (single-line) command body, without `$ ` or any prefix
 * @param cols the terminal width in cells (typically `process.stdout.columns`)
 * @param headerPrefixCells cells consumed by the bordered header before
 *   the command body. Defaults to {@link BASH_HEADER_PREFIX_CELLS_DEFAULT}.
 *
 * @example
 *   shouldSoftSplit("ls | wc -l", 80)            // false — fits
 *   shouldSoftSplit("x".repeat(200), 80)         // true — overflows
 *   shouldSoftSplit("ls", 20, 5)                 // false — 2 + 5 < 20
 */
export function shouldSoftSplit(
  cmd: string,
  cols: number,
  headerPrefixCells: number = BASH_HEADER_PREFIX_CELLS_DEFAULT,
): boolean {
  if (cmd.length === 0) return false
  return displayWidth(cmd) + headerPrefixCells > cols
}
