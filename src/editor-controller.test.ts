import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { EditorController } from "./editor-controller.ts"
import { displayWidth } from "./term-width.ts"
import { FakeTerminal } from "./test-utils/fake-terminal.ts"
import { Compositor } from "./ui/compositor.ts"

class FakeTTYInput extends EventEmitter {
  isTTY = true
  encoding: BufferEncoding | null = null
  resumed = false
  rawModes: boolean[] = []

  setEncoding(encoding: BufferEncoding): this {
    this.encoding = encoding
    return this
  }
  resume(): this {
    this.resumed = true
    return this
  }
  pause(): this {
    this.resumed = false
    return this
  }
  setRawMode(value: boolean): this {
    this.rawModes.push(value)
    return this
  }
  send(chunk: string): void {
    this.emit("data", chunk)
  }
}

class FakeOutput {
  readonly chunks: string[] = []
  isTTY = true
  columns = 80
  rows = 24
  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }
  text(): string {
    return this.chunks.join("")
  }
}

class FakeCompositor {
  liveAreaCalls: Array<{
    lines: string[]
    cursor: { row: number; col: number } | null
  }> = []
  liveHeightCalls: number[] = []
  liveHeight = 1
  setLiveArea(lines: string[], cursor: { row: number; col: number } | null): void {
    this.liveAreaCalls.push({ lines: [...lines], cursor: cursor ? { ...cursor } : null })
  }
  setLiveHeight(n: number): void {
    this.liveHeightCalls.push(n)
    this.liveHeight = n
  }
  last() {
    return this.liveAreaCalls[this.liveAreaCalls.length - 1]
  }
}

function make(opts: { prompt?: string; continuation?: string; columns?: number } = {}) {
  const stdin = new FakeTTYInput()
  const output = new FakeOutput()
  if (opts.columns) output.columns = opts.columns
  const compositor = new FakeCompositor()
  const ctrl = new EditorController({
    prompt: opts.prompt ?? "> ",
    continuationPrompt: opts.continuation ?? "  ",
    compositor: compositor as any,
    stdin: stdin as any,
    output: output as any,
  })
  return { ctrl, stdin, output, compositor }
}

describe("EditorController — start/stop", () => {
  it("start enables raw mode + terminal input modes and renders an empty prompt", () => {
    const { ctrl, stdin, output, compositor } = make()
    ctrl.start()
    expect(stdin.rawModes).toEqual([true])
    expect(stdin.resumed).toBe(true)
    expect(output.text()).toContain("\x1b[?2004h") // bracketed paste
    expect(output.text()).toContain("\x1b[>31u") // kitty
    expect(compositor.last().lines).toEqual(["", "> "])
    expect(compositor.last().cursor).toEqual({ row: 1, col: 2 })
    ctrl.stop()
  })

  it("stop restores raw mode and disables terminal input modes", () => {
    const { ctrl, stdin, output } = make()
    ctrl.start()
    ctrl.stop()
    expect(stdin.rawModes).toEqual([true, false])
    expect(stdin.resumed).toBe(false)
    expect(output.text()).toContain("\x1b[<u") // kitty disable
    expect(output.text()).toContain("\x1b[?2004l") // paste disable
  })
})

