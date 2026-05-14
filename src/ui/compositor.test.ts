import { describe, expect, it } from "bun:test"
import { FakeTerminal } from "../test-utils/fake-terminal.ts"
import { Compositor, updateStreamCol } from "./compositor.ts"

type Capture = {
  writes: string[]
  output: {
    write: (s: string) => boolean
    columns: number
    rows: number
    isTTY: boolean
  }
}

function makeOutput(opts: { isTTY?: boolean } = {}): Capture {
  const writes: string[] = []
  return {
    writes,
    output: {
      columns: 80,
      rows: 24,
      isTTY: opts.isTTY ?? true,
      write(s: string) {
        writes.push(s)
        return true
      },
    },
  }
}

const joined = (cap: Capture) => cap.writes.join("")

function makeTermOutput(term: FakeTerminal) {
  // Wrap a FakeTerminal so Compositor can write into it. FakeTerminal
  // models scrollback the way iTerm does (\x1b[J-erased cells are NOT
  // preserved in history; only naturally-scrolled rows go to scrollback)
  // so it's the right substrate for "resize must not lose scrollback"
  // regression guards.
  return {
    isTTY: true,
    columns: term.cols,
    rows: term.rows,
    // biome-ignore lint/suspicious/noExplicitAny: test-only shape coercion
    write: (s: string) => {
      term.feed(s)
      return true
    },
  } as unknown as Capture["output"]
}

describe("Compositor (non-TTY)", () => {
  it("mount/unmount are no-ops on non-TTY output", () => {
    const cap = makeOutput({ isTTY: false })
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.unmount()
    expect(cap.writes).toEqual([])
  })

  it("writeStream passes through verbatim on non-TTY", () => {
    const cap = makeOutput({ isTTY: false })
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.writeStream("hello\nworld\n")
    expect(joined(cap)).toBe("hello\nworld\n")
  })
})

describe("Compositor (TTY mount/unmount)", () => {
  it("mount hides the cursor; unmount shows it again", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    expect(joined(cap)).toContain("\x1b[?25l")
    cap.writes.length = 0
    c.unmount()
    expect(joined(cap)).toContain("\x1b[?25h")
  })

  it("does NOT use DECSTBM scroll regions (so scrollback is preserved)", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    c.writeStream("hello\n")
    c.unmount()
    const out = joined(cap)
    // No DECSTBM set/reset must ever be emitted.
    expect(out).not.toMatch(/\x1b\[\d+;\d+r/)
    expect(out).not.toBe("\x1b[r")
  })

  it("double mount/unmount are idempotent", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    const len = cap.writes.length
    c.mount()
    expect(cap.writes.length).toBe(len)
    c.unmount()
    const len2 = cap.writes.length
    c.unmount()
    expect(cap.writes.length).toBe(len2)
  })
})

describe("Compositor (setLiveArea)", () => {
  it("first draw writes the line(s) and clears EOL on each row", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    cap.writes.length = 0
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    const out = joined(cap)
    expect(out).toContain("❯ ")
    expect(out).toContain("\x1b[K")
    // Editor cursor at col 2: \r then \x1b[2C.
    expect(out).toContain("\r")
    expect(out).toContain("\x1b[2C")
    expect(c.liveHeight).toBe(1)
  })

  it("subsequent setLiveArea moves cursor up over the OLD live area and erases it", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["status", "❯ "], { row: 1, col: 2 })
    cap.writes.length = 0
    c.setLiveArea(["❯ x"], { row: 0, col: 3 })
    const out = joined(cap)
    // Cursor was on row 1 of live area (relative). To erase:
    //   - move up 1 (\x1b[1A), \r, \x1b[J
    expect(out).toContain("\x1b[1A")
    expect(out).toContain("\x1b[J")
    expect(out).toContain("❯ x")
    expect(c.liveHeight).toBe(1)
  })

  it("renders multiline live area with \\r\\n between rows and clears each EOL", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    cap.writes.length = 0
    c.setLiveArea(["a", "b", "c"], { row: 2, col: 1 })
    const out = joined(cap)
    expect(out).toContain("a\x1b[K\r\nb\x1b[K\r\nc\x1b[K")
    // No upward movement needed: cursor target is the last row.
    expect(c.liveHeight).toBe(3)
  })

  it("keystroke redraw keeps the prompt on the same row after a trailing newline stream", () => {
    const term = new FakeTerminal({ cols: 80, rows: 12, scrollbackLimit: 20 })
    const c = new Compositor({
      output: {
        isTTY: true,
        columns: term.cols,
        rows: term.rows,
        write: (s: string) => {
          term.feed(s)
          return true
        },
      },
    })
    c.mount()
    c.writeStream("  error API 429\n")
    c.setLiveArea(["❯ ", "", "-"], { row: 0, col: 2 })
    const promptRowBefore = term.screen().findIndex((line) => line.includes("❯"))
    expect(promptRowBefore).toBeGreaterThanOrEqual(0)

    c.setLiveArea(["❯ h", "", "-"], { row: 0, col: 3 })
    const promptRowAfter = term.screen().findIndex((line) => line.includes("❯ h"))
    expect(promptRowAfter).toBe(promptRowBefore)
  })

  it("skips byte-identical live-area redraws", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    cap.writes.length = 0

    c.setLiveArea(["❯ "], { row: 0, col: 2 })

    expect(cap.writes).toEqual([])
  })
})

