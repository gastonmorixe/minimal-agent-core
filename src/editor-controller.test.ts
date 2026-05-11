import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { AbortBus } from "./abort-bus.ts"
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

function make(
  opts: {
    prompt?: string
    continuation?: string
    columns?: number
    bareEscapeMs?: number
    abortBus?: AbortBus
  } = {},
) {
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
    ...(opts.bareEscapeMs !== undefined ? { bareEscapeMs: opts.bareEscapeMs } : {}),
    ...(opts.abortBus ? { abortBus: opts.abortBus } : {}),
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
    // Idle layout (no status): just the editor row. Status row is omitted
    // when empty — see editor-controller `repaint` layout comments.
    expect(compositor.last().lines).toEqual(["> "])
    expect(compositor.last().cursor).toEqual({ row: 0, col: 2 })
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
    expect(compositor.last().lines).toEqual(["> hi"])
    expect(compositor.last().cursor).toEqual({ row: 0, col: 4 })
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
    expect(compositor.last().lines).toEqual(["> "])
    expect(compositor.last().cursor).toEqual({ row: 0, col: 2 })
    ctrl.stop()
  })

  it("submit does NOT write to scrollback directly; it emits the rendered lines as a payload for the host to flush later (Bug 393)", () => {
    // Bug 393 background: when a turn is in flight, a fresh submit goes
    // into the host's queue. The OLD design eagerly wrote the prompt to
    // scrollback inside `EditorController.submit()`, so a queued prompt
    // appeared in BOTH places (scrollback AND the queue widget). The
    // NEW design: editor renders the prompt lines but does NOT write
    // them; it emits them as the second arg of the "submit" event, and
    // the host (runReplLiveArea) flushes them at TURN START or at
    // tool-boundary drain time. Net effect: a queued prompt only
    // appears in the queue widget until it's actually dequeued.
    const { ctrl, stdin, compositor } = make()
    const streamed: string[] = []
    ;(compositor as unknown as { writeStream: (s: string) => void }).writeStream = (s) => {
      streamed.push(s)
    }
    const submits: { text: string; commitLines: string[] }[] = []
    ctrl.on("submit", (text, commitLines) =>
      submits.push({ text, commitLines: commitLines ?? [] }),
    )
    ctrl.start()
    // Multiline submission via Shift+Enter (kitty CSI 13;2u) so we
    // exercise the full-buffer rendering path, not just the visible
    // viewport.
    stdin.send("line1")
    stdin.send("\x1b[13;2u")
    stdin.send("line2")
    stdin.send("\x1b[13;2u")
    stdin.send("line3")
    stdin.send("\r")
    // The editor must NOT have written the prompt to scrollback
    // itself : the only writeStream calls that happen here are the
    // live-area repaints (not direct scrollback commits), and our test
    // FakeCompositor's `writeStream` capture sees only the host-driven
    // ones. None of those bytes may be the rendered prompt commit.
    const scrollbackBytes = streamed.join("")
    expect(scrollbackBytes).not.toContain("\n\n> line1\n  line2\n  line3\n")
    // The submit event payload contains the lines for the host to flush.
    expect(submits.length).toBe(1)
    expect(submits[0].text).toBe("line1\nline2\nline3")
    expect(submits[0].commitLines).toEqual(["> line1", "  line2", "  line3"])
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
    expect(compositor.last().lines).toEqual(["> "])
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
    expect(compositor.last().lines).toEqual(["> hello world"])
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
    expect(compositor.last().lines).toEqual(["> line1", "  line2", "  line3"])
    stdin.send("\r")
    expect(submits).toEqual(["line1\nline2\nline3"])
    ctrl.stop()
  })

  it("setBuffer('') clears the buffer to an empty prompt", () => {
    const { ctrl, stdin, compositor } = make()
    ctrl.start()
    stdin.send("typed text")
    ctrl.setBuffer("")
    expect(compositor.last().lines).toEqual(["> "])
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
    expect(compositor.last().lines).toEqual(["> "])
    ctrl.stop()
  })

  it("Backspace deletes the previous char", () => {
    const { ctrl, stdin, compositor } = make()
    ctrl.start()
    stdin.send("ab")
    stdin.send("\x7f")
    expect(compositor.last().lines).toEqual(["> a"])
    ctrl.stop()
  })
})