describe("EditorController — typing & submit", () => {
  it("typed characters update the buffer and trigger a live-area repaint", () => {
    const { ctrl, stdin, compositor } = make()
    ctrl.start()
    stdin.send("hi")
    expect(compositor.last().lines).toEqual(["", "> hi"])
    expect(compositor.last().cursor).toEqual({ row: 1, col: 4 })
    ctrl.stop()
  })

  it("Enter on non-blank emits 'submit' with text and clears the buffer (no unmount)", () => {
    const { ctrl, stdin, compositor } = make()
    const submits: string[] = []
    ctrl.on("submit", (text) => submits.push(text))
    ctrl.start()
    stdin.send("hello")
    stdin.send("\r")
    expect(submits).toEqual(["hello"])
    expect(compositor.last().lines).toEqual(["", "> "])
    expect(compositor.last().cursor).toEqual({ row: 1, col: 2 })
    ctrl.stop()
  })

  it("on submit, the rendered prompt is committed to scrollback via writeStream before the buffer clears", () => {
    const { ctrl, stdin, compositor } = make()
    const streamed: string[] = []
    ;(compositor as unknown as { writeStream: (s: string) => void }).writeStream = (s) => {
      streamed.push(s)
    }
    ctrl.start()
    // Multiline submission via Shift+Enter (kitty CSI 13;2u) so we exercise
    // the full-buffer rendering path, not just the visible viewport.
    stdin.send("line1")
    stdin.send("\x1b[13;2u")
    stdin.send("line2")
    stdin.send("\x1b[13;2u")
    stdin.send("line3")
    stdin.send("\r")
    expect(streamed).toEqual(["\n> line1\n  line2\n  line3\n"])
    // After the commit + clear, the live area shows a fresh empty prompt.
    expect(compositor.last().lines).toEqual(["", "> "])
    ctrl.stop()
  })

  it("submit without a writeStream-capable compositor still clears the buffer cleanly", () => {
    const { ctrl, stdin, compositor } = make()
    const submits: string[] = []
    ctrl.on("submit", (text) => submits.push(text))
    ctrl.start()
    stdin.send("hi")
    stdin.send("\r")
    expect(submits).toEqual(["hi"])
    expect(compositor.last().lines).toEqual(["", "> "])
    ctrl.stop()
  })

  it("setBuffer(text) replaces buffer content and round-trips through submit", () => {
    const { ctrl, stdin, compositor } = make()
    const submits: string[] = []
    ctrl.on("submit", (text) => submits.push(text))
    ctrl.start()
    // Pre-fill the buffer with junk to confirm setBuffer truly replaces.
    stdin.send("garbage")
    ctrl.setBuffer("hello world")
    expect(compositor.last().lines).toEqual(["", "> hello world"])
    stdin.send("\r")
    expect(submits).toEqual(["hello world"])
    ctrl.stop()
  })

  it("setBuffer with multi-line text restores newlines correctly (used by abort flow)", () => {
    const { ctrl, stdin, compositor } = make()
    const submits: string[] = []
    ctrl.on("submit", (text) => submits.push(text))
    ctrl.start()
    ctrl.setBuffer("line1\nline2\nline3")
    expect(compositor.last().lines).toEqual(["", "> line1", "  line2", "  line3"])
    stdin.send("\r")
    expect(submits).toEqual(["line1\nline2\nline3"])
    ctrl.stop()
  })

  it("setBuffer('') clears the buffer to an empty prompt", () => {
    const { ctrl, stdin, compositor } = make()
    ctrl.start()
    stdin.send("typed text")
    ctrl.setBuffer("")
    expect(compositor.last().lines).toEqual(["", "> "])
    ctrl.stop()
  })

  it("Enter on blank does not emit submit and just clears any whitespace", () => {
    const { ctrl, stdin } = make()
    const submits: string[] = []
    ctrl.on("submit", (t) => submits.push(t))
    ctrl.start()
    stdin.send("\r")
    expect(submits).toEqual([])
    ctrl.stop()
  })

  it("Ctrl+C with empty buffer emits 'cancel'", () => {
    const { ctrl, stdin } = make()
    let cancelled = false
    ctrl.on("cancel", () => {
      cancelled = true
    })
    ctrl.start()
    stdin.send("\x03")
    expect(cancelled).toBe(true)
    ctrl.stop()
  })

  it("Ctrl+C with content clears the buffer (does not emit cancel)", () => {
    const { ctrl, stdin, compositor } = make()
    let cancelled = false
    ctrl.on("cancel", () => {
      cancelled = true
    })
    ctrl.start()
    stdin.send("oops")
    stdin.send("\x03")
    expect(cancelled).toBe(false)
    expect(compositor.last().lines).toEqual(["", "> "])
    ctrl.stop()
  })

  it("Backspace deletes the previous char", () => {
    const { ctrl, stdin, compositor } = make()
    ctrl.start()
    stdin.send("ab")
    stdin.send("\x7f")
    expect(compositor.last().lines).toEqual(["", "> a"])
    ctrl.stop()
  })
})