describe("Compositor (writeStream — scrollback-friendly)", () => {
  it("writes the chunk verbatim and re-draws the live area below it", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    cap.writes.length = 0
    c.writeStream("hello\n")
    const out = joined(cap)
    expect(out).toContain("hello\n")
    // Live area redrawn after.
    expect(out).toContain("❯ ")
    expect(out).toContain("\x1b[K")
  })

  it("erases the previous live area before writing the chunk (line-aligned chunk)", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["status", "❯ "], { row: 1, col: 2 })
    cap.writes.length = 0
    c.writeStream("hello\n")
    const out = joined(cap)
    // Move cursor up over the live area top, erase to end of screen.
    expect(out).toContain("\x1b[1A")
    expect(out).toContain("\x1b[J")
    // Then chunk goes into the natural scroll-back stream.
    expect(out).toContain("hello\n")
  })

  it("appends consecutive non-newline chunks on the same stream line", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    c.writeStream("hello")
    cap.writes.length = 0
    c.writeStream(" world")
    const out = joined(cap)
    // To redraw, we erased the live area. The previous chunk ended mid-line
    // ("hello", streamCol=5). drawLiveSeq emitted TWO `\r\n`s above the live
    // area: one forced (mid-line → fresh row), one smart-skip separator
    // (1 blank row of breathing room above the live area). So eraseLiveSeq
    // steps back 2 rows and forward to col 5 to land back at end-of-"hello".
    expect(out).toContain("\x1b[2A")
    expect(out).toContain("\x1b[5C")
    // Then the new chunk writes " world" continuing the same line.
    expect(out).toContain(" world")
  })

  it("ignores empty chunks", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], null)
    cap.writes.length = 0
    c.writeStream("")
    expect(cap.writes).toEqual([])
  })

  it("does not inject redraw bytes into a split ANSI escape", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    cap.writes.length = 0

    c.writeStream("\x1b[31")
    expect(cap.writes).toEqual([])

    c.writeStream("mred\x1b[0m\n")
    const out = joined(cap)
    expect(out).toContain("\x1b[31mred\x1b[0m\n")
    expect(out).not.toContain("\x1b[31\x1b")
  })

  it("caps consecutive blank lines: at most TWO blank rows between writes", () => {
    // Repro for the "4+ blank lines in scrollback" bug. When the model
    // emits a whitespace-only text block (e.g. "\n\n") between two tool
    // calls, the per-turn sink writes a transcript→text separator `\n`
    // followed by the chunk's `\n\n`, which on top of the prior tool's
    // trailing `\n` and the next tool header's leading `\n` would pile
    // up to 4+ consecutive `\n` (3+ blank rows). The compositor caps any
    // run of `\n` in scrollback to 3, so at most TWO blank rows appear.
    // Cap was bumped from 2 to 3 in May 2026 to support the "2 blanks
    // at turn end" rule (`EditorController.submit` writes `\n\n\n` lead).
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    cap.writes.length = 0
    // Simulate the buggy sequence: tool A close, separator, whitespace
    // text block, next tool header.
    c.writeStream("  ╰ done\n")
    c.writeStream("\n") // baseSink separator (transcript→text)
    c.writeStream("\n\n") // model's "\n\n" text content
    c.writeStream("\n  ╭ Read /tmp/foo\n") // next transcript header
    const out = joined(cap)
    // Strip ANSI to inspect content.
    const stripAnsi = (s: string) =>
      s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
    const plain = stripAnsi(out)
    // Find content between "╰ done" and "╭ Read".
    const between = plain.slice(plain.indexOf("╰ done") + "╰ done".length, plain.indexOf("╭ Read"))
    // Count `\n` runs: the longest run must be 2 (= one blank row), never 3+.
    const longestRun = between.split("").reduce(
      (acc: { max: number; cur: number }, ch: string) => {
        if (ch === "\n") {
          acc.cur++
          if (acc.cur > acc.max) acc.max = acc.cur
        } else acc.cur = 0
        return acc
      },
      { max: 0, cur: 0 },
    ).max
    expect(longestRun).toBeLessThanOrEqual(3)
  })

  it("does not strip newlines inside ANSI escape sequences when capping", () => {
    // Sanity: ANSI codes must pass through untouched and they should be
    // treated as zero-width — they neither extend nor reset the
    // consecutive-newline run.
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], null)
    cap.writes.length = 0
    c.writeStream("\n\n\x1b[31m\n\x1b[0m") // 3 newlines with ANSI between #2 and #3
    const stripAnsi = (s: string) =>
      s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "")
    const plain = stripAnsi(joined(cap))
    // ANSI redraw bytes around the chunk are stripped; the scrollback
    // payload should contain all 3 consecutive `\n` from this write
    // (cap=3 since May 2026, was cap=2). ANSI codes don't extend the run.
    const longestRun = plain.split("").reduce(
      (acc: { max: number; cur: number }, ch: string) => {
        if (ch === "\n") {
          acc.cur++
          if (acc.cur > acc.max) acc.max = acc.cur
        } else acc.cur = 0
        return acc
      },
      { max: 0, cur: 0 },
    ).max
    expect(longestRun).toBe(3)
    // ANSI codes still made it through.
    expect(joined(cap)).toContain("\x1b[31m")
    expect(joined(cap)).toContain("\x1b[0m")
  })

  it("flushStream drains a dangling ANSI tail before shutdown", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    cap.writes.length = 0

    c.writeStream("\x1b[31")
    c.flushStream()

    expect(joined(cap)).toContain("\x1b[31")
  })
})

