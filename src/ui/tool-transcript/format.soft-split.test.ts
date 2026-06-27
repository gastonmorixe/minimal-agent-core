/**
 * TUI rendering of tool calls — `formatToolInput` Bash soft-split (width-aware).
 *
 * Split out of `format.test.ts` (which exceeded the 810-line lint cap when the
 * non-Bash key:value header tests landed). Same module under test, same
 * helpers; this file owns only the width-aware single-line-overflow soft-split
 * + its `↳` continuation rows.
 */
import { describe, expect, it } from "bun:test"

import type { ToolUseBlock } from "../../client/types.ts"

import { formatToolInput, formatToolInputContinuation } from "./format.ts"

function tu(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: "tool_use", id: "test", name, input } as ToolUseBlock
}

describe("formatToolInput — Bash soft-split (width-aware)", () => {
  it("does NOT soft-split when the command fits the available width", () => {
    // "ls | wc -l" + 14-cell prefix = ~24 cells. At cols=80 it fits.
    const out = formatToolInput(tu("Bash", { command: "ls | wc -l" }), 80)
    expect(out).toBe("$ ls | wc -l")
  })

  it("does NOT soft-split when cols is undefined (test default = no overflow)", () => {
    // Existing tests don't pass cols. Default must be wide enough to never
    // trigger soft-split, otherwise the legacy 80-char test commands break.
    const longCmd = "cd /a && grep -n foo bar | head -10"
    const out = formatToolInput(tu("Bash", { command: longCmd }))
    expect(out).toBe(`$ ${longCmd}`)
  })

  it("returns lead-only when the single-line command would overflow", () => {
    const cmd = "cd /Users/gaston/Projects/mdstream && grep -n -i pat file.md | head -10"
    const out = formatToolInput(tu("Bash", { command: cmd }), 60)
    // Only the lead segment makes it into the header.
    expect(out).toBe("$ cd /Users/gaston/Projects/mdstream")
  })

  it("falls back to the full first line when no top-level operators exist", () => {
    // Long single-segment command (no &&, ||, |, ;): no split is possible,
    // header keeps full first line and lets the terminal wrap as before.
    const cmd = "very-long-single-token-with-no-operators-at-all-x".repeat(3)
    const out = formatToolInput(tu("Bash", { command: cmd }), 60)
    expect(out).toBe(`$ ${cmd}`)
  })

  it("DOES soft-split the first \\n-line when it overflows (heredoc/inline-script tail keeps PS2)", () => {
    // Regression guard: the previous design gated soft-split on
    // `firstNl === -1`, which made multi-line commands (python3 -c with
    // embedded \n, heredocs, for-loops) bypass soft-split entirely and
    // let the long first line truncate+wrap. The first \n-line should
    // soft-split independently of whether there are more \n-lines after
    // it. Reported by user (Gaston, May 2026).
    const cmd = "cat <<EOF && echo done && echo more && echo extra\nfoo\nEOF"
    const out = formatToolInput(tu("Bash", { command: cmd }), 60)
    expect(out).toBe("$ cat <<EOF")
  })
})

// ---------------------------------------------------------------------------
// formatToolInputContinuation — Bash soft-split rows (↳ prefix)
// ---------------------------------------------------------------------------

describe("formatToolInputContinuation — Bash soft-split (↳ rows)", () => {
  it("returns [] for non-overflowing single-line commands", () => {
    const cont = formatToolInputContinuation(tu("Bash", { command: "ls | wc -l" }), 80)
    expect(cont).toEqual([])
  })

  it("returns [] when cols is undefined (test default = no overflow)", () => {
    // Same default rule as formatToolInput.
    const cont = formatToolInputContinuation(tu("Bash", { command: "a && b | c" }))
    expect(cont).toEqual([])
  })

  it("returns ↳ rows for an overflowing single-line pipeline (operator leads each row)", () => {
    const cmd = "cd /Users/gaston/Projects/mdstream && grep -n foo bar.md | head -10"
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 60)
    expect(cont).toEqual(["↳ && grep -n foo bar.md", "↳ | head -10"])
  })

  it("returns [] when overflow exists but no operators do (terminal wraps as before)", () => {
    const cmd = "very-long-single-token-with-no-operators-at-all-x".repeat(3)
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 60)
    expect(cont).toEqual([])
  })

  it("renders the user's reported real-world example with three logical rows", () => {
    // Header is rendered separately by formatToolInput; this asserts the
    // continuation rows that go below it.
    const cmd =
      'cd /Users/gaston/Projects/mdstream && grep -n -i "single mega-cell\\|mega.cell\\|mega cell" tmp/markdown-tables-mock-002.md | head -10'
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 107)
    expect(cont).toEqual([
      '↳ && grep -n -i "single mega-cell\\|mega.cell\\|mega cell" tmp/markdown-tables-mock-002.md',
      "↳ | head -10",
    ])
  })

  it("emits PS2 > rows for tail \\n-lines, with first-line soft-split when first overflows", () => {
    // First \n-line `cat > /tmp/x.txt << "EOF" && echo done` overflows at
    // 40 cols AND contains `&&` → soft-splits into a single `↳` row.
    // Tail \n-lines keep their PS2 `> ` prefix. Combined sequence is
    // `[↳, >, >, >]`. (Earlier design erroneously emitted only `>` rows
    // here; that was the user-reported bug, fixed May 2026.)
    const cmd = 'cat > /tmp/x.txt << "EOF" && echo done\nfoo\nbar\nEOF'
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 40)
    expect(cont).toEqual(["↳ && echo done", "> foo", "> bar", "> EOF"])
  })

  it("emits PURE > rows when first \\n-line does NOT overflow (no soft-split needed)", () => {
    // No `&&`/`|` on the first line, no overflow → tail keeps PS2 only.
    const cmd = 'cat > /tmp/x.txt << "EOF"\nfoo\nbar\nEOF'
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 40)
    expect(cont).toEqual(["> foo", "> bar", "> EOF"])
    expect(cont.every((l) => l.startsWith("> "))).toBe(true)
  })

  it('does NOT split a quote-protected operator (echo "a && b" stays one segment)', () => {
    // Long enough to overflow a 30-col terminal, but the only operator
    // is inside double quotes — no split possible, return [].
    const cmd = 'echo "a && b && c && d && e && f && g"'
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 30)
    expect(cont).toEqual([])
  })

  it("respects subshell depth — pipe inside $(...) does NOT count as a top-level split point", () => {
    const cmd = "echo $(date | tr A-Z a-z) && ls /tmp/some/long/path/here"
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 40)
    // Only the outer && splits; the inner | stays inside the subshell.
    expect(cont).toEqual(["↳ && ls /tmp/some/long/path/here"])
  })

  it("caps soft-split rows at BASH_CONT_MAX_LINES with synthetic '↳ ...(+NL) more' last row", () => {
    // 10 segments → 1 lead + 9 rest; cap is 8 visible + 1 elision row.
    const segments = Array.from({ length: 10 }, (_, i) => `cmd${i}`)
    const cmd = segments.join(" | ")
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 40)
    expect(cont.length).toBe(9) // 8 visible + 1 elision
    expect(cont[0]).toBe("↳ | cmd1")
    expect(cont[7]).toBe("↳ | cmd8")
    expect(cont[8]).toBe("↳ ...(+1L) more")
  })

  it("word-boundary-trims a single very-long soft-split segment", () => {
    const longBody = "abc ".repeat(200) // ~800 chars
    const cmd = `cd /tmp && echo ${longBody}`
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 40)
    expect(cont.length).toBe(1)
    expect(cont[0]).toMatch(/^↳ && echo /)
    expect(cont[0]).toContain("...(+")
    // Budget cap = HEADER_BASH_MAX (500) + small hint overhead.
    expect(cont[0].length).toBeLessThan(550)
  })
})

