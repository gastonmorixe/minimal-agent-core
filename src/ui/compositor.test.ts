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
  it("emits NOTHING — no clears, no \\r\\n, no cursor moves", () => {
    // HARD RULE locked in May 14 2026 after a long bug-fix loop (sessions
    // b50c7354, fc196c6e). Three failure modes were ruled out:
    //   (a) `\x1b[H\x1b[J` — destroys ~20 rows of scrollback on iTerm
    //       every resize (iTerm drops `\x1b[J` cells from history).
    //   (b) `\r\n` + reset counters — pushes old live area into
    //       scrollback as a ghost row PER resize / drift event; under
    //       cols oscillation (8fps spinner ticks + flapping
    //       process.stdout.columns) this stacks 6+ `❯` rows.
    //   (c) Resetting counters without emit — drops walk-up math, next
    //       draw starts at current cursor (end of editor row),
    //       overstrikes old `❯` → "❯ ❯".
    // The fix: emit NOTHING on resize, KEEP the counters. The next
    // `setLiveArea` (which `editor.notifyResize()` triggers synchronously)
    // runs the normal `eraseLiveSeq` walk-up + `drawLiveSeq` per-row
    // `\x1b[K` overwrite, covering the old live area in place. Counters
    // may be ±1 row stale under cols-change reflow; that residue is
    // bounded and self-heals on the next paint.
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["status", "❯ "], { row: 1, col: 2 })
    expect(c.liveHeight).toBe(2)
    cap.writes.length = 0
    c.notifyResize()
    const out = joined(cap)
    expect(out).toBe("")
    // Counters preserved (they are our best estimate of the live area
    // location post-reflow; the next paint uses them for the walk-up).
    expect(c.liveHeight).toBe(2)
  })

  it("preserves all pre-resize scrollback byte-for-byte (the iTerm-destroys-history bug)", () => {
    // FakeTerminal mirrors iTerm semantics: `\x1b[J`-erased cells are
    // dropped from history. Stream lines must survive every resize.
    // (Use \r\n so FakeTerminal treats LF as a true line break with CR.)
    const term = new FakeTerminal({ cols: 60, rows: 12, scrollbackLimit: 200 })
    const c = new Compositor({ output: makeTermOutput(term) })
    c.mount()
    for (let i = 1; i <= 15; i++) c.writeStream(`STREAM_LINE_${i}\r\n`)
    c.setLiveArea(["STATUS_FOO", "", "❯ DISTINCT_PROMPT"], { row: 2, col: 18 })
    c.notifyResize()
    c.setLiveArea(["STATUS_FOO", "", "❯ DISTINCT_PROMPT"], { row: 2, col: 18 })
    c.notifyResize()
    c.setLiveArea(["STATUS_FOO", "", "❯ DISTINCT_PROMPT"], { row: 2, col: 18 })
    c.notifyResize()
    c.setLiveArea(["STATUS_FOO", "", "❯ DISTINCT_PROMPT"], { row: 2, col: 18 })
    // Strip all whitespace to be robust against terminal wrap quirks.
    const all = (term.scrollback.join("\n") + "\n" + term.screen().join("\n")).replace(/\s+/g, "")
    for (let i = 1; i <= 15; i++) {
      expect(all).toContain(`STREAM_LINE_${i}`)
    }
  })

  it("does NOT accumulate stacked ghost editor rows across many resizes", () => {
    // Regression for the 6-stacked-`❯` bug (user-reported May 14 2026,
    // session fc196c6e): when notifyResize emitted `\r\n`, every drift
    // event pushed one editor row into scrollback. With the no-emit
    // invariant on notifyResize/maybeRecoverFromColsDrift, scrollback
    // growth is bounded by stream content only — the live area is
    // redrawn IN PLACE on the next setLiveArea via eraseLiveSeq's
    // walk-up + `\x1b[J` (which only erases owned cells).
    const term = new FakeTerminal({ cols: 80, rows: 10, scrollbackLimit: 500 })
    const c = new Compositor({ output: makeTermOutput(term) })
    c.mount()
    c.writeStream("PRE_RESIZE_CONTENT_X\n")
    c.setLiveArea(["", "❯ DISTINCT"], { row: 1, col: 10 })
    // 10 simulated resize+repaint cycles.
    for (let i = 0; i < 10; i++) {
      c.notifyResize()
      c.setLiveArea(["", "❯ DISTINCT"], { row: 1, col: 10 })
    }
    const scrollbackText = term.scrollback.join("\n")
    // DISTINCT must never appear in scrollback — it's the current live
    // area, lives in `screen` only.
    const distinctOccurrencesInScrollback = scrollbackText.split("DISTINCT").length - 1
    expect(distinctOccurrencesInScrollback).toBe(0)
  })

  it("the next setLiveArea after a resize redraws the live area in place", () => {
    const cap = makeOutput()
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["status", "❯ "], { row: 1, col: 2 })
    c.notifyResize()
    cap.writes.length = 0
    // Different content so the drawnLiveKey dedup doesn't short-circuit.
    c.setLiveArea(["status changed", "❯ x"], { row: 1, col: 3 })
    const out = joined(cap)
    expect(out).toContain("status changed")
    expect(out).toContain("❯ x")
    // No \x1b[H (cursor-home) on resize-driven repaints. \x1b[J is
    // OK here — it's eraseLiveSeq's owned-region erase, which is the
    // load-bearing in-place clear.
    expect(out).not.toContain("\x1b[H\x1b[J")
    expect(out).not.toContain("\x1b[2J")
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
    c.notifyResize()
    expect(cap.writes).toEqual([])
  })
})

