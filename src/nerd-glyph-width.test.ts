import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import {
  _resetNerdGlyphCellsForTest,
  effectiveDisplayWidth,
  getNerdGlyphCells,
  nerdGlyphCellsIsExplicit,
  probeNerdGlyphCells,
  setNerdGlyphCells,
  visualCellsForGlyph,
} from "./nerd-glyph-width.ts"

class FakeStdin extends EventEmitter {
  isTTY = true
  rawModes: boolean[] = []
  resumed = 0
  setRawMode(v: boolean): this {
    this.rawModes.push(v)
    return this
  }
  resume(): this {
    this.resumed++
    return this
  }
  pause(): this {
    return this
  }
}

class FakeStdout {
  isTTY = true
  writes: string[] = []
  write(s: string): boolean {
    this.writes.push(s)
    return true
  }
}

function withNoMultiplexer(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const savedTmux = process.env.TMUX
    const savedSty = process.env.STY
    const savedTerm = process.env.TERM
    delete process.env.TMUX
    delete process.env.STY
    process.env.TERM = "xterm-256color"
    try {
      await fn()
    } finally {
      if (savedTmux !== undefined) process.env.TMUX = savedTmux
      if (savedSty !== undefined) process.env.STY = savedSty
      if (savedTerm !== undefined) process.env.TERM = savedTerm
    }
  }
}

describe("visualCellsForGlyph", () => {
  beforeEach(() => {
    _resetNerdGlyphCellsForTest()
  })

  it("returns 1 for BMP narrow icons like ● (U+25CF)", () => {
    expect(visualCellsForGlyph("●")).toBe(1)
  })

  it("returns 1 for plain ASCII", () => {
    expect(visualCellsForGlyph("x")).toBe(1)
    expect(visualCellsForGlyph(" ")).toBe(1)
  })

  it("returns 1 for Braille rotor frames (U+2800..28FF)", () => {
    expect(visualCellsForGlyph("⠋")).toBe(1)
    expect(visualCellsForGlyph("⡏")).toBe(1)
  })

  it("returns 2 for CJK fullwidth glyphs", () => {
    expect(visualCellsForGlyph("漢")).toBe(2)
  })

  it("returns the cached PUA width for nf-md-tools (default = 1)", () => {
    expect(visualCellsForGlyph("\u{F1064}")).toBe(1)
  })

  it("returns 2 for PUA glyphs when the cache has been set to 2", () => {
    setNerdGlyphCells(2)
    expect(visualCellsForGlyph("\u{F1064}")).toBe(2)
    expect(visualCellsForGlyph("\u{F033E}")).toBe(2)
  })

  it("returns 1 for PUA glyphs when the cache has been set to 1", () => {
    setNerdGlyphCells(1)
    expect(visualCellsForGlyph("\u{F1064}")).toBe(1)
  })

  it("strips a leading SGR escape before reading the codepoint", () => {
    setNerdGlyphCells(2)
    // Bright-magenta SGR + glyph: the helper should still see PUA.
    expect(visualCellsForGlyph("\x1b[95m\u{F1064}\x1b[39m")).toBe(2)
  })

  it("returns 1 for an empty string (defensive fallback)", () => {
    expect(visualCellsForGlyph("")).toBe(1)
  })
})

