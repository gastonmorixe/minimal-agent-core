import { describe, expect, it } from "bun:test"
import { EditorBuffer } from "./editor-buffer.ts"
import { EditorRenderer } from "./editor-renderer.ts"

describe("EditorRenderer", () => {
  it("renders an empty buffer as a single prompt-only row", () => {
    const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "  " })
    const buf = new EditorBuffer()
    const out = r.render(buf)
    expect(out.lines).toEqual(["❯ "])
    expect(out.cursor).toEqual({ row: 0, col: 2 })
  })

  it("includes prompt + content on row 0 and computes cursor column", () => {
    const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "  " })
    const buf = new EditorBuffer()
    buf.insert("hello")
    const out = r.render(buf)
    expect(out.lines).toEqual(["❯ hello"])
    expect(out.cursor).toEqual({ row: 0, col: 7 })
  })

  it("uses continuation prompt for rows beyond the first", () => {
    const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "· " })
    const buf = new EditorBuffer()
    buf.insert("a")
    buf.newline()
    buf.insert("bb")
    const out = r.render(buf)
    expect(out.lines).toEqual(["❯ a", "· bb"])
    expect(out.cursor).toEqual({ row: 1, col: 4 })
  })

  it("counts only visible characters of a prompt with ANSI escapes", () => {
    const r = new EditorRenderer({
      prompt: "\x1b[31m❯\x1b[0m ",
      continuationPrompt: "  ",
    })
    const buf = new EditorBuffer()
    buf.insert("x")
    const out = r.render(buf)
    expect(out.cursor).toEqual({ row: 0, col: 3 }) // ❯ + space + x → 3 visible cols
  })

  it("renders a windowed slice when {firstRow, rowCount} are given", () => {
    const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "· " })
    const buf = new EditorBuffer()
    buf.insert("a")
    buf.newline()
    buf.insert("b")
    buf.newline()
    buf.insert("c")
    buf.newline()
    buf.insert("d")
    // window starts at row 1, height 2 → shows "b" and "c".
    const out = r.render(buf, { firstRow: 1, rowCount: 2 })
    // First visible row uses continuation prompt because firstRow > 0.
    expect(out.lines).toEqual(["· b", "· c"])
    // cursor is on logical row 3 → outside window → clamped to last row.
    expect(out.cursor.row).toBe(1)
  })

  it("measureRows matches lines.length", () => {
    const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "  " })
    const buf = new EditorBuffer()
    buf.insert("a")
    buf.newline()
    buf.insert("b")
    expect(r.measureRows(buf)).toBe(2)
  })

  it("measureRows accounts for soft-wrap when columns is provided", () => {
    const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "  " })
    const buf = new EditorBuffer()
    // 18 chars of content + 2-cell prompt = 20 cells. In a 10-col terminal
    // that's 2 physical rows for line 0, plus 1 for line 1.
    buf.insert("123456789012345678")
    buf.newline()
    buf.insert("x")
    expect(r.measureRows(buf, 10)).toBe(3)
  })

  it("wraps long lines into physical rows when columns is given", () => {
    const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "  " })
    const buf = new EditorBuffer()
    // 18 chars + 2-cell prompt = 20 cells. cols=10 → first row "❯ 12345678"
    // (8 content + 2 prompt = 10), continuation rows "9012345678" then "" if any.
    buf.insert("123456789012345678")
    const out = r.render(buf, { columns: 10 })
    expect(out.lines.length).toBe(2)
    expect(out.lines[0]).toBe("❯ 12345678")
    expect(out.lines[1]).toBe("9012345678")
    // cursor at end of buffer: col=18, promptW=2 → total=20, on cols=10
    // → row offset 1 (using cursorRowOffset semantics: exact-fill stays on
    // current row, so 19 cells past start = row 1, visualCol = 10).
    expect(out.cursor).toEqual({ row: 1, col: 10 })
  })

  it("places cursor in physical coordinates after a wrap", () => {
    const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "  " })
    const buf = new EditorBuffer()
    buf.insert("12345678901234") // 14 chars, prompt 2 → 16 cells
    // Move cursor to col 12: displayWidth before = 12, +2 prompt = 14
    // → row offset 1 (since 14 > 10), visualCol = 14 % 10 = 4
    buf.col = 12
    const out = r.render(buf, { columns: 10 })
    expect(out.cursor).toEqual({ row: 1, col: 4 })
  })

  it("falls back to one-row-per-logical-line without columns (legacy)", () => {
    const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "  " })
    const buf = new EditorBuffer()
    buf.insert("123456789012345678")
    const out = r.render(buf)
    expect(out.lines).toEqual(["❯ 123456789012345678"])
    expect(out.cursor).toEqual({ row: 0, col: 20 })
  })

  it("measureRows uses display width for wide / emoji content", () => {
    const r = new EditorRenderer({ prompt: "> ", continuationPrompt: "  " })
    const buf = new EditorBuffer()
    // 5 emoji × 2 cells + 2-cell prompt = 12 cells → 2 rows in a 10-col TTY.
    buf.insert("🙂🙂🙂🙂🙂")
    expect(r.measureRows(buf, 10)).toBe(2)
  })
})