describe("Compositor (cols-drift recovery)", () => {
  it("setLiveArea after a silent cols change does NOT emit \\x1b[H or \\x1b[H\\x1b[J", () => {
    // Cols-drift recovery is a true no-op (no \r\n, no \x1b[J, no
    // \x1b[H). The subsequent eraseLiveSeq+drawLiveSeq path runs as
    // usual; eraseLiveSeq's \x1b[J is fine because the walk-up keeps
    // the cursor inside our owned region.
    const cap = makeOutput()
    cap.output.columns = 131
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ hello"], { row: 0, col: 7 })
    expect(c.liveHeight).toBe(1)
    cap.writes.length = 0
    cap.output.columns = 127
    c.setLiveArea(["❯ hello"], { row: 0, col: 7 })
    const out = joined(cap)
    // Cursor-home never appears.
    expect(out).not.toContain("\x1b[H")
    expect(out).not.toContain("\x1b[2J")
    expect(out).toContain("❯ hello")
  })

  it("setLiveArea steady-state repaint emits eraseLiveSeq's \\x1b[J (in-place erase)", () => {
    const cap = makeOutput()
    cap.output.columns = 127
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ a"], { row: 0, col: 3 })
    cap.writes.length = 0
    c.setLiveArea(["❯ b"], { row: 0, col: 3 })
    const out = joined(cap)
    // No cursor-home (HARD RULE).
    expect(out).not.toContain("\x1b[H")
    expect(out).not.toContain("\x1b[2J")
    // The in-place erase IS allowed (cursor is in our owned region).
    expect(out).toContain("\x1b[J")
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

  it("writeStream after a silent cols change does NOT emit \\x1b[H", () => {
    const cap = makeOutput()
    cap.output.columns = 131
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ hello"], { row: 0, col: 7 })
    cap.writes.length = 0
    cap.output.columns = 80
    c.writeStream("response chunk\n")
    const out = joined(cap)
    expect(out).not.toContain("\x1b[H")
    expect(out).not.toContain("\x1b[2J")
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
    // No prior draw → nothing to recover from. No clear sequences ever.
    expect(out).not.toContain("\x1b[H\x1b[J")
    expect(out).not.toContain("\x1b[J")
    expect(out).not.toContain("\x1b[H")
    expect(out).toContain("❯ ")
  })
})

describe("Compositor (HARD RULE: never touch scrollback on resize)", () => {
  // Pinned May 14 2026 after sessions b50c7354 / fc196c6e. The HARD
  // RULE applies to `notifyResize` and `maybeRecoverFromColsDrift`:
  // those handlers must NEVER emit `\x1b[H` (cursor home), `\x1b[J`
  // (erase-to-end-of-screen), `\x1b[2J` (erase-whole-screen), or even
  // bare `\r\n`. Reasoning:
  //   - `\x1b[H\x1b[J` destroys ~20 rows of scrollback on iTerm every
  //     resize because iTerm drops erased cells from history.
  //   - `\r\n` + reset counters pushes the old live area into
  //     scrollback as a ghost row, accumulating under cols flapping
  //     into 6+ stacked editor rows.
  //   - Resetting counters drops walk-up math, causing the next draw
  //     to overstrike the old editor (`❯ ❯` bug).
  // The fix: handlers are TRUE no-ops. The subsequent setLiveArea
  // uses the still-near-accurate counters for its eraseLiveSeq
  // walk-up + `\x1b[J` (safe because cursor is in our owned region).
  // The `\x1b[J` in eraseLiveSeq is NOT covered by the HARD RULE
  // because the walk-up keeps the cursor inside our owned territory.
  it("scrollback survives 5 sequential resizes byte-for-byte", () => {
    const term = new FakeTerminal({ cols: 80, rows: 10, scrollbackLimit: 500 })
    const c = new Compositor({ output: makeTermOutput(term) })
    c.mount()
    const markers: string[] = []
    for (let i = 1; i <= 20; i++) {
      const m = `HISTORY_${i}_xyz`
      markers.push(m)
      c.writeStream(`${m}\r\n`)
    }
    c.setLiveArea(["STATUS", "❯ typed"], { row: 1, col: 8 })
    for (let i = 0; i < 5; i++) {
      c.notifyResize()
      c.setLiveArea(["STATUS", "❯ typed"], { row: 1, col: 8 })
    }
    // Whitespace-strip to be robust against terminal wrap quirks.
    const all = (term.scrollback.join("\n") + "\n" + term.screen().join("\n")).replace(/\s+/g, "")
    for (const m of markers) {
      expect(all).toContain(m)
    }
  })
})

describe("Compositor (eraseLiveSeq wrap-aware walk-up)", () => {
  // Regression for user-reported bug May 21 2026: when the user
  // resized the terminal SMALLER while a status row was showing AND
  // the prompt input had content, every status tick / keystroke
  // committed a duplicate status row to scrollback, piling up many
  // copies over time. Root cause: `eraseLiveSeq`'s walk-up used the
  // LOGICAL `cursorRowInLive` saved at draw time — under a
  // width-shrinking resize, previously-drawn wide lines (e.g. a
  // 60-cell status row) wrap on the terminal side, pushing the
  // cursor's PHYSICAL row down. Walking up the stale logical count
  // landed the cursor inside the reflowed live area, not at its
  // top; `\x1b[J` cleared from there down, and the surviving top
  // rows became orphans that subsequent `writeBufferedStream` calls
  // scrolled into permanent scrollback. The fix re-measures the
  // walk-up in physical rows under current cols using the same
  // wrap math `EditorRenderer` uses.
  //
  // Tests assert on the byte-level CSI walk-up `\x1b[<n>A` because
  // FakeTerminal doesn't model cols-change reflow. A separate tmux
  // smoke driver (tmp/resize-orphan-tmux-driver.ts) exercises the
  // full path end-to-end.
  it("walks up logical rows under stable cols (no wrap, no behavior change)", () => {
    const cap = makeOutput()
    cap.output.columns = 100
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["status row", "", "", "❯ abc"], { row: 3, col: 5 })
    cap.writes.length = 0
    // Force a re-paint with different content (drawnLiveKey dedup
    // would otherwise short-circuit).
    c.setLiveArea(["status row changed", "", "", "❯ abc"], { row: 3, col: 5 })
    const out = joined(cap)
    // All lines fit in cols=100; logical == physical → walk up cursor.row=3.
    expect(out).toContain("\x1b[3A")
    // Sanity: no surprise extra walk-up.
    expect(out).not.toContain("\x1b[4A")
  })

  it("walks up extra rows when previously-drawn lines wrap under new cols", () => {
    const cap = makeOutput()
    cap.output.columns = 100
    const c = new Compositor({ output: cap.output })
    c.mount()
    // ~63-cell status row — fits in cols=100 (1 row), wraps to 2
    // rows under cols=40.
    const wideStatus = "Sending request ↑ 266.1 KB · 181.0 KB/s · api.anthropic.com (1s)"
    c.setLiveArea([wideStatus, "", "", "❯ abc"], { row: 3, col: 5 })
    expect(c.liveHeight).toBe(4)

    // Simulate "user resized to cols=40". On the terminal side the
    // wide status row reflows to 2 physical rows; cursor (which sat
    // at end of editor under cols=100) follows its character and
    // is now at physical row 4 (rows 0–1 are wrapped status, 2 is
    // blank, 3 is blank, 4 is editor).
    cap.output.columns = 40
    cap.writes.length = 0
    // Different content so drawnLiveKey dedup doesn't short-circuit.
    c.setLiveArea(["truncated", "", "", "❯ abc"], { row: 3, col: 5 })
    const out = joined(cap)
    // Walk-up math:
    //   line 0 (wideStatus, ~63 cells): ceil(63/40) = 2 rows.
    //   line 1 (""):  max(1, 0) = 1 row.
    //   line 2 (""):  max(1, 0) = 1 row.
    //   cursor.col = 5 < 40 → +0.
    //   Total physical walk-up: 4 rows.
    expect(out).toContain("\x1b[4A")
    // The stale logical count 3 MUST NOT appear (would leave the
    // top wrap row of the old status as an orphan).
    expect(out).not.toContain("\x1b[3A")
  })

  it("accounts for the cursor's intra-line wrap chunk", () => {
    const cap = makeOutput()
    cap.output.columns = 100
    const c = new Compositor({ output: cap.output })
    c.mount()
    // Editor line wider than the future smaller cols; cursor.col
    // mid-line so wrap chunks sit above the cursor under reflow.
    // The renderer normally pre-wraps editor content, but under
    // cols drift the previously-drawn line may have been wider
    // than the new cols.
    const wideEditor = "❯ " + "x".repeat(98) // 100 cells
    c.setLiveArea(["status", "", "", wideEditor], { row: 3, col: 60 })
    cap.output.columns = 40
    cap.writes.length = 0
    c.setLiveArea(["status", "", "", "❯ shorter"], { row: 3, col: 5 })
    const out = joined(cap)
    // Walk-up math under cols=40 using the PREVIOUS drawn lines:
    //   line 0 ("status", 6 cells): max(1, ceil(6/40)) = 1 row.
    //   line 1 (""):  1 row.
    //   line 2 (""):  1 row.
    //   cursor.col = 60 → floor(60/40) = 1 (cursor sits on the
    //   2nd wrap chunk of its line).
    //   Total physical walk-up: 4 rows.
    expect(out).toContain("\x1b[4A")
  })

  it("does NOT inflate walk-up when cols grew larger than lastDrawColumns", () => {
    const cap = makeOutput()
    cap.output.columns = 40
    const c = new Compositor({ output: cap.output })
    c.mount()
    // Status fits in cols=40 (≤ 40 cells).
    c.setLiveArea(["status row", "", "", "❯ abc"], { row: 3, col: 5 })
    // Cols GROWS to 100. No reflow.
    cap.output.columns = 100
    cap.writes.length = 0
    c.setLiveArea(["status row again", "", "", "❯ abc"], { row: 3, col: 5 })
    const out = joined(cap)
    // Each line still fits in 1 row under cols=100; walk-up stays
    // at logical cursor.row=3.
    expect(out).toContain("\x1b[3A")
    expect(out).not.toContain("\x1b[4A")
  })

  it("ignores ANSI styling when computing the wrap math", () => {
    const cap = makeOutput()
    cap.output.columns = 100
    const c = new Compositor({ output: cap.output })
    c.mount()
    // Status row with ANSI styling but only 50 visible cells.
    const styled = `\x1b[38;5;208m${"a".repeat(50)}\x1b[0m`
    c.setLiveArea([styled, "", "", "❯ abc"], { row: 3, col: 5 })
    cap.output.columns = 40
    cap.writes.length = 0
    c.setLiveArea(["x", "", "", "❯ abc"], { row: 3, col: 5 })
    const out = joined(cap)
    // displayWidth strips ANSI; 50 cells under cols=40 → ceil(50/40)=2 rows.
    //   line 0: 2 rows. line 1: 1 row. line 2: 1 row. cursor.col=5: +0.
    //   walk-up: 4 rows.
    expect(out).toContain("\x1b[4A")
  })

  it("first-paint after mount still emits zero walk-up (no drawn area yet)", () => {
    const cap = makeOutput()
    cap.output.columns = 100
    const c = new Compositor({ output: cap.output })
    c.mount()
    cap.writes.length = 0
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    const out = joined(cap)
    // First paint: liveHeightValue==0 → eraseLiveSeq early-returns ""
    // → no walk-up emitted at all.
    expect(out).not.toMatch(/\x1b\[\d+A/)
  })

  it("writeBufferedStream uses physical walk-up too (no orphan leak via stream chunks)", () => {
    // The user's symptom was specifically about stream chunks
    // committing the orphan top of a reflowed live area into
    // scrollback. Both call sites of `eraseLiveSeq` must use the
    // physical walk-up.
    const cap = makeOutput()
    cap.output.columns = 100
    const c = new Compositor({ output: cap.output })
    c.mount()
    const wideStatus = "X".repeat(63)
    c.setLiveArea([wideStatus, "", "", "❯ abc"], { row: 3, col: 5 })
    // Simulate cols dropping to 40 between writes — without a new
    // setLiveArea call in between, so we exercise the
    // writeBufferedStream → eraseLiveSeq path under drift.
    cap.output.columns = 40
    cap.writes.length = 0
    c.writeStream("hello\n")
    const out = joined(cap)
    // Same walk-up math as the setLiveArea case: 4 physical rows.
    expect(out).toContain("\x1b[4A")
    expect(out).not.toContain("\x1b[3A")
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