describe("EditorController — status row", () => {
  it("setStatus(text) replaces the blank header row with status text (height stays constant)", () => {
    const { ctrl, compositor } = make()
    ctrl.start()
    // On start, the live area already has a blank header row + prompt (height=2).
    expect(compositor.last().lines).toEqual(["", "> "])
    compositor.liveHeightCalls.length = 0
    ctrl.setStatus("⠋ Thinking")
    // Header row now shows status; height stays at 2 — no jump.
    expect(compositor.last().lines).toEqual(["⠋ Thinking", "> "])
    expect(compositor.last().cursor).toEqual({ row: 1, col: 2 })
    // No height change needed since height was already 2.
    expect(compositor.liveHeightCalls).not.toContain(1)
    ctrl.stop()
  })

  it("setStatus(null) clears the status row back to blank (height stays constant)", () => {
    const { ctrl, compositor } = make()
    ctrl.start()
    ctrl.setStatus("busy")
    compositor.liveHeightCalls.length = 0
    ctrl.setStatus(null)
    // Header row is blank again; height stays at 2 — prompt does not jump.
    expect(compositor.last().lines).toEqual(["", "> "])
    expect(compositor.last().cursor).toEqual({ row: 1, col: 2 })
    // Height unchanged (still 2).
    expect(compositor.liveHeightCalls).not.toContain(1)
    ctrl.stop()
  })

  it("status row coexists with multiline editor", () => {
    const { ctrl, stdin, compositor } = make()
    ctrl.start()
    stdin.send("a")
    stdin.send("\x1b[13;2u") // shift+enter
    stdin.send("b")
    ctrl.setStatus("⠋")
    expect(compositor.last().lines).toEqual(["⠋", "> a", "  b"])
    // editor cursor is at row 2 (status occupies row 0, editor rows 1..2)
    expect(compositor.last().cursor).toEqual({ row: 2, col: 3 })
    ctrl.stop()
  })

  it("truncates long status rows so they cannot soft-wrap in the live area", () => {
    const { ctrl, compositor } = make({ columns: 20 })
    ctrl.start()
    ctrl.setStatus("Thinking about a very long model response")

    const status = compositor.last().lines[0]
    expect(displayWidth(status)).toBeLessThanOrEqual(20)
    expect(status).toBe("Thinking about a ...")
    ctrl.stop()
  })

  it("keeps stream output aligned after a long status row in a narrow terminal", () => {
    const term = new FakeTerminal({ cols: 20, rows: 8, scrollbackLimit: 50 })
    const output = {
      isTTY: true,
      columns: 20,
      rows: 8,
      write: (s: string) => {
        term.feed(s)
        return true
      },
    }
    const compositor = new Compositor({ output })
    const stdin = new FakeTTYInput()
    const ctrl = new EditorController({
      prompt: "> ",
      continuationPrompt: "  ",
      compositor,
      stdin: stdin as any,
      output: output as any,
    })

    compositor.mount()
    ctrl.start()
    ctrl.setStatus("Thinking about a very long model response")
    compositor.writeStream("OUT\n")

    expect(term.fullText()).toContain("OUT")
    expect(term.fullText()).not.toContain("model response")
    ctrl.stop()
    compositor.unmount()
  })
})

describe("EditorController — resize", () => {
  it("notifyResize immediately reflows the live area to the new width", () => {
    const { ctrl, stdin, output, compositor } = make({ columns: 20 })
    ctrl.start()
    stdin.send("abcdefghijklmnop")
    // 1 editor line + 1 blank header = 2 live-area rows.
    expect(compositor.last().lines.length).toBe(2)

    output.columns = 10
    ctrl.notifyResize()

    // After reflow the editor wraps to multiple rows (still has the header).
    expect(compositor.last().lines.length).toBeGreaterThan(2)
    for (const line of compositor.last().lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(10)
    }
    ctrl.stop()
  })
})

describe("EditorController — bracketed paste", () => {
  it("inserts pasted multiline text and adjusts viewport so the cursor is visible", () => {
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new FakeCompositor()
    const ctrl = new EditorController({
      prompt: "> ",
      continuationPrompt: "  ",
      compositor: compositor as any,
      stdin: stdin as any,
      output: output as any,
      maxLiveHeight: 3,
    })
    ctrl.start()
    // Simulate a bracketed paste of 5 lines.
    stdin.send("\x1b[200~")
    stdin.send("L1\nL2\nL3\nL4\nL5")
    stdin.send("\x1b[201~")
    expect(ctrl.buffer().toString()).toBe("L1\nL2\nL3\nL4\nL5")
    // Cap at 3: 1 blank header + 2 editor rows (editorBudget=2). Cursor at L5,
    // viewport shows L4+L5 but viewportTop=4 > 0 so indicator shows "^ 4 more lines".
    expect(compositor.last().lines[0]).toBe("")
    expect(compositor.last().lines[1]).toContain("more line")
    expect(compositor.last().lines[2]).toBe("  L5")
    expect(compositor.liveHeight).toBe(3)
    ctrl.stop()
  })
})

