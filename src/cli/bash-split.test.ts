/**
 * Tests for the pure bash-split utility module.
 *
 * The splitter is independently useful (e.g. could later power a syntax-
 * aware "what does this command do?" preview). These tests cover
 * tokenizer correctness — quoting, escaping, subshells — independent of
 * any rendering concerns.
 */
import { describe, expect, it } from "bun:test"

import {
  BASH_HEADER_PREFIX_CELLS_DEFAULT,
  BASH_OPERATORS,
  MULTI_OP_SOFT_SPLIT_MIN,
  shouldSoftSplit,
  splitBashSegments,
} from "./bash-split.ts"

// ---------------------------------------------------------------------------
// splitBashSegments — pure tokenizer
// ---------------------------------------------------------------------------

describe("splitBashSegments — no operators", () => {
  it("returns the whole command as lead when there are no operators", () => {
    expect(splitBashSegments("echo hello")).toEqual({ lead: "echo hello", rest: [] })
  })

  it("returns lead trimmed of surrounding whitespace", () => {
    expect(splitBashSegments("  echo hello  ")).toEqual({ lead: "echo hello", rest: [] })
  })

  it("treats an empty string as empty lead, no rest", () => {
    expect(splitBashSegments("")).toEqual({ lead: "", rest: [] })
  })

  it("treats a single bare operator as empty lead with one empty body (which we drop)", () => {
    // Pathological. Should not crash; trailing empty bodies are dropped.
    expect(splitBashSegments("&&")).toEqual({ lead: "", rest: [] })
  })
})

describe("splitBashSegments — single operators", () => {
  it("splits at &&", () => {
    expect(splitBashSegments("cd /tmp && ls")).toEqual({
      lead: "cd /tmp",
      rest: [{ op: "&&", body: "ls" }],
    })
  })

  it("splits at ||", () => {
    expect(splitBashSegments("test -f x || touch x")).toEqual({
      lead: "test -f x",
      rest: [{ op: "||", body: "touch x" }],
    })
  })

  it("splits at | (pipe)", () => {
    expect(splitBashSegments("ls | wc -l")).toEqual({
      lead: "ls",
      rest: [{ op: "|", body: "wc -l" }],
    })
  })

  it("splits at ; (sequence)", () => {
    expect(splitBashSegments("cd /tmp ; ls")).toEqual({
      lead: "cd /tmp",
      rest: [{ op: ";", body: "ls" }],
    })
  })
})

describe("splitBashSegments — operator disambiguation (longest-prefix wins)", () => {
  it("matches && before & (we never split on bare &)", () => {
    expect(splitBashSegments("cmd1 && cmd2")).toEqual({
      lead: "cmd1",
      rest: [{ op: "&&", body: "cmd2" }],
    })
  })

  it("does NOT split on bare & (background)", () => {
    // Backgrounding is rare and splitting would be misleading. Leave as one.
    expect(splitBashSegments("sleep 10 & wait")).toEqual({
      lead: "sleep 10 & wait",
      rest: [],
    })
  })

  it("matches || before | (the OR operator)", () => {
    expect(splitBashSegments("a || b")).toEqual({
      lead: "a",
      rest: [{ op: "||", body: "b" }],
    })
  })

  it("matches | as a single pipe even when adjacent to other tokens", () => {
    expect(splitBashSegments("a | b | c")).toEqual({
      lead: "a",
      rest: [
        { op: "|", body: "b" },
        { op: "|", body: "c" },
      ],
    })
  })
})

describe("splitBashSegments — mixed operators", () => {
  it("splits the user's reported real-world example", () => {
    const cmd =
      'cd /Users/dev/Projects/mdstream && grep -n -i "single mega-cell\\|mega.cell\\|mega cell" tmp/markdown-tables-mock-002.md | head -10'
    const out = splitBashSegments(cmd)
    expect(out.lead).toBe("cd /Users/dev/Projects/mdstream")
    expect(out.rest).toEqual([
      {
        op: "&&",
        body: 'grep -n -i "single mega-cell\\|mega.cell\\|mega cell" tmp/markdown-tables-mock-002.md',
      },
      { op: "|", body: "head -10" },
    ])
  })

  it("preserves operator order across a mixed pipeline", () => {
    const out = splitBashSegments("a && b | c || d ; e")
    expect(out.lead).toBe("a")
    expect(out.rest).toEqual([
      { op: "&&", body: "b" },
      { op: "|", body: "c" },
      { op: "||", body: "d" },
      { op: ";", body: "e" },
    ])
  })
})

// ---------------------------------------------------------------------------
// Quote / escape safety — operators inside strings must NOT split
// ---------------------------------------------------------------------------

