import { describe, expect, it } from "bun:test"

import { EditorBuffer } from "../../editor-buffer.ts"

import { EditorRenderer } from "./renderer.ts"

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
    // 18 chars + 2-cell prompt = 20 cells, exactly fills 2 physical rows.
    // Cursor sits at end-of-line on a wrap boundary → renderer appends a
    // phantom empty row so the cursor parks at row 2, col 0 (where the
    // next typed character will land), instead of getting clamped onto
    // the last visible cell at row 1, col 10.
    expect(out.lines.length).toBe(3)
    expect(out.lines[0]).toBe("❯ 12345678")
    expect(out.lines[1]).toBe("9012345678")
    expect(out.lines[2]).toBe("")
    expect(out.cursor).toEqual({ row: 2, col: 0 })
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

  describe("exact-fill cursor placement (post-insert model)", () => {
    it("end-of-line at exact wrap boundary parks on phantom next row", () => {
      // The original bug: prompt(2) + 8 chars = 10 cells in a 10-col TTY.
      // Without the fix, cursor would render at row 0, col 10 — clamped
      // onto the last printed cell, making it look like the next keystroke
      // replaces 'h' instead of inserting after it.
      const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "  " })
      const buf = new EditorBuffer()
      buf.insert("12345678")
      const out = r.render(buf, { columns: 10 })
      expect(out.lines).toEqual(["❯ 12345678", ""])
      expect(out.cursor).toEqual({ row: 1, col: 0 })
    })

    it("mid-line at exact wrap boundary jumps to existing next row col 0", () => {
      // 200 chars: prompt(2) + 78 first row + 80 + 42. Cursor at col 78
      // (logical) sits on the boundary between row 0 and row 1; should
      // render at row 1 col 0, not row 0 col 80.
      const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "  " })
      const buf = new EditorBuffer()
      buf.insert("x".repeat(200))
      buf.col = 78
      const out = r.render(buf, { columns: 80 })
      // Three physical rows: 78 + 80 + 42 chars.
      expect(out.lines.length).toBe(3)
      // No phantom appended — cursor is mid-line, the next row already exists.
      expect(out.lines[2].length).toBe(42)
      expect(out.cursor).toEqual({ row: 1, col: 0 })
    })

    it("end-of-line after multiple wraps appends one phantom row", () => {
      // 158 chars: prompt(2) + 78 + 80, exact fill across 2 rows.
      const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "  " })
      const buf = new EditorBuffer()
      buf.insert("y".repeat(158))
      const out = r.render(buf, { columns: 80 })
      expect(out.lines.length).toBe(3)
      expect(out.lines[2]).toBe("")
      expect(out.cursor).toEqual({ row: 2, col: 0 })
    })

    it("non-exact-fill end-of-line keeps legacy placement", () => {
      const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "  " })
      const buf = new EditorBuffer()
      buf.insert("12345") // 5 chars, total 7 cells in 10-col → no boundary
      const out = r.render(buf, { columns: 10 })
      expect(out.lines).toEqual(["❯ 12345"])
      expect(out.cursor).toEqual({ row: 0, col: 7 })
    })

    it("empty buffer is not treated as exact-fill", () => {
      const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "  " })
      const buf = new EditorBuffer()
      const out = r.render(buf, { columns: 10 })
      expect(out.lines).toEqual(["❯ "])
      expect(out.cursor).toEqual({ row: 0, col: 2 })
    })

    it("exact-fill on a continuation line uses continuation prompt width", () => {
      // Line 1 with continuation prompt "· " (width 2) + 8 chars = 10 cells.
      const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "· " })
      const buf = new EditorBuffer()
      buf.insert("a")
      buf.newline()
      buf.insert("12345678")
      const out = r.render(buf, { columns: 10 })
      // line 0: "❯ a" (1 row); line 1: "· 12345678" (1 row) + phantom.
      expect(out.lines).toEqual(["❯ a", "· 12345678", ""])
      expect(out.cursor).toEqual({ row: 2, col: 0 })
    })

    it("measureRows reserves the phantom row for exact-fill end-of-line", () => {
      const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "  " })
      const buf = new EditorBuffer()
      buf.insert("12345678") // exact-fill at col 8 in cols=10
      expect(r.measureRows(buf, 10)).toBe(2)
    })

    it("measureRows does not add a phantom row when cursor is mid-line", () => {
      const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "  " })
      const buf = new EditorBuffer()
      buf.insert("x".repeat(200))
      buf.col = 78 // boundary, but not at end-of-line
      expect(r.measureRows(buf, 80)).toBe(3)
    })

    it("measureRows does not add a phantom row when cursor is on a different line", () => {
      // Line 0 is exact-fill (8 chars + 2 prompt = 10), but cursor lives on line 1.
      const r = new EditorRenderer({ prompt: "❯ ", continuationPrompt: "  " })
      const buf = new EditorBuffer()
      buf.insert("12345678")
      buf.newline()
      buf.insert("x")
      expect(r.measureRows(buf, 10)).toBe(2)
    })
  })

  it("measureRows uses display width for wide / emoji content", () => {
    const r = new EditorRenderer({ prompt: "> ", continuationPrompt: "  " })
    const buf = new EditorBuffer()
    // 5 emoji × 2 cells + 2-cell prompt = 12 cells → 2 rows in a 10-col TTY.
    buf.insert("🙂🙂🙂🙂🙂")
    expect(r.measureRows(buf, 10)).toBe(2)
  })
})