describe("EditorController — viewport cap & internal scroll", () => {
  it("caps liveHeight at maxLiveHeight and scrolls a window onto the buffer", () => {
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new FakeCompositor()
    const ctrl = new EditorController({
      prompt: "> ",
      continuationPrompt: "  ",
      compositor: compositor as any,
      stdin: stdin as any,
      output: output as any,
      maxLiveHeight: 3,
    })
    ctrl.start()

    // Build 5 logical lines: a / b / c / d / e
    stdin.send("a")
    stdin.send("\x1b[13;2u")
    stdin.send("b")
    stdin.send("\x1b[13;2u")
    stdin.send("c")
    stdin.send("\x1b[13;2u")
    stdin.send("d")
    stdin.send("\x1b[13;2u")
    stdin.send("e")

    // liveHeight capped at 3.
    expect(compositor.liveHeight).toBe(3)
    // 1 blank header + 2 editor rows. Cursor at "e" (row 4), viewport shows d+e
    // but viewportTop=4 > 0 so indicator shows "^ 4 more lines".
    expect(compositor.last().lines[0]).toBe("")
    expect(compositor.last().lines[1]).toContain("more line")
    expect(compositor.last().lines[2]).toBe("  e")
    // Cursor on last row, col 3.
    expect(compositor.last().cursor).toEqual({ row: 2, col: 3 })
    ctrl.stop()
  })

  it("scrolls back up when cursor moves above the window", () => {
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new FakeCompositor()
    const ctrl = new EditorController({
      prompt: "> ",
      continuationPrompt: "  ",
      compositor: compositor as any,
      stdin: stdin as any,
      output: output as any,
      maxLiveHeight: 2,
    })
    ctrl.start()
    // a / b / c
    stdin.send("a")
    stdin.send("\x1b[13;2u")
    stdin.send("b")
    stdin.send("\x1b[13;2u")
    stdin.send("c")
    // maxLiveHeight=2, statusRows=1 → editorBudget=1 → only 1 editor row visible.
    // Cursor on "c": viewportTop=2 > 0, so even the single visible editor row
    // shows the "^ N more lines" scroll indicator (the cursor row is scrolled into view).
    expect(compositor.last().lines[0]).toBe("")
    expect(compositor.last().lines[1]).toContain("more line")
    // Move cursor up twice → onto row 0 ("a"): window scrolls up.
    stdin.send("\x1b[A")
    stdin.send("\x1b[A")
    // Cursor at "a" (row 0), viewport scrolls to show "a". viewportTop=0 → no indicator.
    expect(compositor.last().lines).toEqual(["", "> a"])
    expect(compositor.last().cursor).toEqual({ row: 1, col: 3 })
    ctrl.stop()
  })

  it("status row counts against the cap (cap=3, status=1 → editor window=2)", () => {
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new FakeCompositor()
    const ctrl = new EditorController({
      prompt: "> ",
      continuationPrompt: "  ",
      compositor: compositor as any,
      stdin: stdin as any,
      output: output as any,
      maxLiveHeight: 3,
    })
    ctrl.start()
    ctrl.setStatus("⠋")
    stdin.send("a")
    stdin.send("\x1b[13;2u")
    stdin.send("b")
    stdin.send("\x1b[13;2u")
    stdin.send("c")
    expect(compositor.liveHeight).toBe(3)
    // status + 2 editor rows. cursor at "c", viewport shows b+c but
    // viewportTop=2 > 0 so indicator shows "^ 2 more lines".
    expect(compositor.last().lines[0]).toBe("⠋")
    expect(compositor.last().lines[1]).toContain("more line")
    expect(compositor.last().lines[2]).toBe("  c")
    ctrl.stop()
  })
})

describe("EditorController — multiline & growth", () => {
  it("Shift+Enter (kitty CSI 13;2u) inserts a newline; live height grows to fit", () => {
    const { ctrl, stdin, compositor } = make()
    ctrl.start()
    // On start: ["", "> "] at height 2. Reset call log.
    compositor.liveHeightCalls.length = 0
    stdin.send("a")
    stdin.send("\x1b[13;2u") // shift+enter (kitty)
    stdin.send("b")
    // 2 editor rows + 1 header = height 3.
    expect(compositor.last().lines).toEqual(["", "> a", "  b"])
    expect(compositor.last().cursor).toEqual({ row: 2, col: 3 })
    expect(compositor.liveHeightCalls).toContain(3)
    ctrl.stop()
  })

  it("after submit, live height shrinks back to 2 (header + empty prompt)", () => {
    const { ctrl, stdin, compositor } = make()
    ctrl.start()
    stdin.send("a")
    stdin.send("\x1b[13;2u")
    stdin.send("b")
    compositor.liveHeightCalls.length = 0
    stdin.send("\r")
    // Was height 3 (header + 2 editor rows); after submit+clear, back to 2.
    expect(compositor.liveHeightCalls).toContain(2)
    ctrl.stop()
  })
})
