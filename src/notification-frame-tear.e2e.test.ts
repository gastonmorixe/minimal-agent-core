/**
 * Regression e2e for the notification-toast frame tear (2026-06-25).
 *
 * The bug: `renderCommandNoticeBlock` added the `│ ` gutter to each body line
 * but never word-wrapped to the terminal width. A body line wider than the
 * terminal reached the terminal's OWN wrap, which produced a continuation row
 * with no `│` gutter, tearing the frame. It was invisible at wide terminals
 * (the content happened to fit) and only showed at narrow widths, which is why
 * unit tests that asserted the renderer's return string (with no width signal)
 * never caught it.
 *
 * The honest test models what the terminal actually SHOWS: render the notice
 * at a known width, feed the bytes through a real terminal emulator
 * ({@link FakeTerminal}) at the SAME width, and assert every visible non-blank
 * row still begins with the frame gutter (`╭` / `│` / `╰`). A gutterless row is
 * a torn frame. We run it at a stress width (40) with stress payloads (a long
 * multi-word line, a single unbreakable token, wide CJK glyphs) AND at a wide
 * width to prove the no-wrap path stays intact too.
 *
 * This is the test that would have caught the original bug.
 *
 * @module notification-frame-tear.e2e.test
 */

import { describe, expect, it } from "bun:test"

import { stripAnsi } from "./term-width.ts"
import { FakeTerminal } from "./test-utils/fake-terminal.ts"
import { renderCommandNoticeBlock } from "./host/ui/command-notice.ts"

/**
 * Feed a rendered notice through a real terminal at `cols`, then assert the
 * frame survived the terminal's own wrapping: every visible non-blank row
 * starts with a frame glyph in the gutter position. A row that starts with raw
 * body content is a gutterless orphan from a terminal-level wrap =\> torn frame.
 */
function assertNoTearOnScreen(rows: string[], cols: number): void {
  const term = new FakeTerminal({ cols, rows: 200 })
  // Each row is a full physical line returning to column 0, so we feed CRLF
  // between rows (what the compositor's positioned output lands as on the
  // terminal). FakeTerminal models raw mode, where a bare "\n" is line-feed
  // only (no carriage return) and would staircase every row, an artifact of
  // the harness, not the renderer.
  term.feed(rows.join("\r\n"))
  const visible = term
    .fullText()
    .split("\n")
    .map((r) => r.replace(/\s+$/, ""))
    .filter((r) => r.length > 0)

  for (const row of visible) {
    const plain = stripAnsi(row)
    // Every visible row of a framed block sits in the gutter: 2 lead spaces
    // then one of ╭ │ ╰. If the terminal wrapped a too-long line, the
    // continuation row would start with raw content here and fail.
    const inGutter = /^ {0,2}[╭│╰]/.test(plain)
    expect({ row: plain, inGutter }).toEqual({ row: plain, inGutter: true })
  }
}

describe("notification toast frame tear (regression)", () => {
  const longLine =
    "Got your test message loud and clear. Two paragraphs as requested, written fresh rather than parroting Cicero back at you. The delivery roundtrip felt instant."
  const unbreakable = `https://example.com/${"segment".repeat(20)}/end`
  const cjk = "你好世界".repeat(12)

  it("survives a long multi-word body line at cols=40", () => {
    const rows = renderCommandNoticeBlock(
      {
        icon: "⇆",
        title: "intercom",
        info: "1 new message",
        color: "magenta",
        body: ["⇆ ◇ 39b09c02 (test-model-x) at 13:44:58", longLine],
      },
      40,
    )
    assertNoTearOnScreen(rows, 40)
  })

  it("survives a single unbreakable token longer than cols", () => {
    const rows = renderCommandNoticeBlock({ title: "intercom", body: [unbreakable] }, 40)
    assertNoTearOnScreen(rows, 40)
  })

  it("survives wide CJK glyphs (display-width, not char-length)", () => {
    const rows = renderCommandNoticeBlock({ title: "intercom", body: [cjk] }, 40)
    assertNoTearOnScreen(rows, 40)
  })

  it("survives a multi-message burst at cols=40", () => {
    const rows = renderCommandNoticeBlock(
      {
        icon: "⇆",
        title: "intercom",
        info: "2 new messages",
        color: "magenta",
        body: [
          "⇆ ◇ aaaa1111 (test-model-x) at 09:00:00",
          longLine,
          "",
          "⇆ ◇ bbbb2222 (test-model-x) at 09:00:05",
          unbreakable,
        ],
      },
      40,
    )
    assertNoTearOnScreen(rows, 40)
  })

  it("stays intact at a wide width too (no-wrap path)", () => {
    // Proves the fix didn't only move the bug: at 120 cols the same content
    // fits without wrapping and the frame is still well-formed.
    const rows = renderCommandNoticeBlock(
      { icon: "⇆", title: "intercom", info: "1 new message", body: [longLine] },
      120,
    )
    assertNoTearOnScreen(rows, 120)
  })
})
