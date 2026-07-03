/**
 * Regression test for "duplicate paragraph above rendered version inside
 * macOS `script -r` recordings".
 *
 * Symptom: in a script(1)-recorded session the user sees the first wrap
 * row of the streamed raw markdown stuck in scrollback above the cleanly
 * rendered version of the same paragraph (with literal `**` markers
 * visible on the orphan row).
 *
 * Root cause: macOS BSD `script(1)` allocates a slave PTY with
 * `WINSZ=0`, so the recorded process sees `process.stdout.columns === 0`
 * even though `isTTY` is true. `updateStreamCol` then returns the raw
 * cell count of the partial line (no modulo), and `eraseLiveSeq` emits
 * `\x1b[1A\x1b[<raw>C\x1b[J` to walk the cursor back. On the real
 * terminal hosting the recording — which is narrower than the partial
 * — `\x1b[<raw>C` clamps at the right edge and lands the cursor on the
 * *first* wrap row of the partial instead of the *last*, leaving the
 * top row uncovered when the next chunk overwrites.
 *
 * Fix: when `output.columns ≤ 0`, fall back to `$COLUMNS`. mdstream
 * already does this (`renderer.rs term_width`), so this brings the two
 * layers into agreement and lets users opt in with
 * `COLUMNS=N script -r out.log -- bun run minimal-agent`.
 *
 * The 183-cell paragraph below is the exact paragraph from the user's
 * recording (session 2eda4395-9ae9-485a-9ea4-660e98de55fc):
 * ```
 * **Age of Empires II: Definitive Edition** launches natively on macOS
 * via **Steam on May 28, 2026** (about 2½ weeks from today). A Mac App
 * Store release follows later in 2026. The port
 * ```
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { displayWidth } from "../../terminal/term-width.ts"

import { Compositor } from "./compositor.ts"

const PARAGRAPH_183 =
  "**Age of Empires II: Definitive Edition** launches natively on macOS via **Steam on May 28, 2026** (about 2½ weeks from today). A Mac App Store release follows later in 2026. The port"

type Capture = {
  writes: string[]
  output: {
    write: (s: string) => boolean
    columns: number
    rows: number
    isTTY: boolean
  }
}

function makeOutput(opts: { columns?: number; rows?: number } = {}): Capture {
  const writes: string[] = []
  return {
    writes,
    output: {
      columns: opts.columns ?? 0,
      rows: opts.rows ?? 24,
      isTTY: true,
      write(s: string) {
        writes.push(s)
        return true
      },
    },
  }
}

const joined = (cap: Capture) => cap.writes.join("")

/**
 * Find the cursor-back-and-erase sequence the compositor emits before
 * the live-area redraw: `\x1b[<n>A\r\x1b[1A\x1b[<col>C\x1b[J` (or the
 * `\x1b[<col>C\x1b[J` portion when streamCol \> 0).
 */
function extractRedrawCol(stream: string): number | null {
  // Match the eraseLiveSeq's "step back to streamCol" tail. As of May 2026
  // the rows-up count is variable: drawLiveSeq emits up to 2 \r\n rows
  // above the live area (1 forced for mid-line, 1 smart-skip separator),
  // so eraseLiveSeq's `\x1b[<rows>A` may be `\x1b[1A` or `\x1b[2A`.
  // The canonical tail is then `\x1b[<col>C\x1b[J`.
  const m = stream.match(/\x1b\[\d+A\x1b\[(\d+)C\x1b\[J/)
  return m ? Number.parseInt(m[1] ?? "0", 10) : null
}

describe("Compositor — partial-redraw column fallback when output.columns is 0", () => {
  const savedColumns = process.env.COLUMNS

  beforeEach(() => {
    delete process.env.COLUMNS
  })
  afterEach(() => {
    if (savedColumns === undefined) delete process.env.COLUMNS
    else process.env.COLUMNS = savedColumns
  })

  it("the bug-input paragraph is exactly 183 cells (sanity)", () => {
    expect(displayWidth(PARAGRAPH_183)).toBe(183)
  })

  it("WITHOUT the fix's escape hatch, a wide partial wraps on the real terminal but the compositor reports raw cells (regression demonstration)", () => {
    const cap = makeOutput({ columns: 0 })
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    cap.writes.length = 0

    // First chunk: the long paragraph. No live-area redraw to extract from
    // here yet, but streamCol must reflect the unmodulo'd width because
    // there's nothing else to fall back to (no $COLUMNS in env).
    c.writeStream(PARAGRAPH_183)

    // streamCol exposed via the next eraseLiveSeq's emitted `\x1b[1A\x1b[NC\x1b[J`.
    cap.writes.length = 0
    c.writeStream("X")
    const col = extractRedrawCol(joined(cap))
    expect(col).toBe(183)
  })

  it("WITH $COLUMNS set, a wide partial wraps and streamCol uses the modulo", () => {
    process.env.COLUMNS = "107"
    const cap = makeOutput({ columns: 0 })
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    cap.writes.length = 0

    c.writeStream(PARAGRAPH_183)
    cap.writes.length = 0
    c.writeStream("X")
    const col = extractRedrawCol(joined(cap))
    expect(col).toBe(183 % 107) // = 76, the correct end-of-partial column
  })

  it("output.columns wins over $COLUMNS when both are set (host-reported width is authoritative)", () => {
    process.env.COLUMNS = "200"
    const cap = makeOutput({ columns: 100 })
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    cap.writes.length = 0

    c.writeStream(PARAGRAPH_183)
    cap.writes.length = 0
    c.writeStream("X")
    const col = extractRedrawCol(joined(cap))
    expect(col).toBe(183 % 100) // = 83, using output.columns not the env
  })

  it("invalid $COLUMNS values are ignored (treated as if unset)", () => {
    for (const bad of ["", "abc", "0", "-5", "  "]) {
      process.env.COLUMNS = bad
      const cap = makeOutput({ columns: 0 })
      const c = new Compositor({ output: cap.output })
      c.mount()
      c.setLiveArea(["❯ "], { row: 0, col: 2 })
      cap.writes.length = 0

      c.writeStream(PARAGRAPH_183)
      cap.writes.length = 0
      c.writeStream("X")
      const col = extractRedrawCol(joined(cap))
      expect(col).toBe(183) // no fallback ⇒ raw cell count
    }
  })

  it("normal (host-reported columns > 0) path is unchanged", () => {
    const cap = makeOutput({ columns: 107 })
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    cap.writes.length = 0

    c.writeStream(PARAGRAPH_183)
    cap.writes.length = 0
    c.writeStream("X")
    const col = extractRedrawCol(joined(cap))
    expect(col).toBe(76)
  })

  it("short partials (< terminal width) are unaffected by the fallback", () => {
    process.env.COLUMNS = "107"
    const cap = makeOutput({ columns: 0 })
    const c = new Compositor({ output: cap.output })
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    cap.writes.length = 0

    c.writeStream("Almost —")
    cap.writes.length = 0
    c.writeStream("X")
    const col = extractRedrawCol(joined(cap))
    // "Almost —" = 8 cells; 8 < 107 so modulo is a no-op.
    expect(col).toBe(8)
  })
})