describe("Compositor (withSuspendedLiveArea)", () => {
  it("erases the live area for the duration of the callback and restores it after", async () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["status", "❯ "], { row: 1, col: 2 })
    cap.writes.length = 0

    let captured = ""
    await c.withSuspendedLiveArea(async () => {
      captured = joined(cap)
      cap.writes.length = 0
    })
    // While suspended: live area was erased, cursor shown.
    expect(captured).toContain("\x1b[J")
    expect(captured).toContain("\x1b[?25h")
    // After: live area redrawn (status + prompt).
    const after = joined(cap)
    expect(after).toContain("status")
    expect(after).toContain("❯ ")
  })

  it("restores the live area even if the callback throws", async () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    cap.writes.length = 0
    await expect(
      c.withSuspendedLiveArea(async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect(joined(cap)).toContain("❯ ")
  })
})

describe("Compositor (DECSET 2026 synchronized output)", () => {
  const BSU = "\x1b[?2026h"
  const ESU = "\x1b[?2026l"

  it("does NOT emit BSU/ESU when syncOutput is disabled (default)", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    c.writeStream("hello\n")
    c.unmount()
    const out = joined(cap)
    expect(out).not.toContain(BSU)
    expect(out).not.toContain(ESU)
  })

  it("brackets each writeStream batch in BSU/ESU when syncOutput is enabled", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output, syncOutput: true })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    cap.writes.length = 0 // ignore mount + initial setLiveArea writes
    c.writeStream("chunk\n")
    const last = cap.writes[cap.writes.length - 1]
    expect(last.startsWith(BSU)).toBe(true)
    expect(last.endsWith(ESU)).toBe(true)
    // The payload between BSU and ESU contains the actual chunk bytes.
    expect(last).toContain("chunk")
    c.unmount()
  })

  it("brackets each setLiveArea redraw in BSU/ESU when syncOutput is enabled", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output, syncOutput: true })
    c.mount()
    cap.writes.length = 0
    c.setLiveArea(["❯ hi"], { row: 0, col: 4 })
    const last = cap.writes[cap.writes.length - 1]
    expect(last.startsWith(BSU)).toBe(true)
    expect(last.endsWith(ESU)).toBe(true)
    expect(last).toContain("❯ hi")
    c.unmount()
  })
})