describe("EditorController — status row", () => {
  it("setStatus(text) inserts status row + 2-blank gap above the editor", () => {
    const { ctrl, compositor } = make()
    ctrl.start()
    // Idle: just the editor row (no status row when empty).
    expect(compositor.last().lines).toEqual(["> "])
    compositor.liveHeightCalls.length = 0
    ctrl.setStatus("⠋ Thinking")
    // Status filled: [status, "", editor]. The 1 blank row between
    // status and editor is the user-requested visual gap (refined from
    // 2 → 1 in May 2026: 2 overshot, 1 is enough breathing room).
    expect(compositor.last().lines).toEqual(["⠋ Thinking", "", "> "])
    expect(compositor.last().cursor).toEqual({ row: 2, col: 2 })
    // Height grew from 1 (idle editor only) to 3 (status + 1 gap + editor).
    expect(compositor.liveHeightCalls).toContain(3)
    ctrl.stop()
  })

  it("setStatus(null) drops the status row and gap, editor goes back to row 0", () => {
    const { ctrl, compositor } = make()
    ctrl.start()
    ctrl.setStatus("busy")
    compositor.liveHeightCalls.length = 0
    ctrl.setStatus(null)
    // Idle layout restored: just the editor.
    expect(compositor.last().lines).toEqual(["> "])
    expect(compositor.last().cursor).toEqual({ row: 0, col: 2 })
    // Height shrank back to 1.
    expect(compositor.liveHeightCalls).toContain(1)
    ctrl.stop()
  })

  it("status row + gap coexists with multiline editor", () => {
    const { ctrl, stdin, compositor } = make()
    ctrl.start()
    stdin.send("a")
    stdin.send("\x1b[13;2u") // shift+enter
    stdin.send("b")
    ctrl.setStatus("⠋")
    // Layout: [status, "", editorLine1, editorLine2]
    expect(compositor.last().lines).toEqual(["⠋", "", "> a", "  b"])
    // editor cursor on row 3 (status row 0, gap row 1, editor rows 2..3)
    expect(compositor.last().cursor).toEqual({ row: 3, col: 3 })
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
    // Idle layout (no status): just the editor row (1 row) — 16 chars + "> " fits in 20 cols.
    expect(compositor.last().lines.length).toBe(1)

    output.columns = 10
    ctrl.notifyResize()

    // After reflow the editor wraps to multiple rows.
    expect(compositor.last().lines.length).toBeGreaterThan(1)
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
    // Cap at 3, idle (no status), no footer: full 3 rows for editor.
    // Layout: [indicator, editor-row, editor-row]. Cursor at L5; viewport
    // shows L4+L5 with indicator above ("^ 3 more lines").
    expect(compositor.last().lines[0]).toContain("more line")
    expect(compositor.last().lines[1]).toBe("  L4")
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
    // Idle (no status), no footer: full 3 rows for editor.
    // Layout: [indicator, editor-row, editor-row]. Cursor at "e".
    expect(compositor.last().lines[0]).toContain("more line")
    expect(compositor.last().lines[1]).toBe("  d")
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
    // maxLiveHeight=2, idle (no status), no footer → editorBudget=2.
    // Cursor on "c" (row 2 of 3 logical rows). Viewport shows b+c with
    // an indicator replacing one editor row, OR if budget allows, an
    // indicator above c. With budget=2 and viewportTop=2, layout is
    // [indicator, "  c"] (indicator replaces what would be "b" row).
    expect(compositor.last().lines[0]).toContain("more line")
    expect(compositor.last().lines[1]).toBe("  c")
    // Move cursor up twice → onto row 0 ("a"): window scrolls up.
    stdin.send("\x1b[A")
    stdin.send("\x1b[A")
    // Cursor at "a" (row 0), viewport scrolls to show "a". viewportTop=0 → no indicator.
    expect(compositor.last().lines).toEqual(["> a", "  b"])
    expect(compositor.last().cursor).toEqual({ row: 0, col: 3 })
    ctrl.stop()
  })

  it("status row + 1-gap count against the cap (cap=4 → editor window=2 → triggers indicator)", () => {
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new FakeCompositor()
    const ctrl = new EditorController({
      prompt: "> ",
      continuationPrompt: "  ",
      compositor: compositor as any,
      stdin: stdin as any,
      output: output as any,
      // 1 status + 2 gap + 2 editor + 1 indicator = 6.
      maxLiveHeight: 6,
    })
    ctrl.start()
    ctrl.setStatus("⠋")
    stdin.send("a")
    stdin.send("\x1b[13;2u")
    stdin.send("b")
    stdin.send("\x1b[13;2u")
    stdin.send("c")
    expect(compositor.liveHeight).toBe(4)
    // Layout: [status, "", indicator, editor-row].
    // 3 logical rows (a/b/c), editorBudget=2 → indicator + 1 content row.
    // Cursor at "c", viewportTop=2 > 0 → indicator "^ 2 more lines".
    expect(compositor.last().lines[0]).toBe("⠋")
    expect(compositor.last().lines[1]).toBe("")
    expect(compositor.last().lines[2]).toContain("more line")
    expect(compositor.last().lines[3]).toBe("  c")
    ctrl.stop()
  })
})