describe("splitBashSegments — quote safety", () => {
  it("does NOT split inside double quotes", () => {
    expect(splitBashSegments('echo "a && b"')).toEqual({
      lead: 'echo "a && b"',
      rest: [],
    })
  })

  it("does NOT split inside single quotes", () => {
    expect(splitBashSegments("echo 'a | b'")).toEqual({
      lead: "echo 'a | b'",
      rest: [],
    })
  })

  it("does NOT split inside backticks", () => {
    expect(splitBashSegments("echo `cmd1 | cmd2`")).toEqual({
      lead: "echo `cmd1 | cmd2`",
      rest: [],
    })
  })

  it("splits at outer operators while respecting inner quotes", () => {
    // Outer && is real; inner | is inside double quotes.
    expect(splitBashSegments('echo "a | b" && echo done')).toEqual({
      lead: 'echo "a | b"',
      rest: [{ op: "&&", body: "echo done" }],
    })
  })

  it("handles a quote that spans across an operator (operator stays inside the string)", () => {
    expect(splitBashSegments('printf "%s && %s" foo bar')).toEqual({
      lead: 'printf "%s && %s" foo bar',
      rest: [],
    })
  })
})

describe("splitBashSegments — escape safety", () => {
  it("does NOT split when the operator is backslash-escaped", () => {
    expect(splitBashSegments("echo a \\&\\& b")).toEqual({
      lead: "echo a \\&\\& b",
      rest: [],
    })
  })

  it("does NOT split on an escaped pipe", () => {
    expect(splitBashSegments("echo a \\| b")).toEqual({
      lead: "echo a \\| b",
      rest: [],
    })
  })

  it("treats a backslash followed by EOL as escaping nothing past EOL", () => {
    // Should not crash. The trailing \ is preserved verbatim in the lead.
    expect(splitBashSegments("echo hi \\")).toEqual({
      lead: "echo hi \\",
      rest: [],
    })
  })
})

// ---------------------------------------------------------------------------
// Subshell / parameter-expansion depth tracking
// ---------------------------------------------------------------------------

describe("splitBashSegments — subshell and parameter expansion", () => {
  it("does NOT split inside $(...)", () => {
    expect(splitBashSegments("echo $(grep foo bar | wc -l)")).toEqual({
      lead: "echo $(grep foo bar | wc -l)",
      rest: [],
    })
  })

  it("does NOT split inside ${...}", () => {
    // ${var|default} is uncommon but legal in some shells; importantly
    // the splitter must not break parameter expansion.
    expect(splitBashSegments("echo ${foo|bar}")).toEqual({
      lead: "echo ${foo|bar}",
      rest: [],
    })
  })

  it("does NOT split inside nested $(...) subshells", () => {
    expect(splitBashSegments("echo $(foo $(bar | baz))")).toEqual({
      lead: "echo $(foo $(bar | baz))",
      rest: [],
    })
  })

  it("splits at outer && while preserving inner subshell pipe", () => {
    expect(splitBashSegments("echo $(date | tr A-Z a-z) && ls")).toEqual({
      lead: "echo $(date | tr A-Z a-z)",
      rest: [{ op: "&&", body: "ls" }],
    })
  })

  it("does NOT split inside a plain ( ... ) subshell group", () => {
    expect(splitBashSegments("(cd /tmp && ls)")).toEqual({
      lead: "(cd /tmp && ls)",
      rest: [],
    })
  })

  it("splits at outer ; after a closed ( ... ) subshell", () => {
    expect(splitBashSegments("(cd /tmp && ls) ; echo done")).toEqual({
      lead: "(cd /tmp && ls)",
      rest: [{ op: ";", body: "echo done" }],
    })
  })
})

// ---------------------------------------------------------------------------
// Whitespace / trailing operator pathologies
// ---------------------------------------------------------------------------

describe("splitBashSegments — whitespace handling", () => {
  it("trims whitespace around segments", () => {
    expect(splitBashSegments("   cd /tmp   &&   ls   ")).toEqual({
      lead: "cd /tmp",
      rest: [{ op: "&&", body: "ls" }],
    })
  })

  it("handles operators with no surrounding spaces", () => {
    expect(splitBashSegments("a&&b|c")).toEqual({
      lead: "a",
      rest: [
        { op: "&&", body: "b" },
        { op: "|", body: "c" },
      ],
    })
  })

  it("drops a trailing operator with empty body", () => {
    expect(splitBashSegments("cmd1 &&")).toEqual({
      lead: "cmd1",
      rest: [],
    })
  })
})

// ---------------------------------------------------------------------------
// BASH_OPERATORS export — sanity
// ---------------------------------------------------------------------------

describe("BASH_OPERATORS export", () => {
  it("includes the four broad operators in longest-prefix-first order", () => {
    expect(BASH_OPERATORS).toContain("&&")
    expect(BASH_OPERATORS).toContain("||")
    expect(BASH_OPERATORS).toContain("|")
    expect(BASH_OPERATORS).toContain(";")
  })

  it("orders multi-char operators before their single-char prefixes", () => {
    // && must come before any potential & (we don't split on &, but the
    // ordering invariant matters for correctness if we ever add it).
    // || must come before |.
    const orIdx = BASH_OPERATORS.indexOf("||")
    const pipeIdx = BASH_OPERATORS.indexOf("|")
    expect(orIdx).toBeLessThan(pipeIdx)
  })
})

// ---------------------------------------------------------------------------
// shouldSoftSplit — width activation predicate
// ---------------------------------------------------------------------------

