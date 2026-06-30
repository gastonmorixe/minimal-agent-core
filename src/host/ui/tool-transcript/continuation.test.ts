/**
 * Bash continuation rendering — multi-operator soft-split at wide columns
 * and `toolContinuationIndentCells` alignment. Split out of
 * `agent-tool-render.test.ts` (oxlint max-lines).
 */

import { describe, expect, it } from "bun:test"

import type { ToolUseBlock } from "../../../client/types.ts"
import { displayWidth } from "../../../term-width.ts"

import {
  formatToolInput,
  formatToolInputContinuation,
  toolContinuationIndentCells,
} from "./format.ts"

function tu(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: "tool_use", id: "test", name, input } as ToolUseBlock
}

// ---------------------------------------------------------------------------
// Regression coverage: 2+ operator pipelines split at WIDE terminals
//
// User report (May 2026): two real-world commands rendered without any
// `↳` rows because they fit horizontally in a typical 130–160 cell
// iTerm window, even though both have 2+ top-level operators that the
// user wants to read row-by-row. Width-only predicate left them unsplit.
// New rule: 2+ operators ⇒ soft-split regardless of overflow.
// ---------------------------------------------------------------------------

describe("formatToolInput / formatToolInputContinuation — 2+ operator split at wide cols", () => {
  const userCmd1 =
    "cd /Users/gaston/Projects/inditex/work/inditex-supplier-management && cat Makefile 2>/dev/null | head -80"
  const userCmd2 =
    "cd /Users/gaston/Projects/inditex/work/inditex-supplier-management/api && npm run lint 2>&1 | tail -120"

  // Span a few realistic terminal widths. All three must split because
  // both commands have 2 top-level operators (&&, |) — the multi-op
  // rule fires regardless of width.
  for (const cols of [120, 140, 160, 200]) {
    it(`user-reported cmd #1 splits at cols=${cols} (2+ operators)`, () => {
      expect(formatToolInput(tu("Bash", { command: userCmd1 }), cols)).toBe(
        "$ cd /Users/gaston/Projects/inditex/work/inditex-supplier-management",
      )
      expect(formatToolInputContinuation(tu("Bash", { command: userCmd1 }), cols)).toEqual([
        "↳ && cat Makefile 2>/dev/null",
        "↳ | head -80",
      ])
    })

    it(`user-reported cmd #2 splits at cols=${cols} (2+ operators)`, () => {
      expect(formatToolInput(tu("Bash", { command: userCmd2 }), cols)).toBe(
        "$ cd /Users/gaston/Projects/inditex/work/inditex-supplier-management/api",
      )
      expect(formatToolInputContinuation(tu("Bash", { command: userCmd2 }), cols)).toEqual([
        "↳ && npm run lint 2>&1",
        "↳ | tail -120",
      ])
    })
  }

  it("single-operator pipelines still stay inline at wide cols (no over-splitting)", () => {
    // `ls | wc -l` is short and trivially scannable; splitting would be
    // visual noise. Multi-op rule requires 2+ operators, so 1-op stays inline.
    expect(formatToolInput(tu("Bash", { command: "ls | wc -l" }), 200)).toBe("$ ls | wc -l")
    expect(formatToolInputContinuation(tu("Bash", { command: "ls | wc -l" }), 200)).toEqual([])
  })

  it("non-TTY callers (no cols, no TTY) still get single-line headers — multi-op rule gated on finite cols", () => {
    // Mirrors `bun test`-style invocations where stdout isn't a TTY and
    // process.stdout.columns is undefined → effectiveCols becomes Infinity.
    // Multi-op rule must NOT fire here; otherwise piped/test output of
    // 2+ op commands changes shape. Existing tests at line ~674/720
    // depend on this.
    expect(formatToolInput(tu("Bash", { command: "a && b | c" }))).toBe("$ a && b | c")
    expect(formatToolInputContinuation(tu("Bash", { command: "a && b | c" }))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// toolContinuationIndentCells — alignment under command body
// ---------------------------------------------------------------------------

describe("toolContinuationIndentCells — Bash continuation alignment", () => {
  it("aligns ↳/> under the command body when icon is present (live agent)", () => {
    // Live agent header: `  ╭ » Bash  $ cd …`
    //   - "  ╭ "  = 4 cells (frame, not counted)
    //   - "» "    = 2 cells (icon + trailing space)
    //   - "Bash"  = 4 cells
    //   - "  "    = 2 cells (label→content gap)
    //   - "$ "    = 2 cells (Bash sigil from formatToolInput)
    //   = 10 cells past the frame → continuation rows need 10 spaces
    //   of indent after `  │ ` for `↳`/`>` to land at col 14 (under
    //   the `c` of `cd …`).
    expect(toolContinuationIndentCells("Bash", "»")).toBe(10)
  })

  it("aligns ↳/> under the command body when no icon is present (session replay)", () => {
    // Replay header: `  ╭ Bash  $ cd …` (no icon)
    //   - "Bash"  = 4 cells
    //   - "  "    = 2 cells (gap)
    //   - "$ "    = 2 cells
    //   = 8 cells past the frame
    expect(toolContinuationIndentCells("Bash")).toBe(8)
  })

  it("returns 0 for non-Bash tools (no continuation rows there today)", () => {
    expect(toolContinuationIndentCells("Read", "★")).toBe(0)
    expect(toolContinuationIndentCells("Grep")).toBe(0)
    expect(toolContinuationIndentCells("Glob", "*")).toBe(0)
    expect(toolContinuationIndentCells("Edit")).toBe(0)
    expect(toolContinuationIndentCells("Write")).toBe(0)
  })

  it("scales the icon width via displayWidth (wide icons add an extra cell)", () => {
    // If a future Bash icon were 2 cells wide (e.g. a CJK glyph), the
    // indent must absorb that extra cell so the alignment stays under
    // the command body. NOTE: PUA codepoints like Nerd Font glyphs are
    // intentionally treated as 1 cell by `displayWidth` because PUA cell
    // width depends on the active font (see term-width.ts comment) — so
    // we exercise the wide-glyph path here with a real East-Asian Wide
    // codepoint instead.
    const wideIcon = "中" // U+4E2D, 2 cells per UAX #11
    expect(displayWidth(wideIcon)).toBe(2)
    // 2 (wide icon) + 1 (trailing space) + 4 (Bash) + 2 (gap) + 2 ($ ) = 11
    expect(toolContinuationIndentCells("Bash", wideIcon)).toBe(11)
  })
})
