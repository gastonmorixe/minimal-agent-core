import { describe, expect, it } from "bun:test"
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
    // ("hello", streamCol=5), so the erase sequence steps up an extra row
    // and forward to col 5 to land back at end-of-"hello".
    expect(out).toContain("\x1b[1A")
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
