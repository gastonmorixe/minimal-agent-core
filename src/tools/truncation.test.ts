import { describe, it, expect } from "bun:test"
import { truncateToolOutput, MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_LINES } from "./truncation.ts"

describe("truncateToolOutput — passthrough", () => {
  it("returns input unchanged when under both budgets", () => {
    const s = "hello\nworld"
    const { content, info } = truncateToolOutput(s)
    expect(content).toBe(s)
    expect(info.truncated).toBe(false)
    expect(info.shownLines).toBe(2)
  })

  it("returns empty string unchanged", () => {
    const { content, info } = truncateToolOutput("")
    expect(content).toBe("")
    expect(info.truncated).toBe(false)
    expect(info.shownBytes).toBe(0)
    expect(info.shownLines).toBe(0)
  })

  it("does not append a notice at exactly the byte budget", () => {
    const s = "x".repeat(MAX_TOOL_OUTPUT_BYTES)
    const { content, info } = truncateToolOutput(s)
    expect(content).toBe(s)
    expect(content).not.toContain("[truncated:")
    expect(info.truncated).toBe(false)
  })

  it("does not append a notice at exactly the line budget", () => {
    // MAX_TOOL_OUTPUT_LINES lines = (MAX-1) newlines.
    const s = Array.from({ length: MAX_TOOL_OUTPUT_LINES }, () => "a").join("\n")
    const { content, info } = truncateToolOutput(s)
    expect(content).toBe(s)
    expect(info.truncated).toBe(false)
  })
})

describe("truncateToolOutput — notice shape", () => {
  it("appends exactly one notice line prefixed with [truncated:", () => {
    const s = "x".repeat(MAX_TOOL_OUTPUT_BYTES + 1000)
    const { content } = truncateToolOutput(s)
    const lines = content.split("\n").filter((l) => l.startsWith("[truncated:"))
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatch(
      /^\[truncated: shown \d+ of [\w\d]+ bytes, \d+\/[\w\d]+ lines; cut at byte \d+, line \d+\. .+\]$/,
    )
  })

  it("reports `unknown` for totals when ctx omits them", () => {
    const s = "x".repeat(MAX_TOOL_OUTPUT_BYTES + 500)
    const { content } = truncateToolOutput(s)
    expect(content).toMatch(/of unknown bytes/)
    expect(content).toMatch(/\/unknown lines/)
  })

  it("reports exact totals when ctx provides them", () => {
    const total = MAX_TOOL_OUTPUT_BYTES * 4
    const s = "x".repeat(total)
    const { content, info } = truncateToolOutput(s, { totalBytes: total, totalLines: 1 })
    expect(content).toContain(`of ${total} bytes`)
    expect(content).toContain(`/1 lines`)
    expect(info.totalBytes).toBe(total)
    expect(info.totalLines).toBe(1)
  })

  it("`shown bytes` matches the actual kept slice", () => {
    const s = "line\n".repeat(MAX_TOOL_OUTPUT_LINES + 200)
    const { content, info } = truncateToolOutput(s, { totalBytes: Buffer.byteLength(s) })
    const m = content.match(/shown (\d+) of/)
    expect(m).not.toBeNull()
    const shown = Number(m![1])
    const kept = content.slice(0, content.lastIndexOf("\n\n[truncated:"))
    expect(Buffer.byteLength(kept)).toBe(shown)
    expect(info.shownBytes).toBe(shown)
  })
})

describe("truncateToolOutput — line/byte budgets", () => {
  it("clamps when over line budget but well under byte budget", () => {
    const s = "a\n".repeat(MAX_TOOL_OUTPUT_LINES + 50)
    const { content, info } = truncateToolOutput(s)
    expect(content).toContain("[truncated:")
    const kept = content.split("\n\n[truncated:")[0]
    expect(kept.split("\n").length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_LINES)
    expect(info.truncated).toBe(true)
    expect(info.shownLines).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_LINES)
  })

  it("clamps when over byte budget but under line budget (one huge line)", () => {
    const s = "x".repeat(MAX_TOOL_OUTPUT_BYTES * 3)
    const { content, info } = truncateToolOutput(s)
    expect(content).toContain("[truncated:")
    const kept = content.split("\n\n[truncated:")[0]
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES)
    expect(info.shownBytes).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES)
  })

  it("never returns a string longer than budget + small notice overhead", () => {
    const s = "x".repeat(MAX_TOOL_OUTPUT_BYTES * 10)
    const { content } = truncateToolOutput(s)
    expect(Buffer.byteLength(content)).toBeLessThan(MAX_TOOL_OUTPUT_BYTES + 500)
  })
})

