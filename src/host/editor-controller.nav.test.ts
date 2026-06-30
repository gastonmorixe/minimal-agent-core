import { describe, expect, it } from "bun:test"

import { FakeCompositor, FakeOutput, FakeTTYInput, make } from "./editor-controller.fixtures.ts"
import { EditorController } from "./editor-controller.ts"

describe("EditorController — Shift+Enter via bare LF", () => {
  // iTerm2 (and many other terminals) ship with no default mapping for
  // Shift+Enter — it sends the same bytes as plain Enter. Users who want
  // Shift+Enter to insert a newline (matching Alt/Option+Enter, which
  // works via the `\x1b\r` meta-prefix) can add a key binding that sends
  // a bare `\n` (LF / Ctrl+J / hex 0x0a) for Shift+Return. The editor's
  // input loop then distinguishes:
  //
  //   - bare `\r`              → submit          (real Enter)
  //   - `\r\n` / `\n\r` pair   → submit          (CRLF coalesced)
  //   - bare `\n` (no partner) → insert newline  (Shift+Enter / Ctrl+J)
  //
  // These tests check buffer/submit semantics directly via the public
  // event surface, so they aren't sensitive to the live-area layout
  // (status row, footer spacers, etc.) which is exercised elsewhere.

  function makeEditor() {
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new FakeCompositor()
    const ctrl = new EditorController({
      prompt: "> ",
      continuationPrompt: "  ",
      compositor: compositor as any,
      stdin: stdin as any,
      output: output as any,
      maxLiveHeight: 10,
    })
    const submits: string[] = []
    ctrl.on("submit", (text) => submits.push(text))
    return { ctrl, stdin, submits }
  }

  it("bare LF inserts a newline; subsequent CR submits the full text", () => {
    const { ctrl, stdin, submits } = makeEditor()
    ctrl.start()
    stdin.send("hello")
    stdin.send("\n") // Shift+Enter via terminal keymap (or Ctrl+J)
    stdin.send("world")
    expect(submits).toEqual([]) // no submit yet
    expect(ctrl.buffer().toString()).toBe("hello\nworld")
    stdin.send("\r") // real Enter
    expect(submits).toEqual(["hello\nworld"])
    ctrl.stop()
  })

  it("CR alone still submits as plain Enter", () => {
    const { ctrl, stdin, submits } = makeEditor()
    ctrl.start()
    stdin.send("hello")
    stdin.send("\r")
    expect(submits).toEqual(["hello"])
    ctrl.stop()
  })

  it("CRLF coalesces into a single submit (Windows / pasted-line case)", () => {
    const { ctrl, stdin, submits } = makeEditor()
    ctrl.start()
    stdin.send("hello")
    stdin.send("\r\n")
    expect(submits).toEqual(["hello"])
    ctrl.stop()
  })

  it("LFCR coalesces into a single submit (rare but mirrors RawInput)", () => {
    const { ctrl, stdin, submits } = makeEditor()
    ctrl.start()
    stdin.send("hello")
    stdin.send("\n\r")
    expect(submits).toEqual(["hello"])
    ctrl.stop()
  })

  it("multiple bare LFs build up a multi-line buffer", () => {
    const { ctrl, stdin, submits } = makeEditor()
    ctrl.start()
    stdin.send("a")
    stdin.send("\n")
    stdin.send("b")
    stdin.send("\n")
    stdin.send("c")
    expect(submits).toEqual([])
    expect(ctrl.buffer().toString()).toBe("a\nb\nc")
    stdin.send("\r")
    expect(submits).toEqual(["a\nb\nc"])
    ctrl.stop()
  })

  it("bare LF and Alt+Enter (\\x1b\\r) produce identical results", () => {
    // Both modifier-Enter encodings (Shift via LF keymap, Alt via legacy
    // meta-prefix) must behave the same. Run them as parallel inputs
    // and compare the resulting buffer state.
    const a = makeEditor()
    a.ctrl.start()
    a.stdin.send("foo")
    a.stdin.send("\n") // Shift+Enter via keymap
    a.stdin.send("bar")

    const b = makeEditor()
    b.ctrl.start()
    b.stdin.send("foo")
    b.stdin.send("\x1b\r") // Alt/Option+Enter
    b.stdin.send("bar")

    expect(a.ctrl.buffer().toString()).toBe(b.ctrl.buffer().toString())
    expect(a.ctrl.buffer().toString()).toBe("foo\nbar")

    a.stdin.send("\r")
    b.stdin.send("\r")
    expect(a.submits).toEqual(b.submits)
    expect(a.submits).toEqual(["foo\nbar"])

    a.ctrl.stop()
    b.ctrl.stop()
  })

  it("bare LF on an EMPTY buffer inserts a blank-line newline (matches Alt+Enter)", () => {
    // Regression: an earlier ordering let the `isBlank()` no-op swallow
    // bare LF, so Shift+Enter (via terminal keymap) on an empty prompt
    // did nothing — but Alt+Enter (`\x1b\r`) bypassed `isBlank()` via
    // the escape parser and inserted a blank-line newline. The two
    // newline-insert keys must agree on empty buffers.
    const a = makeEditor()
    a.ctrl.start()
    a.stdin.send("\n") // Shift+Enter via keymap on EMPTY buffer

    const b = makeEditor()
    b.ctrl.start()
    b.stdin.send("\x1b\r") // Alt/Option+Enter on EMPTY buffer

    expect(a.ctrl.buffer().toString()).toBe(b.ctrl.buffer().toString())
    expect(a.ctrl.buffer().toString()).toBe("\n")
    expect(a.submits).toEqual([])
    expect(b.submits).toEqual([])

    a.ctrl.stop()
    b.ctrl.stop()
  })

  it("bare LF on a whitespace-only buffer still inserts a newline (no isBlank swallow)", () => {
    // Whitespace-only is also "blank" to the existing isBlank() no-op,
    // but Shift+Enter / Ctrl+J should still expand the buffer.
    const { ctrl, stdin, submits } = makeEditor()
    ctrl.start()
    stdin.send("   ") // only spaces
    stdin.send("\n") // Shift+Enter
    expect(submits).toEqual([])
    expect(ctrl.buffer().toString()).toBe("   \n")
    ctrl.stop()
  })

  it("real Enter (\\r) on an empty buffer remains the no-op (existing shell convention)", () => {
    // Counter-test: my fix must NOT change the long-standing "press
    // Enter on empty line = no-op, don't submit, don't insert" behavior.
    const { ctrl, stdin, submits } = makeEditor()
    ctrl.start()
    stdin.send("\r")
    stdin.send("\r")
    stdin.send("\r")
    expect(submits).toEqual([])
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })
})