// ---------------------------------------------------------------------------
// formatToolInputContinuation — combined ↳ + > rows (first-line soft-split
// followed by PS2 tail). Regression coverage for the user-reported case
// where a long pipeline contains an embedded \n inside an inline script arg.
// ---------------------------------------------------------------------------

describe("formatToolInputContinuation — Bash combined soft-split + PS2 tail", () => {
  it("emits ↳ rows for first-line soft-split THEN > rows for tail \\n-lines", () => {
    // Shape of the user's reported case: long pipeline on line 1, embedded
    // \n in a python -c arg producing tail lines.
    const cmd = "ls | head && echo more && echo even-more-stuff && python3 -c 'a=1\nprint(a)'"
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 50)
    // First-line soft-split rows lead, PS2 rows follow.
    expect(cont[0]).toMatch(/^↳ /)
    // \n-line 2 is `print(a)'` (one trailing single quote — closes the
    // open quote that was opened on \n-line 1's last segment).
    expect(cont).toContain("> print(a)'")
    // Single zone transition: a contiguous prefix of ↳ rows, then a
    // contiguous suffix of > rows. Never interleaved.
    const lastSoftIdx = cont.findIndex((l) => l.startsWith("> "))
    expect(lastSoftIdx).toBeGreaterThan(0)
    expect(cont.slice(0, lastSoftIdx).every((l) => l.startsWith("↳ "))).toBe(true)
    expect(cont.slice(lastSoftIdx).every((l) => l.startsWith("> "))).toBe(true)
  })

  it("preserves PS2-only behavior when first \\n-line does NOT overflow", () => {
    // Short first line + tail \n-lines → no soft-split, just PS2.
    const cmd = "for i in 1 2; do\n  echo $i\ndone"
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 80)
    expect(cont).toEqual([">   echo $i", "> done"])
  })

  it("applies the cap across combined ↳ + > rows (single elision row, ↳ prefix when cut in soft-split zone)", () => {
    // Long first line → many ↳ rows. Then a few PS2 lines. Combined
    // length > 8 → cap with one trailing elision row whose prefix
    // matches whichever zone the cut landed in.
    const longFirst = Array.from({ length: 10 }, (_, i) => `cmd${i}`).join(" && ")
    const cmd = `${longFirst}\ntail1\ntail2\ntail3`
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 40)
    expect(cont.length).toBe(9) // 8 visible + 1 elision (BASH_CONT_MAX_LINES = 8)
    // Cap landed inside the ↳ zone (10 segments > 8) → elision prefix is ↳.
    expect(cont[cont.length - 1]).toMatch(/^↳ \.\.\.\(\+\d+L\) more$/)
  })

  it("uses > prefix on the elision row when the cut lands inside the PS2 zone", () => {
    // Short first line (3 ↳ rows) + 10 PS2 lines → cap at 8 means
    // [↳, ↳, ↳, >, >, >, >, >] visible. The cut is inside the PS2 zone,
    // so the elision row uses > to keep the eye oriented.
    const cmd = "a && b && c && d\n" + Array.from({ length: 10 }, (_, i) => `tail${i}`).join("\n")
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 30)
    expect(cont.length).toBe(9)
    expect(cont[cont.length - 1]).toMatch(/^> \.\.\.\(\+\d+L\) more$/)
  })
})
