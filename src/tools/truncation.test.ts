import { describe, expect, it } from "bun:test"

import { EMPTY_SYNTHETIC_TEXT, type SyntheticTextResolver } from "../agent/synthetic-text.ts"
import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import { truncatedNoticeText } from "./tool-result-text.ts"
import {
  clampToolOutputLines,
  clampToolRaw,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TOOL_OUTPUT_LINE_CHARS,
  MAX_TOOL_OUTPUT_LINES,
  MAX_TOOL_RAW_BYTES,
  type TruncateCtx,
  type TruncationInfo,
  truncateToolOutput,
} from "./truncation.ts"
import {
  joinTruncationParts,
  renderTruncatedNotice,
  TRUNCATION_NOTICE_JOIN,
  truncateToolOutputParts,
} from "./truncation-parts.ts"

// Text from the real text plugins, not a core fallback.
const TEXT = textFixturesPresent() ? fixtureSyntheticTextResolver() : undefined
const truncate = (output: string, ctx?: Parameters<typeof truncateToolOutput>[1]) =>
  truncateToolOutput(output, ctx, TEXT)

/** Many short lines totaling at least `minBytes` (each line under the per-line cap). */
function shortLinesAtLeast(minBytes: number, lineLen = 64): string {
  const lines: string[] = []
  let size = 0
  while (size < minBytes) {
    lines.push("x".repeat(lineLen))
    size += lineLen + 1
  }
  return lines.join("\n")
}

describe("truncateToolOutput — passthrough", () => {
  it("returns input unchanged when under both budgets", () => {
    const s = "hello\nworld"
    const { content, info } = truncate(s)
    expect(content).toBe(s)
    expect(info.truncated).toBe(false)
    expect(info.shownLines).toBe(2)
  })

  it("returns empty string unchanged", () => {
    const { content, info } = truncate("")
    expect(content).toBe("")
    expect(info.truncated).toBe(false)
    expect(info.shownBytes).toBe(0)
    expect(info.shownLines).toBe(0)
  })

  it("does not append a notice at exactly the byte budget (short lines)", () => {
    // One mega-line of MAX bytes would trip the per-line cap; build short lines
    // that land at-or-under the byte budget and under the line-char cap.
    const lineLen = 64
    const n = Math.floor(MAX_TOOL_OUTPUT_BYTES / (lineLen + 1))
    const s = Array.from({ length: n }, () => "x".repeat(lineLen)).join("\n")
    expect(Buffer.byteLength(s, "utf8")).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES)
    const { content, info } = truncate(s)
    expect(content).toBe(s)
    expect(content).not.toContain("[truncated:")
    expect(info.truncated).toBe(false)
  })

  it("does not append a notice at exactly the line budget", () => {
    // MAX_TOOL_OUTPUT_LINES lines = (MAX-1) newlines.
    const s = Array.from({ length: MAX_TOOL_OUTPUT_LINES }, () => "a").join("\n")
    const { content, info } = truncate(s)
    expect(content).toBe(s)
    expect(info.truncated).toBe(false)
  })
})

describe.skipIf(!textFixturesPresent())("truncateToolOutput — notice shape", () => {
  it("appends exactly one notice line prefixed with [truncated:", () => {
    const s = shortLinesAtLeast(MAX_TOOL_OUTPUT_BYTES + 1000)
    const { content } = truncate(s)
    const lines = content.split("\n").filter((l) => l.startsWith("[truncated:"))
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatch(
      /^\[truncated: shown \d+ of [\w\d]+ bytes, \d+\/[\w\d]+ lines, cut at byte \d+, line \d+\. .+\]$/,
    )
  })

  it("reports measured totals when ctx omits them", () => {
    const s = shortLinesAtLeast(MAX_TOOL_OUTPUT_BYTES + 500)
    const { content, info } = truncate(s)
    const total = Buffer.byteLength(s, "utf8")
    expect(content).toContain(`of ${total} bytes`)
    expect(info.totalBytes).toBe(total)
    expect(info.totalLines).toBe(s.split("\n").length)
  })

  it("reports exact totals when ctx provides them", () => {
    const total = MAX_TOOL_OUTPUT_BYTES * 4
    const s = shortLinesAtLeast(total)
    const { content, info } = truncate(s, { totalBytes: total, totalLines: 1 })
    expect(content).toContain(`of ${total} bytes`)
    expect(content).toContain(`/1 lines`)
    expect(info.totalBytes).toBe(total)
    expect(info.totalLines).toBe(1)
  })

  it("`shown bytes` matches the actual kept slice", () => {
    const s = "line\n".repeat(MAX_TOOL_OUTPUT_LINES + 200)
    const { content, info } = truncate(s, { totalBytes: Buffer.byteLength(s) })
    const m = content.match(/shown (\d+) of/)
    expect(m).not.toBeNull()
    const shown = Number(m![1])
    const kept = content.slice(0, content.lastIndexOf("\n\n[truncated:"))
    expect(Buffer.byteLength(kept)).toBe(shown)
    expect(info.shownBytes).toBe(shown)
  })
})

