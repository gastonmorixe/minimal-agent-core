import { describe, it, expect } from "bun:test"
import {
  truncateToolOutput,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TOOL_OUTPUT_LINES,
} from "./truncation.ts"

describe("truncateToolOutput — passthrough", () => {
  it("returns input unchanged when under both budgets", () => {
    const s = "hello\nworld"
    expect(truncateToolOutput(s)).toBe(s)
  })

  it("returns empty string unchanged", () => {
    expect(truncateToolOutput("")).toBe("")
  })

  it("does not append a notice at exactly the byte budget", () => {
    const s = "x".repeat(MAX_TOOL_OUTPUT_BYTES)
    const out = truncateToolOutput(s)
    expect(out).toBe(s)
    expect(out).not.toContain("[truncated:")
  })

  it("does not append a notice at exactly the line budget", () => {
    // MAX_TOOL_OUTPUT_LINES lines = (MAX-1) newlines.
    const s = Array.from({ length: MAX_TOOL_OUTPUT_LINES }, () => "a").join("\n")
    expect(truncateToolOutput(s)).toBe(s)
  })
})

describe("truncateToolOutput — notice shape", () => {
  it("appends exactly one notice line prefixed with [truncated:", () => {
    const s = "x".repeat(MAX_TOOL_OUTPUT_BYTES + 1000)
    const out = truncateToolOutput(s)
    const lines = out.split("\n").filter((l) => l.startsWith("[truncated:"))
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatch(
      /^\[truncated: shown \d+ of [\w\d]+ bytes, \d+\/[\w\d]+ lines; cut at byte \d+, line \d+\. .+\]$/,
    )
  })

  it("reports `unknown` for totals when ctx omits them", () => {
    const s = "x".repeat(MAX_TOOL_OUTPUT_BYTES + 500)
    const out = truncateToolOutput(s)
    expect(out).toMatch(/of unknown bytes/)
    expect(out).toMatch(/\/unknown lines/)
  })

  it("reports exact totals when ctx provides them", () => {
    const total = MAX_TOOL_OUTPUT_BYTES * 4
    const s = "x".repeat(total)
    const out = truncateToolOutput(s, { totalBytes: total, totalLines: 1 })
    expect(out).toContain(`of ${total} bytes`)
    expect(out).toContain(`/1 lines`)
  })

  it("`shown bytes` matches the actual kept slice", () => {
    const s = "line\n".repeat(MAX_TOOL_OUTPUT_LINES + 200)
    const out = truncateToolOutput(s, { totalBytes: Buffer.byteLength(s) })
    const m = out.match(/shown (\d+) of/)
    expect(m).not.toBeNull()
    const shown = Number(m![1])
    const kept = out.slice(0, out.lastIndexOf("\n\n[truncated:"))
    expect(Buffer.byteLength(kept)).toBe(shown)
  })
})

describe("truncateToolOutput — line/byte budgets", () => {
  it("clamps when over line budget but well under byte budget", () => {
    const s = "a\n".repeat(MAX_TOOL_OUTPUT_LINES + 50)
    const out = truncateToolOutput(s)
    expect(out).toContain("[truncated:")
    const kept = out.split("\n\n[truncated:")[0]
    expect(kept.split("\n").length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_LINES)
  })

  it("clamps when over byte budget but under line budget (one huge line)", () => {
    const s = "x".repeat(MAX_TOOL_OUTPUT_BYTES * 3)
    const out = truncateToolOutput(s)
    expect(out).toContain("[truncated:")
    const kept = out.split("\n\n[truncated:")[0]
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES)
  })

  it("never returns a string longer than budget + small notice overhead", () => {
    const s = "x".repeat(MAX_TOOL_OUTPUT_BYTES * 10)
    const out = truncateToolOutput(s)
    expect(Buffer.byteLength(out)).toBeLessThan(MAX_TOOL_OUTPUT_BYTES + 500)
  })
})

describe("truncateToolOutput — cut location", () => {
  it("`cut at line` equals startLine + shownLines for offset reads", () => {
    const s = "row\n".repeat(MAX_TOOL_OUTPUT_LINES + 100)
    const out = truncateToolOutput(s, { tool: "Read", startLine: 500 })
    const m = out.match(/cut at byte \d+, line (\d+)/)
    expect(m).not.toBeNull()
    const cutLine = Number(m![1])
    // Kept is at most MAX_TOOL_OUTPUT_LINES; cut line = 500 + shownLines.
    expect(cutLine).toBeGreaterThan(500)
    expect(cutLine).toBeLessThanOrEqual(500 + MAX_TOOL_OUTPUT_LINES)
  })

  it("`cut at byte` equals shown bytes", () => {
    const s = "x".repeat(MAX_TOOL_OUTPUT_BYTES * 2)
    const out = truncateToolOutput(s)
    const shown = Number(out.match(/shown (\d+) of/)![1])
    const cut = Number(out.match(/cut at byte (\d+),/)![1])
    expect(cut).toBe(shown)
  })
})

describe("truncateToolOutput — per-tool resume hints", () => {
  const big = "row\n".repeat(MAX_TOOL_OUTPUT_LINES + 10)

  it("Read hint suggests offset= at the cut line", () => {
    const out = truncateToolOutput(big, { tool: "Read", startLine: 0 })
    expect(out).toMatch(/call Read with offset=\d+/)
  })

  it("Grep hint suggests narrowing", () => {
    const out = truncateToolOutput(big, { tool: "Grep" })
    expect(out).toMatch(/narrow|head_limit/i)
  })

  it("Bash hint suggests piping through head/sed/awk", () => {
    const out = truncateToolOutput(big, { tool: "Bash" })
    expect(out).toMatch(/head -c|sed -n|awk/)
  })

  it("Glob hint suggests narrowing pattern", () => {
    const out = truncateToolOutput(big, { tool: "Glob" })
    expect(out).toMatch(/narrow/i)
  })

  it("unknown tool falls back to generic hint", () => {
    const out = truncateToolOutput(big, { tool: "Mystery" })
    expect(out).toMatch(/narrower/)
  })

  it("explicit ctx.hint overrides default", () => {
    const out = truncateToolOutput(big, { tool: "Read", hint: "CUSTOM_HINT_STR" })
    expect(out).toContain("CUSTOM_HINT_STR")
    expect(out).not.toContain("call Read with offset=")
  })
})

describe("truncateToolOutput — utf-8 safety", () => {
  it("does not split a multi-byte codepoint at the byte boundary", () => {
    // "🙂" is 4 bytes; pad so the boundary lands mid-codepoint.
    const pad = "a".repeat(MAX_TOOL_OUTPUT_BYTES - 2)
    const s = pad + "🙂🙂🙂🙂🙂"
    const out = truncateToolOutput(s)
    // No replacement char from broken utf-8 in the kept content.
    const kept = out.split("\n\n[truncated:")[0]
    expect(kept).not.toContain("\uFFFD")
  })
})