describe("EditorController — scroll indicator carries the prompt prefix", () => {
  // The "↑ N more lines" indicator lives in the live area and is the
  // ONLY visible row that can carry the prompt prefix while the buffer
  // is scrolled (visible content rows below it use the continuation
  // prompt, which has no mode info). The renderer's current prompt is
  // pulled fresh on every repaint, so SIGWINCH and `setPrompt()` both
  // reflect immediately.

  // Locate the indicator row by content rather than fixed index — the
  // layout above/below the indicator (status row, decoration rows,
  // status gap, footer spacer) drifts as the live area grows new
  // affordances. The indicator is uniquely identified by carrying the
  // "more line" label.
  function findIndicator(lines: string[]): string {
    const hit = lines.find((l) => l.includes("more line"))
    if (!hit) throw new Error(`no indicator row found; lines=${JSON.stringify(lines)}`)
    return hit
  }

  function makeScrolled(opts: { prompt?: string; columns?: number } = {}) {
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    if (opts.columns) output.columns = opts.columns
    const compositor = new FakeCompositor()
    const ctrl = new EditorController({
      prompt: opts.prompt ?? "> ",
      continuationPrompt: "  ",
      compositor: compositor as any,
      stdin: stdin as any,
      output: output as any,
      maxLiveHeight: 3,
    })
    ctrl.start()
    // Push 5 logical lines so the cursor is on row 4 and vTop > 0.
    stdin.send("a")
    stdin.send("\x1b[13;2u")
    stdin.send("b")
    stdin.send("\x1b[13;2u")
    stdin.send("c")
    stdin.send("\x1b[13;2u")
    stdin.send("d")
    stdin.send("\x1b[13;2u")
    stdin.send("e")
    return { ctrl, stdin, output, compositor }
  }

  it("default mode: indicator starts with the prompt prefix and fits the terminal width", () => {
    const { ctrl, compositor } = makeScrolled({ prompt: "> ", columns: 40 })
    const indicator = findIndicator(compositor.last().lines)
    expect(indicator.startsWith("> ")).toBe(true)
    expect(displayWidth(indicator)).toBeLessThanOrEqual(40)
    // Full form: dashes between prompt and label, with at least one ─.
    expect(indicator).toContain("\u2500")
    ctrl.stop()
  })

  it("ASK-mode prompt: indicator starts with `ASK ❯ ` when setPrompt is called while scrolled", () => {
    const { ctrl, compositor } = makeScrolled({ prompt: "> ", columns: 60 })
    // Switch to an ASK-style prefix while the buffer is scrolled.
    ctrl.setPrompt("ASK ❯ ", "  ")
    const indicator = findIndicator(compositor.last().lines)
    expect(indicator.startsWith("ASK ❯ ")).toBe(true)
    expect(displayWidth(indicator)).toBeLessThanOrEqual(60)
    ctrl.stop()
  })

  it("indicator re-renders on notifyResize: dash run shrinks as columns shrink", () => {
    const { ctrl, output, compositor } = makeScrolled({ prompt: "> ", columns: 80 })
    const before = findIndicator(compositor.last().lines)
    const beforeDashes = (before.match(/\u2500/g) ?? []).length
    output.columns = 40
    ctrl.notifyResize()
    const after = findIndicator(compositor.last().lines)
    const afterDashes = (after.match(/\u2500/g) ?? []).length
    // Same label, same prompt prefix; fewer dashes.
    expect(after.startsWith("> ")).toBe(true)
    expect(afterDashes).toBeLessThan(beforeDashes)
    expect(afterDashes).toBeGreaterThan(0)
    expect(displayWidth(after)).toBeLessThanOrEqual(40)
    ctrl.stop()
  })

  it("indicator re-renders on notifyResize: dash run grows as columns grow", () => {
    const { ctrl, output, compositor } = makeScrolled({ prompt: "> ", columns: 40 })
    const before = findIndicator(compositor.last().lines)
    const beforeDashes = (before.match(/\u2500/g) ?? []).length
    output.columns = 100
    ctrl.notifyResize()
    const after = findIndicator(compositor.last().lines)
    const afterDashes = (after.match(/\u2500/g) ?? []).length
    expect(after.startsWith("> ")).toBe(true)
    expect(afterDashes).toBeGreaterThan(beforeDashes)
    expect(displayWidth(after)).toBeLessThanOrEqual(100)
    ctrl.stop()
  })

  it("narrow width: indicator falls back to `<prompt><label>` when there's no room for dashes", () => {
    // prompt `> ` (width 2) + label `^ 4 more lines` (width 14) = 16 cells.
    // Full-form threshold is w >= promptW + labelW + 3 = 19. At w=17 we get
    // the no-dashes fallback: prompt directly followed by label.
    const { ctrl, compositor } = makeScrolled({ prompt: "> ", columns: 17 })
    const indicator = findIndicator(compositor.last().lines)
    expect(indicator.startsWith("> ")).toBe(true)
    expect(indicator).not.toContain("\u2500") // no dashes
    expect(displayWidth(indicator)).toBeLessThanOrEqual(17)
    ctrl.stop()
  })

  it("pathological width: indicator falls back to bare label when even the prompt + label cannot fit", () => {
    // prompt `ASK ❯ ` (width 6) + label `^ N more lines` (width 14) = 20.
    // At w=15 even `prompt + label` overflows → bare-label fallback with
    // a leading space (mirrors the pre-mode-aware behaviour).
    const { ctrl, compositor } = makeScrolled({ prompt: "ASK ❯ ", columns: 15 })
    const indicator = findIndicator(compositor.last().lines)
    expect(indicator.startsWith("ASK ❯ ")).toBe(false)
    expect(displayWidth(indicator)).toBeLessThanOrEqual(15)
    ctrl.stop()
  })
})