describe("EditorRenderer — showHidden", () => {
  it("spaces become faint middle-dot glyphs", () => {
    const r = new EditorRenderer({ prompt: "> ", continuationPrompt: "  ", showHidden: true })
    const buf = new EditorBuffer()
    buf.insert("a b")
    const out = r.render(buf)
    // Space at position 1 should be replaced with the faint · indicator.
    expect(out.lines[0]).toContain("\x1b[2m\u00b7\x1b[22m")
    // Cursor is still placed at col 5 (2 prompt + "a b" = 3 chars × 1 cell each)
    expect(out.cursor).toEqual({ row: 0, col: 5 })
  })

  it("tabs become faint arrow glyphs", () => {
    const r = new EditorRenderer({ prompt: "> ", continuationPrompt: "  ", showHidden: true })
    const buf = new EditorBuffer()
    buf.insert("a\tb")
    const out = r.render(buf)
    expect(out.lines[0]).toContain("\x1b[2m\u2192\x1b[22m")
  })

  it("non-last logical lines get a faint ↵ marker appended", () => {
    const r = new EditorRenderer({ prompt: "> ", continuationPrompt: "  ", showHidden: true })
    const buf = new EditorBuffer()
    buf.insert("line1")
    buf.newline()
    buf.insert("line2")
    const out = r.render(buf)
    // First rendered line should end with ↵
    expect(out.lines[0]).toContain("\x1b[2m\u21b5\x1b[22m")
    // Last line should NOT have ↵
    expect(out.lines[1]).not.toContain("\u21b5")
  })

  it("last logical line has no ↵ marker", () => {
    const r = new EditorRenderer({ prompt: "> ", continuationPrompt: "  ", showHidden: true })
    const buf = new EditorBuffer()
    buf.insert("only line")
    const out = r.render(buf)
    expect(out.lines[0]).not.toContain("\u21b5")
  })

  it("setShowHidden toggles the feature at runtime", () => {
    const r = new EditorRenderer({ prompt: "> ", continuationPrompt: "  " })
    const buf = new EditorBuffer()
    buf.insert("a b")
    // Off by default.
    expect(r.render(buf).lines[0]).toBe("> a b")
    // Enable.
    r.setShowHidden(true)
    expect(r.render(buf).lines[0]).toContain("\u00b7")
    // Disable again.
    r.setShowHidden(false)
    expect(r.render(buf).lines[0]).toBe("> a b")
  })

  it("wrapping: ↵ appended only to last physical chunk of a logical line", () => {
    // Line wider than columns → wraps into 2 physical rows.
    const r = new EditorRenderer({ prompt: "> ", continuationPrompt: "  ", showHidden: true })
    const buf = new EditorBuffer()
    buf.insert("aaa")
    buf.newline()
    buf.insert("bbb")
    const out = r.render(buf, { columns: 6 }) // "❯ " + 4 chars → wraps at 4
    // The ↵ should be on the last physical row of "aaa", not on intermediate rows.
    const allLines = out.lines.join("\n")
    // "aaa" fits in 4 cells (6 - 2 prompt) → 1 chunk, gets ↵
    expect(out.lines[0]).toContain("\u21b5")
    // "bbb" is the last logical line, no ↵
    expect(out.lines[out.lines.length - 1]).not.toContain("\u21b5")
    void allLines
  })
})