describe.skipIf(!textFixturesPresent())("truncateToolOutput — line/byte budgets", () => {
  it("clamps when over line budget but well under byte budget", () => {
    const s = "a\n".repeat(MAX_TOOL_OUTPUT_LINES + 50)
    const { content, info } = truncate(s)
    expect(content).toContain("[truncated:")
    const kept = content.split("\n\n[truncated:")[0]
    expect(kept.split("\n").length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_LINES)
    expect(info.truncated).toBe(true)
    expect(info.shownLines).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_LINES)
  })

  it("clamps a single mega-line to MAX_TOOL_OUTPUT_LINE_CHARS before byte budget", () => {
    const s = "x".repeat(MAX_TOOL_OUTPUT_LINE_CHARS * 3)
    const { content, info } = truncate(s)
    expect(content).toContain("[truncated:")
    expect(info.truncated).toBe(true)
    const kept = content.split("\n\n[truncated:")[0]
    expect(kept).toContain("...(+")
    expect(kept.length).toBeLessThan(MAX_TOOL_OUTPUT_LINE_CHARS + 40)
    expect(info.totalBytes).toBe(Buffer.byteLength(s, "utf8"))
  })

  it("clamps when over byte budget via many short lines (under per-line cap)", () => {
    const s = shortLinesAtLeast(MAX_TOOL_OUTPUT_BYTES * 3)
    const { content, info } = truncate(s)
    expect(content).toContain("[truncated:")
    const kept = content.split("\n\n[truncated:")[0]
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES)
    expect(info.shownBytes).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES)
  })

  it("never returns a string longer than budget + small notice overhead", () => {
    const s = shortLinesAtLeast(MAX_TOOL_OUTPUT_BYTES * 10)
    const { content } = truncate(s)
    expect(Buffer.byteLength(content)).toBeLessThan(MAX_TOOL_OUTPUT_BYTES + 500)
  })
})

describe.skipIf(!textFixturesPresent())("truncateToolOutput — cut location", () => {
  it("`cut at line` equals startLine + shownLines for offset reads", () => {
    const s = "row\n".repeat(MAX_TOOL_OUTPUT_LINES + 100)
    // The real Read tool always gives totalLines (file lines), so the total is known.
    const totalLines = 500 + s.split("\n").length
    const { content, info } = truncate(s, { tool: "Read", startLine: 500, totalLines })
    const m = content.match(/cut at byte \d+, line (\d+)/)
    expect(m).not.toBeNull()
    const cutLine = Number(m![1])
    // Kept is at most MAX_TOOL_OUTPUT_LINES; cut line = 500 + shownLines.
    expect(cutLine).toBeGreaterThan(500)
    expect(cutLine).toBeLessThanOrEqual(500 + MAX_TOOL_OUTPUT_LINES)
    expect(info.cutLine).toBe(cutLine)
    expect(info.startLine).toBe(500)
  })

  it("`cut at byte` equals shown bytes", () => {
    const s = shortLinesAtLeast(MAX_TOOL_OUTPUT_BYTES * 2)
    const { content, info } = truncate(s)
    const shown = Number(content.match(/shown (\d+) of/)![1])
    const cut = Number(content.match(/cut at byte (\d+),/)![1])
    expect(cut).toBe(shown)
    expect(info.shownBytes).toBe(shown)
  })
})

describe.skipIf(!textFixturesPresent())("truncateToolOutput — per-tool resume hints", () => {
  const big = "row\n".repeat(MAX_TOOL_OUTPUT_LINES + 10)

  it("Read hint suggests offset= at the cut line", () => {
    // The real Read tool always gives totalLines, so the total is known.
    const { content } = truncate(big, {
      tool: "Read",
      startLine: 0,
      totalLines: big.split("\n").length,
    })
    expect(content).toMatch(/call Read with offset=\d+/)
  })

  it("Read with an unknown total (no ctx.totalLines): no offset= hint, says the total is not known", () => {
    const p = truncateToolOutputParts(big, { tool: "Read", startLine: 0 }, TEXT!)
    expect(p.facts.totalLinesKnown).toBe(false)
    expect(p.notice).not.toContain("offset=")
    expect(p.notice).toContain("the total number of lines is not known")
    const { content } = truncate(big, { tool: "Read", startLine: 0 })
    expect(content).toContain("the total number of lines is not known")
    expect(content).not.toMatch(/offset=/)
  })

  it("Grep hint suggests narrowing", () => {
    const { content } = truncate(big, { tool: "Grep" })
    expect(content).toMatch(/narrow|head_limit/i)
  })

  it("Bash hint warns front-keep drops trailing errors and steers to tail/grep", () => {
    const { content } = truncate(big, { tool: "Bash" })
    // The clamp keeps the FRONT of the body, so trailing build/test errors
    // are exactly what got cut. The hint must say so and point at the tail
    // (tail -n / grep -nE) plus the recoverable raw-output blob, NOT the old
    // head -c/sed -n/awk bound-the-front advice.
    expect(content).toMatch(/tail -n|grep -nE|FRONT was kept/)
    expect(content).toContain("raw-output blob")
    // Guard against regressing to the old front-bounding wording.
    expect(content).not.toMatch(/head -c|sed -n|awk/)
  })

  it("Glob hint suggests narrowing pattern", () => {
    const { content } = truncate(big, { tool: "Glob" })
    expect(content).toMatch(/narrow/i)
  })

  it("unknown tool falls back to generic hint", () => {
    const { content } = truncate(big, { tool: "Mystery" })
    expect(content).toMatch(/narrower/)
  })

  it("a tool_output.truncated provider owns the hint", () => {
    const text: SyntheticTextResolver = {
      resolve: (kind, _facts) => (kind === "tool_output.truncated" ? "[CUSTOM_HINT_STR]" : ""),
    }
    const { content } = truncateToolOutput(big, { tool: "Read" }, text)
    expect(content).toContain("CUSTOM_HINT_STR")
    expect(content).not.toContain("call Read with offset=")
  })
})