describe("effectiveDisplayWidth", () => {
  beforeEach(() => {
    _resetNerdGlyphCellsForTest()
  })

  it("sums plain ASCII cells", () => {
    expect(effectiveDisplayWidth("NET")).toBe(3)
    expect(effectiveDisplayWidth("hello world")).toBe(11)
  })

  it("treats BMP narrow glyphs as 1 cell each", () => {
    expect(effectiveDisplayWidth("●")).toBe(1)
    expect(effectiveDisplayWidth("⠋⡏")).toBe(2)
  })

  it("treats CJK as 2 cells each", () => {
    expect(effectiveDisplayWidth("漢")).toBe(2)
    expect(effectiveDisplayWidth("漢字")).toBe(4)
  })

  it("uses the probed PUA width for Nerd Font glyphs", () => {
    expect(effectiveDisplayWidth("\u{F1064}")).toBe(1) // default cache
    setNerdGlyphCells(2)
    expect(effectiveDisplayWidth("\u{F1064}")).toBe(2)
    expect(effectiveDisplayWidth("\u{F1064}\u{F033E}")).toBe(4)
  })

  it("strips ANSI SGR escapes", () => {
    expect(effectiveDisplayWidth("\x1b[31mNET\x1b[39m")).toBe(3)
  })

  it("treats combining marks and ZWJ as zero-width", () => {
    expect(effectiveDisplayWidth("a\u0301")).toBe(1) // a + combining acute
    expect(effectiveDisplayWidth("\u200b")).toBe(0) // ZWSP
  })

  it("returns 0 for an empty string", () => {
    expect(effectiveDisplayWidth("")).toBe(0)
  })
})

describe("setNerdGlyphCells / getNerdGlyphCells", () => {
  beforeEach(() => {
    _resetNerdGlyphCellsForTest()
  })

  it("defaults to 1 before any explicit set / probe", () => {
    expect(getNerdGlyphCells()).toBe(1)
    expect(nerdGlyphCellsIsExplicit()).toBe(false)
  })

  it("set + get round-trips and flags explicit=true", () => {
    setNerdGlyphCells(2)
    expect(getNerdGlyphCells()).toBe(2)
    expect(nerdGlyphCellsIsExplicit()).toBe(true)
    setNerdGlyphCells(1)
    expect(getNerdGlyphCells()).toBe(1)
    expect(nerdGlyphCellsIsExplicit()).toBe(true)
  })
})

