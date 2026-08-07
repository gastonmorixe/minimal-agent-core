/**
 * Regression test for the "broken/duplicated paragraph" bug visible in
 * `tmp/sessions/recordings/.../...fixedlog`.
 *
 * Two intertwined causes:
 *
 * 1. **Formatter chunk boundaries split escape sequences.** When the
 *    `Formatter` reader (Bun pipe) yields a chunk that ends inside a
 *    partial CSI/SGR (e.g. `\x1b[38;2`), the compositor's
 *    `writeStream` wraps it as
 *    `\x1b[?25l<eraseLiveSeq><partial-CSI><drawLiveSeq>` and the
 *    terminal interprets the injected live-area sequences as part of
 *    the broken CSI. The visible result is fragments like `[1m`,
 *    `[38;2;180;140;255m` printed as literal text into scrollback.
 *
 * 2. **mdstream's row-count for its "redraw line" sequence assumes
 *    80 columns** (its `crossterm::terminal::size()` fails when stdout
 *    is a pipe). In a wider host terminal, the `\x1b[NA\r\x1b[J`
 *    redraw lands on the wrong row, leaving the raw markdown copy in
 *    scrollback and the formatted copy above it.
 *
 * The fixture was captured by feeding a single Markdown line through
 * `mdstream 0.2.1` byte-by-byte with stdout=pipe (so the 80-col
 * fallback fires). Replaying it through the real `Compositor` into a
 * 200-col `FakeTerminal` lets us observe both failure modes without
 * spawning a subprocess.
 */

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { FakeTerminal } from "../../test-utils/fake-terminal.ts"

import { Compositor } from "./compositor.ts"
import { Formatter } from "./formatter/formatter.ts"

function loadFixture(name: string): string {
  const p = join(import.meta.dir, "..", "test-utils", "fixtures", name)
  return readFileSync(p, "utf8")
}

function makeCompositor(term: FakeTerminal) {
  return new Compositor({
    output: {
      isTTY: true,
      columns: term.cols,
      rows: term.rows,
      write: (s: string) => {
        term.feed(s)
        return true
      },
    } as any,
  })
}

const FIXTURE = "mdstream-redraw-80col.bin"

const RAW_MARKDOWN_MARKERS = ["**ASK mode**", "`ask-mode`", "`Edit`", "`Write`"]

const SGR_FRAGMENT_RE = /(?:^|[^\x1b])\[(?:0|1|22|38;2;\d{1,3};\d{1,3};\d{1,3})m/

const FORMATTED_LINE =
  "Concrete example: ASK mode (from the ask-mode plugin). When active, Edit and Write are stripped from my available tools."
const MDSTREAM = "/Users/dev/Projects/mdstream/target/release/mdstream"

function feedChunked(c: Compositor, bytes: string, chunkSize: number) {
  for (let i = 0; i < bytes.length; i += chunkSize) {
    c.writeStream(bytes.slice(i, i + chunkSize))
  }
}

describe("Compositor + mdstream redraw — wide terminal regression", () => {
  it("no SGR fragments leak into scrollback when chunks split mid-escape (200 cols, 8-byte chunks)", () => {
    const term = new FakeTerminal({ cols: 200, rows: 8, scrollbackLimit: 200 })
    const c = makeCompositor(term)
    c.mount()
    // Pre-fill so the live area sits near the bottom.
    for (let i = 0; i < 5; i++) c.writeStream(`prefill ${i}\n`)
    c.setLiveArea(["❯ "], { row: 0, col: 2 })

    feedChunked(c, loadFixture(FIXTURE), 8)
    c.unmount()

    const all = [...term.scrollback, ...term.screen()].join("\n")

    // No partial SGR fragments printed as text.
    expect(SGR_FRAGMENT_RE.test(all)).toBe(false)

    // Formatted line appears at least once, intact.
    expect(all).toContain(FORMATTED_LINE)

    // Raw markdown source must not survive into scrollback.
    for (const marker of RAW_MARKDOWN_MARKERS) {
      expect(all).not.toContain(marker)
    }
  })

  it("does not duplicate the paragraph (raw + formatted) in scrollback (200 cols)", () => {
    const term = new FakeTerminal({ cols: 200, rows: 24, scrollbackLimit: 200 })
    const c = makeCompositor(term)
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })

    // One single chunk delivery (no pipe split). Even so, mdstream's
    // 80-col redraw math vs. the 200-col terminal can land the redraw
    // on the wrong row when the partial line previously wrapped.
    c.writeStream(loadFixture(FIXTURE))
    c.unmount()

    const all = [...term.scrollback, ...term.screen()].join("\n")
    const formattedCount = (all.match(/Concrete example: ASK mode/g) ?? []).length
    expect(formattedCount).toBe(1)
    for (const marker of RAW_MARKDOWN_MARKERS) {
      expect(all).not.toContain(marker)
    }
  })
})

describe("Compositor + real mdstream subprocess", () => {
  async function renderWithMdstream(cols: number): Promise<string> {
    const term = new FakeTerminal({ cols, rows: 24, scrollbackLimit: 200 })
    const c = makeCompositor(term)
    c.mount()
    c.setLiveArea(["❯ "], { row: 0, col: 2 })
    const sink = {
      columns: cols,
      rows: 24,
      write: (s: string | Uint8Array) => {
        c.writeStream(typeof s === "string" ? s : new TextDecoder().decode(s))
        return true
      },
    }
    const formatter = new Formatter([MDSTREAM], sink)
    formatter.start()
    formatter.write(
      "Concrete example: **ASK mode** (from the `ask-mode` plugin). When active, `Edit` and `Write` are stripped from my available tools.",
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    formatter.write("\n")
    await formatter.end()
    c.flushStream()
    c.unmount()
    return term.fullText()
  }

  it.skipIf(!existsSync(MDSTREAM))(
    "renders one clean paragraph through mdstream at 60 columns",
    async () => {
      const all = await renderWithMdstream(60)
      const formattedCount = (all.match(/Concrete example: ASK mode/g) ?? []).length
      expect(formattedCount).toBe(1)
      for (const marker of RAW_MARKDOWN_MARKERS) {
        expect(all).not.toContain(marker)
      }
      expect(SGR_FRAGMENT_RE.test(all)).toBe(false)
    },
  )

  it.skipIf(!existsSync(MDSTREAM))(
    "renders one clean paragraph through mdstream at 200 columns",
    async () => {
      const all = await renderWithMdstream(200)
      const formattedCount = (all.match(/Concrete example: ASK mode/g) ?? []).length
      expect(formattedCount).toBe(1)
      for (const marker of RAW_MARKDOWN_MARKERS) {
        expect(all).not.toContain(marker)
      }
      expect(SGR_FRAGMENT_RE.test(all)).toBe(false)
    },
  )
})