describe("Compositor (notifyResize)", () => {
  it("scrolls the viewport into scrollback (does NOT wipe with \\x1b[H\\x1b[J)", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["status", "❯ "], { row: 1, col: 2 })
    expect(c.liveHeight).toBe(2)
    cap.writes.length = 0
    c.notifyResize()
    const out = joined(cap)
    // The preserve-scrollback preamble: CUD-clamped-at-bottom + LF×rows
    // pushes every visible row off the top of the viewport, into
    // scrollback. A bare `\x1b[H\x1b[J` would silently drop those rows
    // on iTerm (and several other terminals that don't preserve
    // \x1b[J-erased cells in history) — see regression history in
    // notifyResize() docstring.
    expect(out).toContain(`\x1b[${cap.output.rows}B`)
    expect(out).toContain("\n".repeat(cap.output.rows))
    expect(out).not.toContain("\x1b[H\x1b[J")
    // Counters reset so the next setLiveArea won't issue a stale
    // relative-up sequence (which would land mid-reflow and leave debris).
    expect(c.liveHeight).toBe(0)
  })

  it("preserves visible mutable-area content into scrollback before wiping", () => {
    // Regression for the iTerm "header / Bash tool block / response
    // tail vanishes on terminal resize" bug. Before 5b36689 (and again
    // after 86d2d3b accidentally reverted it), notifyResize() emitted a
    // bare \x1b[H\x1b[J — which iTerm drops from history. This test
    // drives a real Compositor through FakeTerminal (which matches
    // iTerm's \x1b[J-drops-from-scrollback semantics) and asserts that
    // every stream line written before notifyResize() is reachable
    // somewhere post-resize.
    const term = new FakeTerminal({ cols: 40, rows: 8, scrollbackLimit: 200 })
    const c = new Compositor({ output: makeTermOutput(term) })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    // Stream 14 lines into the compositor. The first ~6 will scroll
    // naturally into scrollback as the viewport fills; the last 8 sit
    // on the visible viewport when the resize fires.
    for (let i = 1; i <= 14; i++) c.writeStream(`line-${i}\n`)
    // Sanity: scrollback so far has the early lines but NOT the last
    // ones (they're still in the visible viewport when the resize hits).
    expect(term.scrollback.join("\n")).toContain("line-1")
    expect(term.scrollback.join("\n")).not.toContain("line-14")
    // Now resize.
    c.notifyResize()
    // After the fix, every payload line must be reachable somewhere —
    // either still in scrollback (where most belong) or in the visible
    // screen if the terminal preserved any. Pre-fix this assertion failed
    // for line-9 through line-14 (the visible-viewport tail at resize).
    const all = [...term.scrollback, ...term.screen()].join("\n")
    for (let i = 1; i <= 14; i++) {
      expect(all).toContain(`line-${i}`)
    }
  })

  it("preserves a viewport-full of stream content into scrollback (mid-stream resize)", () => {
    // Mid-stream resize: assistant is in the middle of emitting a long
    // markdown response, the user resizes. The most recent ~viewport-
    // rows of stream content sit on the visible viewport at the moment
    // notifyResize() fires. After the fix, they survive in scrollback
    // so the user can scroll up to read.
    const term = new FakeTerminal({ cols: 60, rows: 20, scrollbackLimit: 500 })
    const c = new Compositor({ output: makeTermOutput(term) })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    // 50 unique payload rows so we can verify each one survives.
    for (let i = 1; i <= 50; i++) c.writeStream(`payload-row-${i}\n`)
    c.notifyResize()
    const all = [...term.scrollback, ...term.screen()].join("\n")
    for (let i = 1; i <= 50; i++) {
      expect(all).toContain(`payload-row-${i}`)
    }
  })

  it("positions cursor so the next live-area paint lands at the viewport bottom (sticky prompt)", () => {
    // Without the cursor-up-by-oldHeight repositioning, the next
    // drawLiveSeq paint after notifyResize would land at row 0 — the
    // "prompt jumped to the top of the viewport" UX bug the user
    // reported. With the fix, drawLiveSeq lands the last live-area row
    // (the prompt) at the viewport bottom (row `rows-1`).
    const term = new FakeTerminal({ cols: 40, rows: 10, scrollbackLimit: 200 })
    const c = new Compositor({ output: makeTermOutput(term) })
    c.mount()
    c.setLiveArea(["status", "", "❯ hi"], { row: 2, col: 4 })
    expect(c.liveHeight).toBe(3)
    c.notifyResize()
    // Editor.notifyResize() repaints with the same lines (under the new
    // width — same here since FakeTerminal didn't actually resize).
    c.setLiveArea(["status", "", "❯ hi"], { row: 2, col: 4 })
    // After the paint, the LAST live-area row ("❯ hi") must sit on the
    // bottom row of the viewport, and the screen above must be blank
    // (no transcript content in the visible viewport — it's in
    // scrollback).
    const screen = term.screen()
    expect(screen[screen.length - 1]).toContain("❯ hi")
    expect(screen[screen.length - 2]).toBe("")
    expect(screen[screen.length - 3]).toContain("status")
  })

  it("the next setLiveArea after a resize emits no \\x1b[nA up-moves (clean repaint)", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["status", "❯ "], { row: 1, col: 2 })
    c.notifyResize()
    cap.writes.length = 0
    c.setLiveArea(["status", "❯ "], { row: 1, col: 2 })
    const out = joined(cap)
    // No relative up-moves should appear in this paint — the resize
    // preserved scrollback and pre-positioned the cursor, so the live
    // area redraws straight from the cursor without trying to step over
    // a stale OLD live area.
    expect(out).not.toMatch(/\x1b\[\d*A/)
    // It DID draw the new content.
    expect(out).toContain("status")
    expect(out).toContain("❯ ")
  })

  it("is a no-op on non-TTY", () => {
    const cap = makeOutput({ isTTY: false })
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.notifyResize()
    expect(cap.writes).toEqual([])
  })

  it("is a no-op when not mounted", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    // No mount() — should be silent.
    c.notifyResize()
    expect(cap.writes).toEqual([])
  })

  it("wraps the recovery sequence in BSU/ESU when synchronized output is enabled", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output, syncOutput: true })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    cap.writes.length = 0
    c.notifyResize()
    const out = joined(cap)
    // BSU then ESU around the preserve-scroll preamble, atomic on
    // supporting terminals so the user never sees a half-applied
    // resize recovery.
    const bsu = "\x1b[?2026h"
    const esu = "\x1b[?2026l"
    expect(out.indexOf(bsu)).toBeGreaterThanOrEqual(0)
    expect(out.indexOf(esu)).toBeGreaterThan(out.indexOf(bsu))
    expect(out).toContain(`\x1b[${cap.output.rows}B`)
  })
})