describe("truncateToolOutput — cut location", () => {
  it("`cut at line` equals startLine + shownLines for offset reads", () => {
    const s = "row\n".repeat(MAX_TOOL_OUTPUT_LINES + 100)
    const { content, info } = truncateToolOutput(s, { tool: "Read", startLine: 500 })
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
    const s = "x".repeat(MAX_TOOL_OUTPUT_BYTES * 2)
    const { content, info } = truncateToolOutput(s)
    const shown = Number(content.match(/shown (\d+) of/)![1])
    const cut = Number(content.match(/cut at byte (\d+),/)![1])
    expect(cut).toBe(shown)
    expect(info.shownBytes).toBe(shown)
  })
})

describe("truncateToolOutput — per-tool resume hints", () => {
  const big = "row\n".repeat(MAX_TOOL_OUTPUT_LINES + 10)

  it("Read hint suggests offset= at the cut line", () => {
    const { content } = truncateToolOutput(big, { tool: "Read", startLine: 0 })
    expect(content).toMatch(/call Read with offset=\d+/)
  })

  it("Grep hint suggests narrowing", () => {
    const { content } = truncateToolOutput(big, { tool: "Grep" })
    expect(content).toMatch(/narrow|head_limit/i)
  })

  it("Bash hint suggests piping through head/sed/awk", () => {
    const { content } = truncateToolOutput(big, { tool: "Bash" })
    expect(content).toMatch(/head -c|sed -n|awk/)
  })

  it("Glob hint suggests narrowing pattern", () => {
    const { content } = truncateToolOutput(big, { tool: "Glob" })
    expect(content).toMatch(/narrow/i)
  })

  it("unknown tool falls back to generic hint", () => {
    const { content } = truncateToolOutput(big, { tool: "Mystery" })
    expect(content).toMatch(/narrower/)
  })

  it("explicit ctx.hint overrides default", () => {
    const { content } = truncateToolOutput(big, { tool: "Read", hint: "CUSTOM_HINT_STR" })
    expect(content).toContain("CUSTOM_HINT_STR")
    expect(content).not.toContain("call Read with offset=")
  })
})

describe("truncateToolOutput — utf-8 safety", () => {
  it("does not split a multi-byte codepoint at the byte boundary", () => {
    // "🙂" is 4 bytes; pad so the boundary lands mid-codepoint.
    const pad = "a".repeat(MAX_TOOL_OUTPUT_BYTES - 2)
    const s = pad + "🙂🙂🙂🙂🙂"
    const { content } = truncateToolOutput(s)
    // No replacement char from broken utf-8 in the kept content.
    const kept = content.split("\n\n[truncated:")[0]
    expect(kept).not.toContain("\uFFFD")
  })
})

describe("truncateToolOutput — info object", () => {
  it("propagates totals through info on passthrough", () => {
    const { info } = truncateToolOutput("hello\nworld\n")
    // 12 bytes (`hello\nworld\n`), 3 split-lines (`hello`, `world`, ``).
    expect(info.truncated).toBe(false)
    expect(info.shownBytes).toBe(12)
    expect(info.shownLines).toBe(3)
    expect(info.totalBytes).toBe(12)
    expect(info.totalLines).toBe(3)
  })

  it("info.totalBytes/totalLines reflect ctx values when source was bigger", () => {
    const s = "x".repeat(MAX_TOOL_OUTPUT_BYTES + 500)
    const { info } = truncateToolOutput(s, {
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
    const { content, info } = truncateToolOutput(s)
    const body = content.split("\n\n[truncated:")[0]
    expect(info.shownBytes).toBe(Buffer.byteLength(body, "utf8"))
    expect(info.shownLines).toBe(body.split("\n").length)
  })
})