describe("EditorController — wrap-aware up/down (visual rows)", () => {
  // Helper: build a 20-col terminal with a fresh controller.
  // Prompt is "> " (2 cells) so each wrap chunk past the first has 20 cells.
  function makeWrap(opts: { columns?: number; prompt?: string; continuation?: string } = {}) {
    return make({
      columns: opts.columns ?? 20,
      prompt: opts.prompt ?? "> ",
      continuation: opts.continuation ?? "  ",
    })
  }

  it("Up on a wrapped logical line walks to the previous wrap chunk of the SAME line", () => {
    // 50-char line on a 20-col term with "> " prompt → 3 visual rows:
    //   row 0: prompt "> " + first 18 chars
    //   row 1: chars 18..37 (20 cells)
    //   row 2: chars 38..49 (12 cells)
    const { ctrl, stdin } = makeWrap()
    ctrl.start()
    const text = "0123456789".repeat(5) // 50 chars
    stdin.send(text)
    // Cursor at end of line, on visual row 2 (col 12 of the row 2).
    expect(ctrl.buffer().col).toBe(50)
    expect(ctrl.buffer().row).toBe(0)
    // Press Up: should stay on logical row 0, but move buf.col so visual
    // pos is on row 1, col 12 (preserving column 12). That maps to
    // char index = (row1 start = 18) + 12 = 30.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(30)
    // Press Up again: should walk to visual row 0, col 12. Row 0 starts
    // after "> " (promptW=2), so target absolute cell = 0*20 + 12 = 12.
    // Subtract promptW=2 → content cells = 10. col = 10.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(10)
    // Press Up at top: no-op.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(10)
    ctrl.stop()
  })

  it("Down on a wrapped logical line walks to the next wrap chunk of the SAME line", () => {
    const { ctrl, stdin } = makeWrap()
    ctrl.start()
    const text = "0123456789".repeat(5) // 50 chars
    stdin.send(text)
    // Cursor at end (col 50, visual row 2). Press Home → col 0, visual
    // row 0. Then Down → visual row 1. Then Down → visual row 2.
    stdin.send("\x1b[H") // Home: col 0 of logical row 0
    expect(ctrl.buffer().col).toBe(0)
    stdin.send("\x1b[B") // Down
    // Cursor at col 0 on visual row 0 = visual col 2 (prompt "> " is 2
    // cells). Sticky sample: desiredVisualCol = 2. Target visual row 1,
    // visual col 2. Row 1 starts at char 18 (row 0 held 18 chars before
    // wrap) and has no prompt, so visual col 2 → char 18 + 2 = 20.
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(20)
    stdin.send("\x1b[B") // Down → visual row 2, visual col 2 = char 38 + 2 = 40
    expect(ctrl.buffer().col).toBe(40)
    // Press Down again. Sticky col is 2; only 12 cells of content in
    // row 2 so visual col 2 is still inside the row. But we're already
    // on the LAST visual row of logical line 0, AND there's no logical
    // line 1, so it's a no-op.
    stdin.send("\x1b[B")
    expect(ctrl.buffer().col).toBe(40)
    ctrl.stop()
  })

  it("Up from the first wrap chunk of a logical line crosses into prior logical line's LAST wrap chunk", () => {
    const { ctrl, stdin } = makeWrap()
    ctrl.start()
    // Logical line 0: 30 chars (wraps to 2 visual rows on 20-col term
    // with 2-cell prompt: row 0 = 18 chars, row 1 = 12 chars).
    stdin.send("0123456789".repeat(3))
    stdin.send("\x1b\r") // Alt+Enter: insert newline
    // Logical line 1: 10 chars (1 visual row).
    stdin.send("ABCDEFGHIJ")
    expect(ctrl.buffer().row).toBe(1)
    expect(ctrl.buffer().col).toBe(10)
    // Press Up: from logical row 1, visual row 0, visual col 12 (10
    // chars + 2-cell continuation prompt). Should cross into logical
    // row 0's LAST visual row (row 1 of 2), at visual col 12.
    // Row 1 of logical line 0 starts at char 18 (since row 0 held
    // 0..17). Visual col 12 → char index 18 + 12 = 30 (end of line).
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(30)
    // Press Up again: from logical row 0, visual row 1 → visual row 0.
    // Target visual col 12 on row 0; row 0 has prompt eating cells 0..1,
    // so target char = visual col 12 - prompt 2 = char index 10.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(10)
    ctrl.stop()
  })

  it("Down from the last wrap chunk crosses into next logical line at the same visual col", () => {
    const { ctrl, stdin } = makeWrap()
    ctrl.start()
    stdin.send("0123456789".repeat(3)) // logical 0, 30 chars
    stdin.send("\x1b\r")
    stdin.send("ABCDEFGHIJ") // logical 1, 10 chars
    // Move back to logical 0, last visual row, col 24 (visual col 6 on
    // row 1: chars 18..29 in line). char index 24.
    stdin.send("\x1b[H") // line start (logical 0, col 0) — wait, we're on logical 1
    // Reset cursor: Home goes to logical-line start, not visual-row start.
    // From logical 1 col 10 → Home → logical 1 col 0.
    stdin.send("\x1b[A") // up → logical 0, last visual row, visual col 0 + continuationPromptW
    // logical 1 had continuationPromptW=2, visualCol of col=0 = 2.
    // Up: target visual col 2 on logical 0 last visual row.
    // Row 1 of logical 0: chars 18..29, no prompt. visual col 2 = char 18 + 2 = 20.
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(20)
    // Press Down: cross from logical 0 last visual row to logical 1 first row.
    // Target visual col 2 on logical 1 row 0. Row 0 has continuationPromptW=2,
    // so target char = visual col 2 - prompt 2 = 0.
    stdin.send("\x1b[B")
    expect(ctrl.buffer().row).toBe(1)
    expect(ctrl.buffer().col).toBe(0)
    ctrl.stop()
  })

  it("sticky desired-visual-col survives walking through SHORTER rows then re-extends", () => {
    const { ctrl, stdin } = makeWrap()
    ctrl.start()
    // Line 0: 25 chars (wraps to 2 rows: 18 + 7)
    stdin.send("0123456789".repeat(2) + "ABCDE") // 25 chars
    stdin.send("\x1b\r")
    // Line 1: 5 chars (1 row)
    stdin.send("XYZAB")
    stdin.send("\x1b\r")
    // Line 2: 25 chars (wraps to 2 rows: 18 + 7)
    stdin.send("9876543210".repeat(2) + "VWXYZ")
    // Cursor at end of line 2, visual col = 7 (chars 18..24 = 7 cells; cursor after).
    expect(ctrl.buffer().row).toBe(2)
    expect(ctrl.buffer().col).toBe(25)
    // Up: walk through line 2's row 0 (visual col 7). col = 7 cells from
    // line start, prompt is continuation (2), so content col = 7-2 = 5.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(2)
    expect(ctrl.buffer().col).toBe(5)
    // Up: into line 1 (only 5 chars, 1 visual row). visual col 7 is
    // past the line's actual content; clamp to end-of-line. col = 5.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(1)
    expect(ctrl.buffer().col).toBe(5)
    // Up: into line 0 last visual row (row 1: chars 18..24). visual col
    // 7 maps to char 18 + 7 = 25 (end of line). Sticky col is STILL 7
    // (carried from initial sample), so even though line 1 forced us to
    // col 5 visually, we should land at visual col 7 here. col = 25.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(25)
    ctrl.stop()
  })

  it("a horizontal move between vertical moves invalidates the sticky col", () => {
    const { ctrl, stdin } = makeWrap()
    ctrl.start()
    stdin.send("0123456789".repeat(3)) // logical 0: 30 chars, 2 visual rows
    stdin.send("\x1b\r")
    stdin.send("ABCDE") // logical 1: 5 chars
    stdin.send("\x1b\r")
    stdin.send("0123456789".repeat(3)) // logical 2: 30 chars
    // Cursor at end of line 2 (col 30, visual col 12 on row 1 of 2).
    // Up → line 2 row 0 visual col 12 = char 12 (prompt is 2, visual 12 → char 10? wait line 2 has continuationPromptW=2 on row 0 because it's a non-first LOGICAL row but the FIRST visual row of that logical line. Yes promptW=2 for row 0 of logical lines >0.)
    // So target visual col 12 on logical 2 row 0 → char = 12-2 = 10.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().col).toBe(10)
    // Move left a few times — invalidates sticky.
    stdin.send("\x1b[D")
    stdin.send("\x1b[D")
    stdin.send("\x1b[D")
    expect(ctrl.buffer().col).toBe(7)
    // Up: should re-sample current visual col (=9 since col 7 + promptW 2 = 9),
    // NOT use the old sticky 12. From logical 2 row 0 → logical 1 (5 chars).
    // visual col 9 is past end → clamp to col 5.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(1)
    expect(ctrl.buffer().col).toBe(5)
    ctrl.stop()
  })

  it("falls back to logical moveUp/moveDown when terminal width is unknown", () => {
    // No columns → non-TTY/test fallback. moveUp/moveDown should still
    // work (jumping by logical line) so cursor navigation remains usable
    // even when wrap layout isn't computable.
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    output.columns = 0 // unknown
    const compositor = new FakeCompositor()
    const ctrl = new EditorController({
      prompt: "> ",
      continuationPrompt: "  ",
      compositor: compositor as any,
      stdin: stdin as any,
      output: output as any,
    })
    ctrl.start()
    stdin.send("L1")
    stdin.send("\x1b\r")
    stdin.send("L2")
    stdin.send("\x1b\r")
    stdin.send("L3")
    expect(ctrl.buffer().row).toBe(2)
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(1)
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(0)
    stdin.send("\x1b[B")
    expect(ctrl.buffer().row).toBe(1)
    ctrl.stop()
  })
})