describe("truncateToolOutput — utf-8 safety", () => {
  it("does not split a multi-byte codepoint at the byte boundary", () => {
    // Many short lines totaling just under the byte budget, then a final
    // line that pushes past it mid-emoji. Per-line lengths stay under the
    // line-char cap so the byte clamp (not the line clamp) is what cuts.
    const lineLen = 64
    const lines: string[] = []
    let size = 0
    while (size + lineLen + 1 < MAX_TOOL_OUTPUT_BYTES - 8) {
      lines.push("a".repeat(lineLen))
      size += lineLen + 1
    }
    lines.push(`aa🙂🙂🙂🙂🙂`)
    const s = lines.join("\n")
    const { content } = truncate(s)
    // No replacement char from broken utf-8 in the kept content.
    const kept = content.split("\n\n[truncated:")[0]
    expect(kept).not.toContain("\uFFFD")
  })
})

describe.skipIf(!textFixturesPresent())("truncateToolOutput — info object", () => {
  it("propagates totals through info on passthrough", () => {
    const { info } = truncate("hello\nworld\n")
    // 12 bytes (`hello\nworld\n`), 3 split-lines (`hello`, `world`, ``).
    expect(info.truncated).toBe(false)
    expect(info.shownBytes).toBe(12)
    expect(info.shownLines).toBe(3)
    expect(info.totalBytes).toBe(12)
    expect(info.totalLines).toBe(3)
  })

  it("info.totalBytes/totalLines reflect ctx values when source was bigger", () => {
    const s = shortLinesAtLeast(MAX_TOOL_OUTPUT_BYTES + 500)
    const { info } = truncate(s, {
      totalBytes: 10_000_000,
      totalLines: 42_000,
    })
    expect(info.truncated).toBe(true)
    expect(info.totalBytes).toBe(10_000_000)
    expect(info.totalLines).toBe(42_000)
    expect(info.shownBytes).toBeLessThan(10_000_000)
  })

  it("info.shownLines/shownBytes match the body without the notice", () => {
    const s = "row\n".repeat(MAX_TOOL_OUTPUT_LINES + 50)
    const { content, info } = truncate(s)
    const body = content.split("\n\n[truncated:")[0]
    expect(info.shownBytes).toBe(Buffer.byteLength(body, "utf8"))
    expect(info.shownLines).toBe(body.split("\n").length)
  })
})

describe("clampToolOutputLines", () => {
  it("passes through when under the per-line cap", () => {
    const s = "short\nlines\nok"
    expect(clampToolOutputLines(s)).toEqual({ text: s, clamped: false })
  })

  it("clips each mega-line and marks clamped", () => {
    const s = `${"a".repeat(MAX_TOOL_OUTPUT_LINE_CHARS + 50)}\nshort`
    const { text, clamped } = clampToolOutputLines(s)
    expect(clamped).toBe(true)
    const [first, second] = text.split("\n")
    expect(first.startsWith("a".repeat(MAX_TOOL_OUTPUT_LINE_CHARS))).toBe(true)
    expect(first).toContain("...(+50ch)")
    expect(second).toBe("short")
  })
})

describe("clampToolRaw", () => {
  it("passes through under the raw blob ceiling", () => {
    const s = "x".repeat(1000)
    expect(clampToolRaw(s)).toBe(s)
  })

  it("caps at MAX_TOOL_RAW_BYTES", () => {
    const s = "x".repeat(MAX_TOOL_RAW_BYTES + 50_000)
    const out = clampToolRaw(s)
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RAW_BYTES)
    expect(out.length).toBeLessThan(s.length)
  })
})

// ---------------------------------------------------------------------------
// W2 U1b: clamp parts (kept, notice, facts). SPEC v6.1 D2, DECISIONS D-H.
// ---------------------------------------------------------------------------

/**
 * Reference copy of the clamp before U1b (truncation.ts at a38c86b). The new
 * `truncateToolOutput` must give the same bytes for each input.
 */