describe("probeNerdGlyphCells", () => {
  afterEach(() => {
    _resetNerdGlyphCellsForTest()
  })

  it("returns cells=null immediately on a non-TTY", async () => {
    const stdin = new FakeStdin()
    stdin.isTTY = false
    const stdout = new FakeStdout()
    stdout.isTTY = false
    const r = await probeNerdGlyphCells(stdin as any, stdout as any, { timeoutMs: 50 })
    expect(r.cells).toBeNull()
    expect(r.unparsed).toBe("")
    expect(stdout.writes).toEqual([])
  })

  it("returns cells=null immediately inside tmux", async () => {
    const orig = process.env.TMUX
    process.env.TMUX = "/tmp/tmux-501/default,98738,26"
    try {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const r = await probeNerdGlyphCells(stdin as any, stdout as any, { timeoutMs: 50 })
      expect(r.cells).toBeNull()
      expect(r.unparsed).toBe("")
      expect(stdout.writes).toEqual([])
    } finally {
      if (orig === undefined) delete process.env.TMUX
      else process.env.TMUX = orig
    }
  })

  it(
    "parses delta=2 as cells=2 (patched Nerd Font)",
    withNoMultiplexer(async () => {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const p = probeNerdGlyphCells(stdin as any, stdout as any, { timeoutMs: 200 })
      await Promise.resolve()
      // First, the probe writes `\r\x1b[6n` to baseline.
      expect(stdout.writes.at(0)).toBe("\r\x1b[6n")
      // Reply with column 1 for the baseline.
      stdin.emit("data", "\x1b[1;1R")
      await Promise.resolve()
      // Probe should now have written the glyph + second CPR.
      expect(stdout.writes.at(1)).toContain("\u{F1064}")
      expect(stdout.writes.at(1)).toContain("\x1b[6n")
      // Reply with column 3 (1 → 3, delta = 2).
      stdin.emit("data", "\x1b[1;3R")
      const r = await p
      expect(r.cells).toBe(2)
      // Restore sequence emitted to wipe the visible glyph.
      expect(stdout.writes.at(-1)).toBe("\r\x1b[K")
      // Cache should be updated.
      expect(getNerdGlyphCells()).toBe(2)
      expect(nerdGlyphCellsIsExplicit()).toBe(true)
    }),
  )

  it(
    "parses delta=1 as cells=1 (unpatched fallback font)",
    withNoMultiplexer(async () => {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const p = probeNerdGlyphCells(stdin as any, stdout as any, { timeoutMs: 200 })
      await Promise.resolve()
      stdin.emit("data", "\x1b[1;1R")
      await Promise.resolve()
      stdin.emit("data", "\x1b[1;2R")
      const r = await p
      expect(r.cells).toBe(1)
      expect(getNerdGlyphCells()).toBe(1)
    }),
  )

  it(
    "returns cells=null when the column delta is bogus (e.g. 0 or 3)",
    withNoMultiplexer(async () => {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const p = probeNerdGlyphCells(stdin as any, stdout as any, { timeoutMs: 200 })
      await Promise.resolve()
      stdin.emit("data", "\x1b[1;5R")
      await Promise.resolve()
      stdin.emit("data", "\x1b[1;5R") // delta 0
      const r = await p
      expect(r.cells).toBeNull()
      // Cache untouched.
      expect(getNerdGlyphCells()).toBe(1)
      expect(nerdGlyphCellsIsExplicit()).toBe(false)
    }),
  )

  it(
    "times out and returns cells=null when the terminal never replies",
    withNoMultiplexer(async () => {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const start = Date.now()
      const r = await probeNerdGlyphCells(stdin as any, stdout as any, { timeoutMs: 30 })
      const elapsed = Date.now() - start
      expect(r.cells).toBeNull()
      expect(elapsed).toBeGreaterThanOrEqual(25)
      expect(elapsed).toBeLessThan(500)
      // Still wrote the restore sequence on timeout for visual hygiene.
      expect(stdout.writes).toContain("\r\x1b[K")
    }),
  )

  it(
    "returns typeahead bytes that arrived alongside the two CPR replies",
    withNoMultiplexer(async () => {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const p = probeNerdGlyphCells(stdin as any, stdout as any, { timeoutMs: 200 })
      await Promise.resolve()
      // First reply with a typeahead byte before it.
      stdin.emit("data", "a\x1b[1;1R")
      await Promise.resolve()
      // Second reply with another typeahead byte after it.
      stdin.emit("data", "\x1b[1;3Rb")
      const r = await p
      expect(r.cells).toBe(2)
      expect(r.unparsed).toBe("ab")
    }),
  )

  it(
    "removes its data listener after resolving (no leak)",
    withNoMultiplexer(async () => {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const p = probeNerdGlyphCells(stdin as any, stdout as any, { timeoutMs: 50 })
      await Promise.resolve()
      stdin.emit("data", "\x1b[1;1R")
      stdin.emit("data", "\x1b[1;3R")
      await p
      expect(stdin.listenerCount("data")).toBe(0)
    }),
  )

  it(
    "does NOT toggle raw mode when alreadyRaw=true",
    withNoMultiplexer(async () => {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const p = probeNerdGlyphCells(stdin as any, stdout as any, {
        timeoutMs: 50,
        alreadyRaw: true,
      })
      await Promise.resolve()
      stdin.emit("data", "\x1b[1;1R")
      stdin.emit("data", "\x1b[1;2R")
      await p
      expect(stdin.rawModes).toEqual([]) // no toggle
    }),
  )

  it(
    "respects a custom sample glyph",
    withNoMultiplexer(async () => {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const p = probeNerdGlyphCells(stdin as any, stdout as any, {
        timeoutMs: 200,
        sample: "X",
      })
      await Promise.resolve()
      stdin.emit("data", "\x1b[1;1R")
      await Promise.resolve()
      expect(stdout.writes.at(1)).toContain("X")
      stdin.emit("data", "\x1b[1;2R")
      const r = await p
      expect(r.cells).toBe(1)
    }),
  )
})