describe("EditorController — multiline & growth", () => {
  it("Shift+Enter (kitty CSI 13;2u) inserts a newline; live height grows to fit", () => {
    const { ctrl, stdin, compositor } = make()
    ctrl.start()
    // On start: ["> "] at height 1 (idle, no status). Reset call log.
    compositor.liveHeightCalls.length = 0
    stdin.send("a")
    stdin.send("\x1b[13;2u") // shift+enter (kitty)
    stdin.send("b")
    // 2 editor rows, no status (idle), no footer = height 2.
    expect(compositor.last().lines).toEqual(["> a", "  b"])
    expect(compositor.last().cursor).toEqual({ row: 1, col: 3 })
    expect(compositor.liveHeightCalls).toContain(2)
    ctrl.stop()
  })

  it("after submit, live height shrinks back to 1 (just the empty editor)", () => {
    const { ctrl, stdin, compositor } = make()
    ctrl.start()
    stdin.send("a")
    stdin.send("\x1b[13;2u")
    stdin.send("b")
    compositor.liveHeightCalls.length = 0
    stdin.send("\r")
    // Was height 2 (2 editor rows); after submit+clear, back to 1.
    expect(compositor.liveHeightCalls).toContain(1)
    ctrl.stop()
  })
})

describe("EditorController — footer rows (live-area slots)", () => {
  it("setFooterLines appends rows BELOW the editor content; cursor stays on the editor row", () => {
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setFooterLines(["quota 5h 12% · 7d 3%"])
    const last = compositor.last()!
    // Layout: [status, ...decoration, ...content, ...footer]
    // No status text so status row is empty (""), no decoration, 1 content row,
    // 1 footer row.
    expect(last.lines).toHaveLength(3)
    expect(last.lines[0]).toBe("") // empty status row
    expect(last.lines[1]).toContain("> ") // editor prompt
    expect(last.lines[2]).toBe("quota 5h 12% · 7d 3%") // footer
    // Cursor sits on the editor row — footer rows are below it.
    expect(last.cursor).not.toBeNull()
    expect(last.cursor!.row).toBe(1)
    ctrl.stop()
  })

  it("setFooterLines bumps liveHeight by the number of footer rows", () => {
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    const heightBefore = compositor.liveHeight
    ctrl.setFooterLines(["row1", "row2"])
    expect(compositor.liveHeight).toBe(heightBefore + 2)
    ctrl.setFooterLines(["row1"])
    expect(compositor.liveHeight).toBe(heightBefore + 1)
    ctrl.setFooterLines([])
    expect(compositor.liveHeight).toBe(heightBefore)
    ctrl.stop()
  })

  it("repaint is shallow-deduped (no setLiveArea call when content unchanged)", () => {
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setFooterLines(["same"])
    const before = compositor.liveAreaCalls.length
    ctrl.setFooterLines(["same"]) // identical → must not repaint
    expect(compositor.liveAreaCalls.length).toBe(before)
    ctrl.setFooterLines(["different"]) // change → must repaint
    expect(compositor.liveAreaCalls.length).toBeGreaterThan(before)
    ctrl.stop()
  })

  it("footer coexists with status, decoration, and gap, indicator without disturbing them", () => {
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setStatus("· thinking")
    ctrl.setDecorationLines(["queued: hi"])
    ctrl.setFooterLines(["quota 0%"])
    const last = compositor.last()!
    // Layout: [status, decoration, "", "", editor, "", footer]
    //   = 1 status + 1 decoration + 2 gap + 1 editor + 1 footer-spacer + 1 footer = 7 rows.
    expect(last.lines[0]).toContain("thinking")
    expect(last.lines[1]).toContain("queued: hi")
    expect(last.lines[2]).toBe("")
    expect(last.lines.at(-1)).toBe("quota 0%")
    expect(last.lines.at(-2)).toBe("") // footer spacer
    // Editor cursor row: status(1) + decoration(1) + gap(1) = 3.
    expect(last.cursor!.row).toBe(3)
    ctrl.stop()
  })

  it("setFooterLines([]) clears the footer (and its spacer)", () => {
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setFooterLines(["a", "b"])
    // Layout: [editor, "", "a", "b"] = 4 rows (idle, no status; 1 editor + 1 spacer + 2 footer).
    expect(compositor.last()!.lines.length).toBe(4)
    ctrl.setFooterLines([])
    // Layout: [editor] = 1 row.
    expect(compositor.last()!.lines.length).toBe(1)
    ctrl.stop()
  })
})

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