describe("shouldSoftSplit — width predicate", () => {
  it("returns false when the command fits in the available cells", () => {
    expect(shouldSoftSplit("ls | wc -l", 80)).toBe(false)
  })

  it("returns true when the command overflows", () => {
    const longCmd = `${"x".repeat(200)} && ls`
    expect(shouldSoftSplit(longCmd, 80)).toBe(true)
  })

  it("uses the configurable header prefix when given", () => {
    // 70-char body + 14-cell prefix = 84 > 80 → overflows.
    expect(shouldSoftSplit("x".repeat(70), 80, 14)).toBe(true)
    // Same body with a 5-cell prefix = 75 < 80 → fits.
    expect(shouldSoftSplit("x".repeat(70), 80, 5)).toBe(false)
  })

  it("defaults the prefix cells to BASH_HEADER_PREFIX_CELLS_DEFAULT", () => {
    const body = "x".repeat(80 - BASH_HEADER_PREFIX_CELLS_DEFAULT - 1)
    expect(shouldSoftSplit(body, 80)).toBe(false)
    const overflow = "x".repeat(80 - BASH_HEADER_PREFIX_CELLS_DEFAULT + 1)
    expect(shouldSoftSplit(overflow, 80)).toBe(true)
  })

  it("returns false on an empty command", () => {
    expect(shouldSoftSplit("", 80)).toBe(false)
  })

  it("treats display width (not byte length) — wide CJK glyphs cost 2 cells", () => {
    // 30 wide glyphs = 60 cells of body. Plus default 14 prefix = 74.
    // At cols=80 this fits; at cols=70 it overflows.
    const wide = "漢".repeat(30)
    expect(shouldSoftSplit(wide, 80)).toBe(false)
    expect(shouldSoftSplit(wide, 70)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// shouldSoftSplit — multi-operator structured-pipeline rule
// ---------------------------------------------------------------------------

describe("shouldSoftSplit — multi-operator pipeline rule", () => {
  it(`splits a 2+ operator pipeline regardless of width (>= ${MULTI_OP_SOFT_SPLIT_MIN} ops)`, () => {
    // Reproduces user-reported bug (May 2026): at typical iTerm widths
    // (130–160 cells) a 105-char `cd … && cat … | head -80` pipeline
    // fits inline and the old width-only predicate left it unsplit.
    // The new rule splits any structured 2+ operator command.
    const cmd =
      "cd /Users/dev/Projects/inditex/work/inditex-supplier-management && cat Makefile 2>/dev/null | head -80"
    expect(shouldSoftSplit(cmd, 130)).toBe(true)
    expect(shouldSoftSplit(cmd, 200)).toBe(true)
    expect(shouldSoftSplit(cmd, 400)).toBe(true)
  })

  it("does NOT split a single-operator pipeline that fits (1 op stays inline)", () => {
    // Single-operator commands are short and trivially scannable;
    // splitting `ls | wc -l` into 2 rows is overkill. Only overflow
    // triggers the split for these.
    expect(shouldSoftSplit("ls | wc -l", 80)).toBe(false)
    expect(shouldSoftSplit("cd /tmp && ls", 80)).toBe(false)
    expect(shouldSoftSplit("cmd1 ; cmd2", 80)).toBe(false)
  })

  it("splits 2+ operators even when the body is short enough to fit", () => {
    // 19-char body, 2 operators. Old rule: no split (fits at 80).
    // New rule: split (2 operators is the structured-pipeline signal).
    expect(shouldSoftSplit("cd /tmp && ls | wc", 80)).toBe(true)
  })

  it("does NOT split when only quoted operators are present (no top-level ops)", () => {
    // Quote-protected `&&` is part of an echo arg, not a top-level operator.
    // Width-fit + 0 operators ⇒ no split.
    expect(shouldSoftSplit('echo "a && b && c"', 80)).toBe(false)
  })

  it("does NOT split when only subshell-internal pipes are present", () => {
    // `|` is inside `$(…)`, so depth > 0 — not a top-level operator.
    // Zero top-level operators here, fits the width → no split.
    expect(shouldSoftSplit("echo $(date | tr A-Z a-z)", 80)).toBe(false)
  })

  it("returns false when cols is non-finite (width unknown sentinel)", () => {
    // Renderer passes Infinity when neither `cols` arg nor
    // `process.stdout.columns` is available (non-TTY). Multi-op rule
    // must not fire here, otherwise `bun test`-driven tests that don't
    // pass cols would start splitting unexpectedly.
    expect(shouldSoftSplit("a && b | c", Number.POSITIVE_INFINITY)).toBe(false)
    expect(shouldSoftSplit("a && b | c", Number.NaN)).toBe(false)
  })

  it("multi-op rule does not regress overflow detection (both rules co-exist)", () => {
    // Long single-op pipeline at narrow width — old overflow rule alone
    // must still fire even though the multi-op rule wouldn't.
    const longSingleOp = `${"x".repeat(200)} | head`
    expect(shouldSoftSplit(longSingleOp, 80)).toBe(true)
  })
})