function legacyTruncate(
  output: string,
  ctx: TruncateCtx,
  text: SyntheticTextResolver,
): { content: string; info: TruncationInfo } {
  const source = clampToolOutputLines(output).text
  const clamped = source !== output
  const bytes = Buffer.byteLength(source, "utf8")
  const lines = source.length === 0 ? 0 : source.split("\n").length
  const totalBytes = ctx.totalBytes ?? Buffer.byteLength(output, "utf8")
  const totalLines = ctx.totalLines ?? (output.length === 0 ? 0 : output.split("\n").length)
  const overBytes = bytes > MAX_TOOL_OUTPUT_BYTES
  const overLines = lines > MAX_TOOL_OUTPUT_LINES
  if (!overBytes && !overLines && !clamped) {
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
  let kept = source
  if (overLines) kept = source.split("\n").slice(0, MAX_TOOL_OUTPUT_LINES).join("\n")
  if (Buffer.byteLength(kept, "utf8") > MAX_TOOL_OUTPUT_BYTES) {
    const buf = Buffer.from(kept, "utf8")
    let end = MAX_TOOL_OUTPUT_BYTES
    while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
    kept = buf.subarray(0, end).toString("utf8")
    const nl = kept.lastIndexOf("\n")
    if (nl >= MAX_TOOL_OUTPUT_BYTES * 0.9) kept = kept.slice(0, nl)
  }
  const shownBytes = Buffer.byteLength(kept, "utf8")
  const shownLines = kept.length === 0 ? 0 : kept.split("\n").length
  const cutLine = (ctx.startLine ?? 0) + shownLines
  const notice = truncatedNoticeText(text, {
    tool: ctx.tool ?? "",
    shownBytes,
    totalBytes,
    shownLines,
    totalLines,
    cutLine,
    maxToolOutputBytes: MAX_TOOL_OUTPUT_BYTES,
  })
  return {
    content: `${kept}\n\n${notice}`,
    info: {
      tool: ctx.tool,
      truncated: true,
      shownBytes,
      shownLines,
      totalBytes,
      totalLines,
      cutLine,
      startLine: ctx.startLine,
    },
  }
}

/** A body with `n` lines; the lines at `longAt` have `longLen` chars. */
function linesWithLong(n: number, longAt: number[], longLen: number): string {
  return Array.from({ length: n }, (_, i) =>
    longAt.includes(i) ? "L".repeat(longLen) : `line ${i + 1}`,
  ).join("\n")
}

/** The text of a legacyTruncate result before its notice (the notice text changed by design in M3c 4c). */
function beforeNotice(content: string): string {
  const at = content.lastIndexOf("\n\n[truncated:")
  return at === -1 ? content : content.slice(0, at)
}

/**
 * The inputs of the cases in this file, plus the D-H cases. `fixtureNotice`:
 * the Read notice text of the fixture provider changed by design (M3c 4c:
 * case A, case B). The body before the notice must stay equal to the old clamp.
 */
const PARTS_CASES: Array<{
  name: string
  output: string
  ctx: TruncateCtx
  fixtureNotice?: (f: { shownBytes: number; totalBytes: number }) => string
}> = [
  { name: "short", output: "hello\nworld", ctx: {} },
  { name: "empty", output: "", ctx: {} },
  { name: "trailing newline", output: "hello\nworld\n", ctx: {} },
  {
    name: "exact byte budget",
    output: Array.from({ length: Math.floor(MAX_TOOL_OUTPUT_BYTES / 65) }, () =>
      "x".repeat(64),
    ).join("\n"),
    ctx: {},
  },
  {
    name: "exact line budget",
    output: Array.from({ length: MAX_TOOL_OUTPUT_LINES }, () => "a").join("\n"),
    ctx: {},
  },
  { name: "over bytes", output: shortLinesAtLeast(MAX_TOOL_OUTPUT_BYTES + 1000), ctx: {} },
  {
    name: "ctx totals",
    output: shortLinesAtLeast(MAX_TOOL_OUTPUT_BYTES * 4),
    ctx: { totalBytes: MAX_TOOL_OUTPUT_BYTES * 4, totalLines: 1 },
  },
  { name: "over lines", output: "a\n".repeat(MAX_TOOL_OUTPUT_LINES + 50), ctx: {} },
  { name: "mega line", output: "x".repeat(MAX_TOOL_OUTPUT_LINE_CHARS * 3), ctx: {} },
  { name: "over bytes x10", output: shortLinesAtLeast(MAX_TOOL_OUTPUT_BYTES * 10), ctx: {} },
  {
    name: "Read offset",
    output: "row\n".repeat(MAX_TOOL_OUTPUT_LINES + 100),
    // totalLines is given (the real Read tool always gives it): file lines.
    ctx: { tool: "Read", startLine: 500, totalLines: 500 + MAX_TOOL_OUTPUT_LINES + 101 },
  },
  ...["Read", "Grep", "Bash", "Glob", "Mystery"].map((tool) => ({
    name: `hint ${tool}`,
    output: "row\n".repeat(MAX_TOOL_OUTPUT_LINES + 10),
    // Read always has totalLines (the true line count of the output).
    ctx: tool === "Read" ? { tool, totalLines: MAX_TOOL_OUTPUT_LINES + 11 } : { tool },
  })),
  {
    name: "utf-8 boundary",
    output: `${shortLinesAtLeast(MAX_TOOL_OUTPUT_BYTES - 80)}\naa🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂`,
    ctx: {},
  },
  {
    name: "73/73 long lines (D-H case A)",
    output: linesWithLong(73, [3, 20, 40, 72], 50_000),
    ctx: { tool: "Read", totalLines: 73, startLine: 0 },
    // Case A: all 73 lines are shown, only the per-line clamp cut text.
    fixtureNotice: (f) =>
      `[truncated: shown ${f.shownBytes} of ${f.totalBytes} bytes. All 73 lines are shown, but the harness cut 4 long lines at about 8192 characters (see "...(+Nch)"). Read cannot show the rest of a line. Use Grep with a specific pattern, or Bash with cut -c on that line.]`,
  },
  {
    name: "CRLF over lines (S4)",
    output: "row\r\n".repeat(MAX_TOOL_OUTPUT_LINES + 20),
    ctx: { tool: "Read", totalLines: MAX_TOOL_OUTPUT_LINES + 21 },
  },
  {
    name: "per-line cut plus byte cut (S4)",
    output: Array.from({ length: 12 }, () => "w".repeat(9000)).join("\n"),
    ctx: { tool: "Read", totalLines: 12, startLine: 0 },
    // Case B: the byte cut is inside line 8; continue at offset=7.
    fixtureNotice: (f) =>
      `[truncated: shown ${f.shownBytes} of ${f.totalBytes} bytes, 8/12 lines, cut at byte ${f.shownBytes}, line 8. line 8 is partial. To continue, call Read with offset=7, which shows that line again from its start. Set limit if necessary.]`,
  },
  {
    name: "multibyte cut at a line end (S4, W3)",
    output: Array.from({ length: 100 }, () => "\u4e2d".repeat(333)).join("\n"),
    ctx: { tool: "Read", totalLines: 100, startLine: 0 },
  },
  {
    name: "Read past the end (S2)",
    output: "",
    ctx: { tool: "Read", totalLines: 10, startLine: 50 },
  },
  {
    name: "byte cut mid-line (D-H case B)",
    output: Array.from({ length: 12 }, () => "y".repeat(8000)).join("\n"),
    ctx: { tool: "Read", totalLines: 12, startLine: 0 },
    // Case B: the byte cut is inside line 8; continue at offset=7.
    fixtureNotice: (f) =>
      `[truncated: shown ${f.shownBytes} of ${f.totalBytes} bytes, 8/12 lines, cut at byte ${f.shownBytes}, line 8. line 8 is partial. To continue, call Read with offset=7, which shows that line again from its start. Set limit if necessary.]`,
  },
]

describe("truncateToolOutputParts: same bytes as the old clamp", () => {
  const resolvers: Array<[string, SyntheticTextResolver]> = [
    ["empty text", EMPTY_SYNTHETIC_TEXT],
    ...(TEXT ? [["fixture text", TEXT] as [string, SyntheticTextResolver]] : []),
  ]
  for (const [rName, text] of resolvers) {
    for (const c of PARTS_CASES) {
      it(`${c.name} (${rName})`, () => {
        const legacy = legacyTruncate(c.output, c.ctx, text)
        const parts = truncateToolOutputParts(c.output, c.ctx, text)
        const now = truncateToolOutput(c.output, c.ctx, text)
        // With the fixture text, a case with `fixtureNotice` keeps the old body
        // bytes and has the new notice text. All other cases equal the old clamp.
        const newNotice = text === TEXT && c.fixtureNotice !== undefined
        const old = newNotice
          ? {
              ...legacy,
              content: `${beforeNotice(legacy.content)}${TRUNCATION_NOTICE_JOIN}${c.fixtureNotice!(parts.facts)}`,
            }
          : legacy
        if (newNotice) expect(parts.kept).toBe(beforeNotice(legacy.content))
        expect(now.content).toBe(old.content)
        expect(now.info).toEqual(old.info)
        expect(parts.info).toEqual(old.info)
        expect(joinTruncationParts(parts)).toBe(old.content)
        if (parts.info.truncated) {
          expect(parts.kept + TRUNCATION_NOTICE_JOIN + parts.notice).toBe(old.content)
          expect(TRUNCATION_NOTICE_JOIN).toBe("\n\n")
        } else {
          expect(parts.kept).toBe(old.content)
          expect(parts.notice).toBe("")
        }
        // Facts agree with the info and with the notice inputs.
        const f = parts.facts
        expect(f.shownBytes).toBe(parts.info.shownBytes)
        expect(f.shownLines).toBe(parts.info.shownLines)
        expect(f.totalBytes).toBe(parts.info.totalBytes!)
        // The notice total is the legacy info value; the typed total is in
        // file lines (F9): it adds startLine when the ctx gives no totalLines.
        expect(f.noticeTotalLines).toBe(parts.info.totalLines!)
        expect(f.totalLines).toBe(
          c.ctx.totalLines ?? (c.ctx.startLine ?? 0) + parts.info.totalLines!,
        )
        expect(f.cutLine).toBe(parts.info.cutLine)
        expect(f.cutByte).toBe(f.shownBytes)
        expect(f.lineCharCap).toBe(MAX_TOOL_OUTPUT_LINE_CHARS)
        // Not more than totalLines, not less than startLine (S2: a read past the end).
        const start = c.ctx.startLine ?? 0
        expect(f.nextOffset).toBeLessThanOrEqual(Math.max(f.totalLines, start))
        expect(f.nextOffset).toBeGreaterThanOrEqual(start)
        expect(Object.isFrozen(f)).toBe(true)
        expect(Object.isFrozen(parts)).toBe(true)
        expect(Object.isFrozen(parts.info)).toBe(true)
        expect(f.truncated).toBe(parts.info.truncated)
        // One value: the notice is the render of the facts.
        if (parts.info.truncated) expect(renderTruncatedNotice(text, f)).toBe(parts.notice)
      })
    }
  }
})

describe("truncateToolOutputParts: facts (D-H)", () => {
  it("no cut: all facts are the totals, no partial line", () => {
    const p = truncateToolOutputParts(
      "a\nb\nc",
      { tool: "Read", startLine: 4 },
      EMPTY_SYNTHETIC_TEXT,
    )
    expect(p.facts).toEqual({
      truncated: false,
      tool: "Read",
      shownBytes: 5,
      totalBytes: 5,
      shownLines: 3,
      // File lines (F9): startLine 4 + 3 measured lines.
      totalLines: 7,
      totalLinesKnown: false,
      noticeTotalLines: 3,
      cutLine: 7,
      cutByte: 5,
      cutMidLine: false,
      longLines: 0,
      lineCharCap: MAX_TOOL_OUTPUT_LINE_CHARS,
      lastLinePartial: false,
      nextOffset: 7,
    })
  })

  it("line budget cut: the cut is at a line end", () => {
    const s = "row\n".repeat(MAX_TOOL_OUTPUT_LINES + 100)
    const p = truncateToolOutputParts(s, { tool: "Read", startLine: 0 }, EMPTY_SYNTHETIC_TEXT)
    expect(p.facts.shownLines).toBe(MAX_TOOL_OUTPUT_LINES)
    expect(p.facts.cutMidLine).toBe(false)
    expect(p.facts.lastLinePartial).toBe(false)
    expect(p.facts.longLines).toBe(0)
    expect(p.facts.nextOffset).toBe(MAX_TOOL_OUTPUT_LINES)
  })

  it("long lines after the shown region: longLines counts them, cutMidLine stays false", () => {
    const s = `${"row\n".repeat(MAX_TOOL_OUTPUT_LINES + 5)}${"Z".repeat(MAX_TOOL_OUTPUT_LINE_CHARS + 1)}`
    const p = truncateToolOutputParts(s, { tool: "Read", startLine: 0 }, EMPTY_SYNTHETIC_TEXT)
    expect(p.facts.longLines).toBe(1)
    expect(p.facts.cutMidLine).toBe(false)
  })

  it("byte cut inside a line (case B): lastLinePartial, nextOffset = cutLine - 1", () => {
    const s = Array.from({ length: 12 }, () => "y".repeat(8000)).join("\n")
    const p = truncateToolOutputParts(
      s,
      { tool: "Read", totalLines: 12, startLine: 0 },
      EMPTY_SYNTHETIC_TEXT,
    )
    expect(p.info.truncated).toBe(true)
    expect(p.facts.shownLines).toBe(8)
    expect(p.facts.cutLine).toBe(8)
    expect(p.facts.lastLinePartial).toBe(true)
    expect(p.facts.cutMidLine).toBe(true)
    expect(p.facts.longLines).toBe(0)
    expect(p.facts.nextOffset).toBe(7)
  })
})

describe("truncateToolOutputParts: totalLinesKnown and the new facts (M3c 4a)", () => {
  it("facts: totalLinesKnown is true when ctx.totalLines is given and false when core measured it", () => {
    // Pass-through path.
    const passGiven = truncateToolOutputParts(
      "a\nb\nc",
      { tool: "Read", totalLines: 3 },
      EMPTY_SYNTHETIC_TEXT,
    )
    const passMeasured = truncateToolOutputParts("a\nb\nc", { tool: "Read" }, EMPTY_SYNTHETIC_TEXT)
    expect(passGiven.facts.truncated).toBe(false)
    expect(passGiven.facts.totalLinesKnown).toBe(true)
    expect(passMeasured.facts.truncated).toBe(false)
    expect(passMeasured.facts.totalLinesKnown).toBe(false)
    // Cut path.
    const big = "row\n".repeat(MAX_TOOL_OUTPUT_LINES + 100)
    const cutGiven = truncateToolOutputParts(
      big,
      { tool: "Read", totalLines: MAX_TOOL_OUTPUT_LINES + 100 },
      EMPTY_SYNTHETIC_TEXT,
    )
    const cutMeasured = truncateToolOutputParts(big, { tool: "Read" }, EMPTY_SYNTHETIC_TEXT)
    expect(cutGiven.facts.truncated).toBe(true)
    expect(cutGiven.facts.totalLinesKnown).toBe(true)
    expect(cutMeasured.facts.truncated).toBe(true)
    expect(cutMeasured.facts.totalLinesKnown).toBe(false)
  })

  it("renderTruncatedNotice passes the new facts to the provider and the bytes do not change", () => {
    const s = Array.from({ length: 12 }, () => "y".repeat(8000)).join("\n")
    const parts = truncateToolOutputParts(
      s,
      { tool: "Read", totalLines: 12, startLine: 0 },
      EMPTY_SYNTHETIC_TEXT,
    )
    const f = parts.facts
    const seen: Array<{ kind: string; facts: Record<string, string | number | boolean> }> = []
    const recorder: SyntheticTextResolver = {
      resolve(kind, facts) {
        seen.push({ kind, facts: { ...facts } })
        return "N"
      },
    }
    expect(renderTruncatedNotice(recorder, f)).toBe("N")
    expect(seen).toHaveLength(1)
    expect(seen[0]!.kind).toBe("tool_output.truncated")
    // The 7 legacy facts, as before.
    expect(seen[0]!.facts).toMatchObject({
      tool: "Read",
      shownBytes: f.shownBytes,
      totalBytes: f.totalBytes,
      shownLines: f.shownLines,
      totalLines: f.noticeTotalLines,
      cutLine: f.cutLine,
      maxToolOutputBytes: MAX_TOOL_OUTPUT_BYTES,
    })
    // The 6 new facts.
    expect(seen[0]!.facts).toMatchObject({
      cutMidLine: true,
      longLines: 0,
      lineCharCap: MAX_TOOL_OUTPUT_LINE_CHARS,
      lastLinePartial: true,
      nextOffset: 7,
      totalLinesKnown: true,
    })
    // Facts with no new values (a caller of the old shape): only the 7 legacy facts.
    seen.length = 0
    renderTruncatedNotice(recorder, {
      tool: "Read",
      shownBytes: 1,
      totalBytes: 2,
      shownLines: 3,
      totalLines: 4,
      cutLine: 5,
    })
    expect(Object.keys(seen[0]!.facts).sort()).toEqual(
      [
        "tool",
        "shownBytes",
        "totalBytes",
        "shownLines",
        "totalLines",
        "cutLine",
        "maxToolOutputBytes",
      ].sort(),
    )
  })

  it.skipIf(!textFixturesPresent())(
    "renderTruncatedNotice with the fixture provider gives the same bytes as before",
    () => {
      const f = truncateToolOutputParts(
        linesWithLong(73, [3, 20, 40, 72], 50_000),
        { tool: "Read", totalBytes: 212092, totalLines: 73, startLine: 0 },
        TEXT!,
      ).facts
      // Literal text from the 73/73 test below (case A of M3c 4c: all 73
      // lines are shown, only the per-line clamp cut text).
      expect(renderTruncatedNotice(TEXT!, f)).toBe(
        `[truncated: shown ${f.shownBytes} of 212092 bytes. All 73 lines are shown, but the harness cut 4 long lines at about 8192 characters (see "...(+Nch)"). Read cannot show the rest of a line. Use Grep with a specific pattern, or Bash with cut -c on that line.]`,
      )
    },
  )
})

describe("truncateToolOutputParts: review fixes W2, W3, S2", () => {
  it("W3: multibyte byte cut that ends at a line end: lastLinePartial false, bytes unchanged", () => {
    // 100 lines of 333 x U+4E2D: 999 bytes + "\n" = 1000 bytes per line. The
    // byte cut at 64000 ends right after the "\n" of line 64. The old snap
    // (UTF-16 index vs byte count, known bug for M3c) keeps that "\n".
    const s = Array.from({ length: 100 }, () => "\u4e2d".repeat(333)).join("\n")
    const ctx: TruncateCtx = { tool: "Read", totalLines: 100, startLine: 0 }
    for (const text of [EMPTY_SYNTHETIC_TEXT, ...(TEXT ? [TEXT] : [])]) {
      const p = truncateToolOutputParts(s, ctx, text)
      expect(p.kept.endsWith("\n")).toBe(true)
      expect(p.facts.shownBytes).toBe(MAX_TOOL_OUTPUT_BYTES)
      expect(p.facts.shownLines).toBe(65)
      expect(p.facts.cutLine).toBe(65)
      expect(p.facts.lastLinePartial).toBe(false)
      expect(p.facts.cutMidLine).toBe(false)
      expect(p.facts.nextOffset).toBe(64)
      expect(joinTruncationParts(p)).toBe(legacyTruncate(s, ctx, text).content)
      expect(truncateToolOutput(s, ctx, text).content).toBe(legacyTruncate(s, ctx, text).content)
    }
  })

  it("W3: a long line after the cut at a line end is not a shown line", () => {
    // 64 lines of 1000 bytes, then a long multibyte line. The byte cut ends
    // right after the 64th "\n", so no char of the long line is shown.
    const s = [
      ...Array.from({ length: 64 }, () => "\u4e2d".repeat(333)),
      "\u4e2d".repeat(MAX_TOOL_OUTPUT_LINE_CHARS + 10),
    ].join("\n")
    const ctx: TruncateCtx = { tool: "Read", totalLines: 65, startLine: 0 }
    const p = truncateToolOutputParts(s, ctx, EMPTY_SYNTHETIC_TEXT)
    expect(p.kept.endsWith("\n")).toBe(true)
    expect(p.facts.longLines).toBe(1)
    expect(p.facts.lastLinePartial).toBe(false)
    expect(p.facts.cutMidLine).toBe(false)
    expect(p.facts.nextOffset).toBe(64)
    expect(joinTruncationParts(p)).toBe(legacyTruncate(s, ctx, EMPTY_SYNTHETIC_TEXT).content)
  })

  it("S2: nextOffset is not less than startLine on a read past the end", () => {
    const empty = truncateToolOutputParts(
      "",
      { tool: "Read", totalLines: 10, startLine: 50 },
      EMPTY_SYNTHETIC_TEXT,
    )
    expect(empty.facts.truncated).toBe(false)
    expect(empty.facts.nextOffset).toBe(50)
    const rows = truncateToolOutputParts(
      "a\nb",
      { tool: "Read", totalLines: 10, startLine: 50 },
      EMPTY_SYNTHETIC_TEXT,
    )
    expect(rows.facts.cutLine).toBe(52)
    expect(rows.facts.nextOffset).toBe(50)
    // Normal pass-through: nextOffset is totalLines (no line left).
    const normal = truncateToolOutputParts(
      "a\nb",
      { tool: "Read", totalLines: 10, startLine: 8 },
      EMPTY_SYNTHETIC_TEXT,
    )
    expect(normal.facts.nextOffset).toBe(10)
  })

  it("W2: parts.info is a frozen copy; the info of truncateToolOutput is a different object", () => {
    const s = "row\n".repeat(MAX_TOOL_OUTPUT_LINES + 10)
    const p = truncateToolOutputParts(s, { tool: "Read" }, EMPTY_SYNTHETIC_TEXT)
    expect(Object.isFrozen(p.info)).toBe(true)
    expect(p.facts.truncated).toBe(true)
    const r = truncateToolOutput(s, { tool: "Read" })
    expect(Object.isFrozen(r.info)).toBe(false)
    r.info.truncated = false
    expect(truncateToolOutput(s, { tool: "Read" }).info.truncated).toBe(true)
  })
})

describe("truncateToolOutputParts: F9 totalLines and nextOffset in file lines", () => {
  // A 1500-line slice that starts at file line 2000; the line budget cuts it.
  const slice = Array.from({ length: 1500 }, (_, i) => `row ${2000 + i}`).join("\n")

  it("startLine with no ctx.totalLines: cutLine, nextOffset and totalLines are file lines", () => {
    const ctx: TruncateCtx = { tool: "Read", startLine: 2000 }
    const p = truncateToolOutputParts(slice, ctx, EMPTY_SYNTHETIC_TEXT)
    const f = p.facts
    expect(p.info.truncated).toBe(true)
    expect(f.shownLines).toBe(MAX_TOOL_OUTPUT_LINES)
    expect(f.shownLines).toBeLessThan(1500)
    expect(f.cutLine).toBe(2000 + f.shownLines)
    expect(f.totalLines).toBe(2000 + 1500)
    expect(f.lastLinePartial).toBe(false)
    expect(f.nextOffset).toBe(f.cutLine)
    expect(f.nextOffset).toBeGreaterThan(2000)
    expect(f.nextOffset).toBeLessThanOrEqual(f.totalLines)
    // Lines are left to page: nextOffset < totalLines.
    expect(f.nextOffset).toBeLessThan(f.totalLines)
    // The legacy info and notice total stay the measured slice lines (no byte change).
    expect(p.info.totalLines).toBe(1500)
    expect(f.noticeTotalLines).toBe(1500)
    expect(p.notice).toBe(renderTruncatedNotice(EMPTY_SYNTHETIC_TEXT, f))
    expect(truncateToolOutput(slice, ctx).content).toBe(
      legacyTruncate(slice, ctx, EMPTY_SYNTHETIC_TEXT).content,
    )
    if (TEXT) {
      // The total is not known: the fixture text has no line count and no
      // offset hint (M3c 4c). The body before the notice stays the old bytes.
      const pt = truncateToolOutputParts(slice, ctx, TEXT)
      expect(pt.notice).toBe(
        `[truncated: shown ${f.shownBytes} of ${f.totalBytes} bytes. The harness cut the output; the total number of lines is not known. Use Grep with a specific pattern, or Bash with sed -n/cut -c, to see the part that you need.]`,
      )
      expect(pt.notice).not.toContain("offset=")
      expect(truncateToolOutput(slice, ctx, TEXT).content).toBe(
        `${beforeNotice(legacyTruncate(slice, ctx, TEXT).content)}${TRUNCATION_NOTICE_JOIN}${pt.notice}`,
      )
    }
  })

  it("startLine with ctx.totalLines: behavior does not change", () => {
    const ctx: TruncateCtx = { tool: "Read", startLine: 2000, totalLines: 3500 }
    const p = truncateToolOutputParts(slice, ctx, EMPTY_SYNTHETIC_TEXT)
    const f = p.facts
    expect(f.totalLines).toBe(3500)
    expect(f.noticeTotalLines).toBe(3500)
    expect(p.info.totalLines).toBe(3500)
    expect(f.cutLine).toBe(2000 + f.shownLines)
    expect(f.nextOffset).toBe(f.cutLine)
    expect(f.nextOffset).toBeLessThan(f.totalLines)
    expect(truncateToolOutput(slice, ctx).content).toBe(
      legacyTruncate(slice, ctx, EMPTY_SYNTHETIC_TEXT).content,
    )
    if (TEXT) {
      expect(truncateToolOutput(slice, ctx, TEXT).content).toBe(
        legacyTruncate(slice, ctx, TEXT).content,
      )
    }
  })
})

describe.skipIf(!textFixturesPresent())(
  "truncateToolOutputParts: 73/73 long-line repro (D-H)",
  () => {
    it("gives the case A text (M3c 4c) and correct facts", () => {
      const s = linesWithLong(73, [3, 20, 40, 72], 50_000)
      const totalBytes = Buffer.byteLength(s, "utf8")
      const ctx: TruncateCtx = { tool: "Read", totalBytes, totalLines: 73, startLine: 0 }
      const p = truncateToolOutputParts(s, ctx, TEXT!)
      // Case A (M3c 4c): all 73 lines are shown and only the per-line clamp
      // cut text. The old text pointed at offset=73 (past the end).
      expect(p.notice).toBe(
        `[truncated: shown ${p.facts.shownBytes} of ${totalBytes} bytes. All 73 lines are shown, but the harness cut 4 long lines at about 8192 characters (see "...(+Nch)"). Read cannot show the rest of a line. Use Grep with a specific pattern, or Bash with cut -c on that line.]`,
      )
      // legacyTruncate holds the old text, so the joined parts are the reference now.
      expect(truncateToolOutput(s, ctx, TEXT).content).toBe(joinTruncationParts(p))
      // Facts: the per-line clamp cut 4 shown lines; no byte cut inside a line.
      expect(p.facts.shownLines).toBe(73)
      expect(p.facts.totalLines).toBe(73)
      expect(p.facts.cutMidLine).toBe(true)
      expect(p.facts.longLines).toBe(4)
      expect(p.facts.lineCharCap).toBe(MAX_TOOL_OUTPUT_LINE_CHARS)
      expect(p.facts.lastLinePartial).toBe(false)
      // nextOffset is not past the end: it equals totalLines (no line left to page).
      expect(p.facts.nextOffset).toBe(73)
      expect(p.facts.nextOffset).toBeLessThanOrEqual(p.facts.totalLines)
      expect(p.facts.shownBytes).toBeLessThan(MAX_TOOL_OUTPUT_BYTES)
    })
  },
)

describe("truncation.ts public surface (review W4)", () => {
  it("exports the same runtime names as at a38c86b (host/truncation re-exports it)", async () => {
    const mod = await import("./truncation.ts")
    expect(Object.keys(mod).sort()).toEqual(
      [
        "MAX_TOOL_OUTPUT_BYTES",
        "MAX_TOOL_OUTPUT_LINES",
        "MAX_TOOL_OUTPUT_LINE_CHARS",
        "MAX_TOOL_RAW_BYTES",
        "clampToolOutputLines",
        "clampToolRaw",
        "countLines",
        "shouldRedact",
        "truncateToolOutput",
      ].sort(),
    )
  })
})