describe("Compositor (cols-drift recovery)", () => {
  it("setLiveArea after a silent cols change preserves viewport into scrollback before redraw", () => {
    // Reproduces the bug observed in user session 9d832ab0-…:
    //   process.stdout.columns oscillated between 131 and 127 mid-session
    //   without a SIGWINCH-driven notifyResize(). The compositor's
    //   `cursorRowInLive` was measured under the old width, so the next
    //   eraseLiveSeq's `\x1b[<n>A` undershot (content emitted under the
    //   old width may have wrapped under the new width). The stale top
    //   of the live area then scrolled into scrollback on every repaint,
    //   producing dozens of duplicate "ASK ❯ ─── ^ N more lines" rows.
    const cap = makeOutput()
    cap.output.columns = 131
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ hello"], { row: 0, col: 7 })
    expect(c.liveHeight).toBe(1)
    cap.writes.length = 0
    // Terminal got narrower without our SIGWINCH path firing.
    cap.output.columns = 127
    c.setLiveArea(["❯ hello"], { row: 0, col: 7 })
    const out = joined(cap)
    // The preserve-scroll preamble (\x1b[<rows>B + LF×rows) MUST appear
    // before the redraw — otherwise iTerm drops the prior content from
    // scrollback (and any stale wrapped content above the live area
    // would scroll into scrollback on the next write anyway).
    const preambleIdx = out.indexOf(`\x1b[${cap.output.rows}B`)
    expect(preambleIdx).toBeGreaterThanOrEqual(0)
    // A bare \x1b[H\x1b[J wipe must NOT appear — that's the regression.
    expect(out).not.toContain("\x1b[H\x1b[J")
    expect(out).toContain("❯ hello")
  })

  it("setLiveArea is a no-op (no extra wipe) when cols hasn't changed", () => {
    const cap = makeOutput()
    cap.output.columns = 127
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ a"], { row: 0, col: 3 })
    cap.writes.length = 0
    c.setLiveArea(["❯ b"], { row: 0, col: 3 })
    const out = joined(cap)
    // No full wipe — this is the steady-state repaint path.
    expect(out).not.toContain("\x1b[H\x1b[J")
    expect(out).toContain("❯ b")
  })

  it("setLiveArea repaint does NOT walk right by streamCol (spinner blink stays at col 0)", () => {
    // Regression for the "horizontally accumulating Thinking labels" bug:
    // after streaming content leaves streamCol > 0, a pure live-area
    // repaint (spinner tick) used to also emit `\x1b[<streamCol>C` before
    // the `\x1b[J` erase, landing the new status at col streamCol of the
    // status row instead of col 0. Each blink left the previous label
    // visible at cols 0..streamCol-1, producing
    // `● Thinking   Thinking   ● Thinking …` accumulating across the row
    // as streamCol grew with the response. The walk-right step is part
    // of "land back at the original scrollback cursor" and only makes
    // sense in tandem with the walk-up over separator rows — pure
    // live-area repaints must stay at col 0 of the live area's top row.
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["● Thinking", "", "❯ ask"], { row: 2, col: 5 })
    c.writeStream("hello world") // streamCol grows to 11
    cap.writes.length = 0
    c.setLiveArea(["  Thinking", "", "❯ ask"], { row: 2, col: 5 })
    const out = joined(cap)
    // The cursor walk-right used for "land back at scrollback streamCol"
    // must NOT appear in the repaint path. The only walk-right allowed
    // is the editor cursor's `\x1b[5C` (col 5, end of "❯ ask").
    expect(out).not.toContain("\x1b[11C")
    expect(out).toContain("\x1b[5C")
    expect(out).toContain("  Thinking")
  })

  it("writeStream after a silent cols change preserves viewport before appending", () => {
    // Same failure mode at the scrollback seam: a chunk written while
    // the stale live area is still on screen would push the wrapped-but-
    // uncounted top rows into permanent scrollback. The recovery must
    // preserve viewport into scrollback (NOT bare-wipe) so the in-flight
    // stream content above doesn't vanish.
    const cap = makeOutput()
    cap.output.columns = 131
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ hello"], { row: 0, col: 7 })
    cap.writes.length = 0
    cap.output.columns = 80
    c.writeStream("response chunk\n")
    const out = joined(cap)
    expect(out).toContain(`\x1b[${cap.output.rows}B`)
    expect(out).not.toContain("\x1b[H\x1b[J")
    expect(out).toContain("response chunk")
  })

  it("first-ever paint does NOT trip the recovery (no baseline to compare)", () => {
    const cap = makeOutput()
    cap.output.columns = 100
    const c = new Compositor({ output: cap.output })
    c.mount()
    cap.writes.length = 0
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    const out = joined(cap)
    // No prior draw → nothing to recover from.
    expect(out).not.toContain("\x1b[H\x1b[J")
    expect(out).toContain("❯ ")
  })
})

describe("updateStreamCol", () => {
  it("advances col by visible width when chunk has no newline", () => {
    expect(updateStreamCol("hello", 0)).toBe(5)
    expect(updateStreamCol("world", 5)).toBe(10)
  })
  it("resets to 0 then counts trailing-line chars after a newline", () => {
    expect(updateStreamCol("hello\n", 0)).toBe(0)
    expect(updateStreamCol("hello\nwo", 0)).toBe(2)
    expect(updateStreamCol("a\nb\nc", 0)).toBe(1)
  })
  it("ignores ANSI escapes when measuring", () => {
    expect(updateStreamCol("\x1b[31mhi\x1b[0m", 0)).toBe(2)
  })
})
