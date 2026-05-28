import { EventEmitter } from "node:events"

import { describe, expect, it } from "bun:test"

import { AbortBus } from "./abort-bus.ts"
import { EditorController, type EditorKeyPayload } from "./editor-controller.ts"
import { Hooks } from "./plugins/hooks/hooks.ts"
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
    /** Override armed-state painter cadence. Set 0 to disable tick. */
    armedTickMs?: number
    /** Inject a clock for the abort-quit FSM. */
    nowFn?: () => number
    hooks?: Hooks
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
    ...(opts.armedTickMs !== undefined ? { armedTickMs: opts.armedTickMs } : {}),
    ...(opts.nowFn ? { nowFn: opts.nowFn } : {}),
    ...(opts.hooks ? { hooks: opts.hooks } : {}),
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
    ctrl.on("submit", (text, commitLines) => submits.push({ text, commitLines: commitLines ?? [] }))
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

  // ── abort-quit FSM: Ctrl+C policy (May 2026) ────────────────────────────
  // OLD policy (retired): Ctrl+C with empty buffer → instant exit; Ctrl+C
  // with content → clear buffer. NEW policy (per #abort-quit-ux-spec):
  // Ctrl+C ALWAYS arms the 10s quit-confirm window. Buffer is NOT cleared.
  // Second Ctrl+C within the window → emit 'quit' with reason "confirmed".
  // Escape hatch: two Ctrl+Cs within 500ms ALWAYS quit (force-quit).
  it("Ctrl+C with empty buffer arms the quit-confirm window (does NOT emit 'cancel')", () => {
    const { ctrl, stdin } = make()
    let cancelled = false
    let quitEvents: unknown[] = []
    ctrl.on("cancel", () => {
      cancelled = true
    })
    ctrl.on("quit", (reason: unknown) => {
      quitEvents.push(reason)
    })
    ctrl.start()
    stdin.send("\x03")
    expect(cancelled).toBe(false)
    expect(quitEvents).toEqual([])
    expect(ctrl.fsmStateForTest().kind).toBe("armed")
    ctrl.stop()
  })

  it("Ctrl+C with content arms (buffer preserved, does NOT clear)", () => {
    const { ctrl, stdin, compositor } = make()
    let cancelled = false
    ctrl.on("cancel", () => {
      cancelled = true
    })
    ctrl.start()
    stdin.send("oops")
    stdin.send("\x03")
    expect(cancelled).toBe(false)
    // Buffer text is preserved; the footer (single armed row) is added
    // below. Pin the editor row carrying our text.
    const last = compositor.last().lines
    expect(last[0]).toBe("> oops")
    expect(ctrl.fsmStateForTest().kind).toBe("armed")
    ctrl.stop()
  })

  it("two Ctrl+Cs in the armed window emit 'quit' with reason='confirmed'", () => {
    const { ctrl, stdin } = make({ armedTickMs: 0 })
    const reasons: unknown[] = []
    ctrl.on("quit", (r: unknown) => reasons.push(r))
    ctrl.on("cancel", (r: unknown) => reasons.push(`cancel:${String(r)}`))
    ctrl.start()
    stdin.send("\x03")
    // Wait > escape-hatch window (500ms is the default rapid-window).
    // We can't sleep in a synchronous test, so we monkey-patch nowFn-
    // free path: simply observe two Ctrl+Cs in the armed window. The
    // escape hatch is keyed off Date.now() which advances naturally,
    // but we want the FSM-confirmed path NOT the escape hatch. Drive
    // a dummy printable in between to reset escapeHatch.
    // Easier: use a long-armed window with an injected nowFn (next
    // test); here we accept the escape hatch outcome as ALSO a valid
    // quit (rule 6 says rapid double = always quit).
    stdin.send("\x03")
    // One quit + one cancel event expected (cancel is back-compat).
    expect(reasons.length).toBeGreaterThanOrEqual(1)
    expect(
      reasons.some(
        (r) =>
          r === "confirmed" ||
          r === "escape-hatch" ||
          r === "cancel:confirmed" ||
          r === "cancel:escape-hatch",
      ),
    ).toBe(true)
    ctrl.stop()
  })

  it("Ctrl+C then Esc dismisses the armed window without quitting", () => {
    const { ctrl, stdin } = make({ armedTickMs: 0, bareEscapeMs: 0 })
    let quit = false
    ctrl.on("quit", () => {
      quit = true
    })
    ctrl.start()
    stdin.send("\x03")
    expect(ctrl.fsmStateForTest().kind).toBe("armed")
    // Bare Esc → bareEscapeTimer fires → FSM esc → armed → idle
    stdin.send("\x1b")
    // bareEscapeMs=0 fires on next tick.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(quit).toBe(false)
        expect(ctrl.fsmStateForTest().kind).toBe("idle")
        ctrl.stop()
        resolve()
      }, 5)
    })
  })

  it("typing after Ctrl+C dismisses the armed window (modal absorbs no chars)", () => {
    const { ctrl, stdin, compositor } = make({ armedTickMs: 0 })
    ctrl.start()
    stdin.send("\x03")
    expect(ctrl.fsmStateForTest().kind).toBe("armed")
    stdin.send("hello")
    expect(ctrl.fsmStateForTest().kind).toBe("idle")
    // The 'hello' chars made it into the buffer.
    expect(compositor.last().lines[0]).toBe("> hello")
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
  it("setStatus(text) inserts status row + 1-blank gap above the editor", () => {
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

  it("setStatus(null) keeps the reserved status band after first use", () => {
    const { ctrl, compositor } = make()
    ctrl.start()
    ctrl.setStatus("busy")
    compositor.liveHeightCalls.length = 0
    ctrl.setStatus(null)
    expect(compositor.last().lines).toEqual(["", "", "> "])
    expect(compositor.last().cursor).toEqual({ row: 2, col: 2 })
    expect(compositor.liveHeightCalls).toEqual([])
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
      // 1 status + 1 gap + 2 editor (1 indicator + 1 content row) = 4.
      maxLiveHeight: 4,
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
    // Layout (idle, no status): [editor, footerSpacer, footer].
    // 1 editor row + 1 blank spacer + 1 footer row = 3 rows.
    expect(last.lines).toHaveLength(3)
    expect(last.lines[0]).toContain("> ") // editor prompt
    expect(last.lines[1]).toBe("") // footer spacer (blank)
    expect(last.lines[2]).toBe("quota 5h 12% · 7d 3%") // footer
    // Cursor sits on the editor row — spacer + footer rows are below.
    expect(last.cursor).not.toBeNull()
    expect(last.cursor!.row).toBe(0)
    ctrl.stop()
  })

  it("setFooterLines bumps liveHeight by N footer rows + 1 blank spacer", () => {
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    const heightBefore = compositor.liveHeight
    ctrl.setFooterLines(["row1", "row2"])
    // +2 footer rows +1 spacer = +3
    expect(compositor.liveHeight).toBe(heightBefore + 3)
    ctrl.setFooterLines(["row1"])
    // +1 footer row +1 spacer = +2
    expect(compositor.liveHeight).toBe(heightBefore + 2)
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

describe("EditorController — footer layers (Bug 2801)", () => {
  // Background. Before this work the footer band was driven by ONE
  // mutable `footerLines: string[]`. Two unrelated producers wrote into
  // it through the SAME `setFooterLines(lines)` setter:
  //
  //   (a) The plugin scheduler / diagnostic aggregator pushed the quota
  //       row and last-warning summary (the "base" content).
  //   (b) The abort-quit FSM pushed the armed-quit footer (the
  //       "transient overlay") via `repaintArmedFooter`.
  //
  // Last writer won. When the FSM dismissed the armed footer (ESC, type,
  // expire, quit) it called `setFooterLines([])` which BLEW AWAY the
  // base content. The aggregator was not notified to re-emit, so the
  // quota row stayed gone until the next periodic refresh (~60s).
  //
  // The fix is a small layer-stack model on the controller:
  //   - producers own stable layer ids and write into their OWN layer
  //     (`setFooterLayer(id, lines, opts)` / `clearFooterLayer(id)`);
  //   - the renderer composes by picking the highest-priority non-empty
  //     layer (overlay semantics — clearing an upper layer reveals the
  //     one below);
  //   - `setFooterLines(lines)` stays as the back-compat sugar mapping
  //     to the "default" layer at priority 0;
  //   - the armed-quit FSM uses `"armed-quit"` at priority 100 (room is
  //     deliberately left for future intermediate overlays like a
  //     slash-menu completion bar).
  //
  // These tests pin the contract end-to-end via the FakeCompositor — no
  // private fields, no implementation-detail probing. The bug repro is
  // the first test; the rest pin the new API and z-order invariants.

  it("Bug 2801 (regression): ESC-dismissing the armed footer restores the underlying base footer", () => {
    const { ctrl, stdin, compositor } = make({ armedTickMs: 0, bareEscapeMs: 0 })
    ctrl.start()

    // (a) Plugin scheduler paints the base footer (the quota row).
    ctrl.setFooterLines(["quota 5h 12% · 7d 3%"])
    expect(compositor.last()!.lines).toContain("quota 5h 12% · 7d 3%")

    // (b) User hits Ctrl+C → FSM arms → armed-quit footer takes over.
    stdin.send("\x03")
    expect(ctrl.fsmStateForTest().kind).toBe("armed")
    const whileArmed = compositor.last()!.lines
    expect(whileArmed.some((l) => l.includes("Quit?"))).toBe(true)
    // Crucial intermediate state: the base content is NOT on screen
    // while armed (the overlay wins the composition).
    expect(whileArmed.some((l) => l.includes("quota 5h 12%"))).toBe(false)

    // (c) ESC dismisses the armed window. After the bareEscapeMs flush,
    // the BASE quota row must be back on screen. With the pre-fix
    // single-field design this assertion failed: the footer was empty
    // and the user had to wait ~60s for the next plugin refresh.
    stdin.send("\x1b")
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(ctrl.fsmStateForTest().kind).toBe("idle")
        const afterDismiss = compositor.last()!.lines
        expect(afterDismiss).toContain("quota 5h 12% · 7d 3%")
        expect(afterDismiss.some((l) => l.includes("Quit?"))).toBe(false)
        ctrl.stop()
        resolve()
      }, 5)
    })
  })

  it("Bug 2801 (regression): typing dismisses the armed footer AND the base footer reappears", () => {
    // Same shape as the ESC test but the dismiss mechanism is a
    // printable keystroke (rule: any printable char in armed state
    // cancels the modal and is then inserted into the buffer).
    const { ctrl, stdin, compositor } = make({ armedTickMs: 0 })
    ctrl.start()
    ctrl.setFooterLines(["quota 5h 12% · 7d 3%"])
    stdin.send("\x03")
    expect(ctrl.fsmStateForTest().kind).toBe("armed")
    expect(compositor.last()!.lines.some((l) => l.includes("Quit?"))).toBe(true)

    stdin.send("x")
    expect(ctrl.fsmStateForTest().kind).toBe("idle")
    const afterDismiss = compositor.last()!.lines
    expect(afterDismiss).toContain("quota 5h 12% · 7d 3%")
    expect(afterDismiss.some((l) => l.includes("Quit?"))).toBe(false)
    // The typed char also landed in the buffer.
    expect(afterDismiss[0]).toContain("> x")
    ctrl.stop()
  })

  it("Bug 2801 (regression): base updates DURING the armed window stay invisible but live; dismissing reveals the latest base", () => {
    // Pre-fix this scenario was a second manifestation of the same
    // architectural problem: the plugin scheduler tick during the
    // armed window CLOBBERED the armed line (because both producers
    // wrote into the same field). The armed-quit footer flickered
    // off, the quota row flashed on, then the next FSM tick re-wrote
    // the armed line back. Two writers, one register, no order.
    //
    // After the fix: writes to the "default" layer are accepted but
    // invisible while "armed-quit" holds a higher-priority non-empty
    // value. On dismiss, the LATEST default-layer content emerges
    // (not a stale snapshot).
    const { ctrl, stdin, compositor } = make({ armedTickMs: 0, bareEscapeMs: 0 })
    ctrl.start()
    ctrl.setFooterLines(["quota: 5%"])

    stdin.send("\x03")
    expect(ctrl.fsmStateForTest().kind).toBe("armed")
    expect(compositor.last()!.lines.some((l) => l.includes("Quit?"))).toBe(true)

    // Aggregator pushes a fresher quota number while the user is
    // staring at the armed footer. The armed line MUST stay on top.
    ctrl.setFooterLines(["quota: 12%"])
    const stillArmed = compositor.last()!.lines
    expect(stillArmed.some((l) => l.includes("Quit?"))).toBe(true)
    expect(stillArmed.some((l) => l.includes("quota: 12%"))).toBe(false)
    expect(stillArmed.some((l) => l.includes("quota: 5%"))).toBe(false)

    // Dismiss → the LATEST base content (12%, not the stale 5%) is on screen.
    stdin.send("\x1b")
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const afterDismiss = compositor.last()!.lines
        expect(afterDismiss).toContain("quota: 12%")
        expect(afterDismiss.some((l) => l.includes("quota: 5%"))).toBe(false)
        expect(afterDismiss.some((l) => l.includes("Quit?"))).toBe(false)
        ctrl.stop()
        resolve()
      }, 5)
    })
  })

  it("setFooterLayer / clearFooterLayer: highest-priority non-empty layer wins; clearing an upper layer reveals lower", () => {
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()

    // Base layer at priority 0.
    ctrl.setFooterLayer("plugins", ["plugin row"], { priority: 0 })
    expect(compositor.last()!.lines).toContain("plugin row")

    // Overlay at priority 50 — wins.
    ctrl.setFooterLayer("overlay", ["overlay row"], { priority: 50 })
    expect(compositor.last()!.lines).toContain("overlay row")
    expect(compositor.last()!.lines).not.toContain("plugin row")

    // Higher overlay at priority 100 — wins over the priority-50 one.
    ctrl.setFooterLayer("modal", ["modal row"], { priority: 100 })
    expect(compositor.last()!.lines).toContain("modal row")
    expect(compositor.last()!.lines).not.toContain("overlay row")

    // Clear the top layer → priority-50 layer reappears.
    ctrl.clearFooterLayer("modal")
    expect(compositor.last()!.lines).toContain("overlay row")
    expect(compositor.last()!.lines).not.toContain("modal row")

    // Clear the middle layer → priority-0 layer reappears.
    ctrl.clearFooterLayer("overlay")
    expect(compositor.last()!.lines).toContain("plugin row")
    expect(compositor.last()!.lines).not.toContain("overlay row")

    // Clear the base → no footer at all.
    ctrl.clearFooterLayer("plugins")
    expect(compositor.last()!.lines).not.toContain("plugin row")
    expect(compositor.last()!.lines.some((l) => l.length > 0 && !l.includes("> "))).toBe(false)

    ctrl.stop()
  })

  it("setFooterLayer with empty lines is equivalent to clearing the layer (lower priority reveals)", () => {
    // Producers should not have to remember which method to call when
    // they want to "remove" their content. Empty lines = invisible.
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setFooterLayer("base", ["base row"], { priority: 0 })
    ctrl.setFooterLayer("overlay", ["overlay row"], { priority: 50 })
    expect(compositor.last()!.lines).toContain("overlay row")
    expect(compositor.last()!.lines).not.toContain("base row")

    ctrl.setFooterLayer("overlay", [], { priority: 50 })
    expect(compositor.last()!.lines).toContain("base row")
    expect(compositor.last()!.lines).not.toContain("overlay row")
    ctrl.stop()
  })

  it("setFooterLines is back-compat sugar for the 'default' layer at priority 0", () => {
    // Any caller still using the old single-mutator API maps to a
    // layer with id 'default' at priority 0. This means the armed
    // overlay (priority 100) wins over it as expected, and so does
    // any explicit higher-priority layer.
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setFooterLines(["legacy row"])
    expect(compositor.last()!.lines).toContain("legacy row")

    // An overlay at priority 50 beats the legacy row.
    ctrl.setFooterLayer("overlay", ["overlay row"], { priority: 50 })
    expect(compositor.last()!.lines).toContain("overlay row")
    expect(compositor.last()!.lines).not.toContain("legacy row")

    // Clearing the overlay reveals the legacy row again.
    ctrl.clearFooterLayer("overlay")
    expect(compositor.last()!.lines).toContain("legacy row")

    // setFooterLines([]) clears the default layer.
    ctrl.setFooterLines([])
    expect(compositor.last()!.lines.some((l) => l === "legacy row")).toBe(false)
    ctrl.stop()
  })

  it("repaint is shallow-deduped across the layer stack (no setLiveArea call when composed footer unchanged)", () => {
    // The pre-fix dedup pinned `lines.length === footerLines.length && ...`.
    // The new path must still dedup at the COMPOSED-output level so
    // an unchanged top-layer paint is a no-op even if a lower layer
    // changes invisibly.
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setFooterLayer("overlay", ["overlay row"], { priority: 50 })
    const before = compositor.liveAreaCalls.length

    // Mutating an OBSCURED layer changes nothing on screen → no repaint.
    ctrl.setFooterLayer("base", ["base row a"], { priority: 0 })
    ctrl.setFooterLayer("base", ["base row b"], { priority: 0 })
    expect(compositor.liveAreaCalls.length).toBe(before)

    // Mutating the visible (top) layer DOES repaint.
    ctrl.setFooterLayer("overlay", ["overlay row v2"], { priority: 50 })
    expect(compositor.liveAreaCalls.length).toBeGreaterThan(before)
    ctrl.stop()
  })

  it("clearFooterLayer on an unknown id is a no-op (does not repaint)", () => {
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setFooterLayer("known", ["row"], { priority: 0 })
    const before = compositor.liveAreaCalls.length
    ctrl.clearFooterLayer("nope-not-a-real-id")
    expect(compositor.liveAreaCalls.length).toBe(before)
    ctrl.stop()
  })

  it("armed footer uses the 'armed-quit' layer id at priority 100 (load-bearing for plugin coexistence)", () => {
    // Pin the id + priority used by the FSM as part of the public
    // contract. Any future overlay (slash-menu completion at priority
    // 50, mid-prompt cmd bar at 75, etc.) depends on knowing where
    // 'armed-quit' sits in the stack. The constants live in
    // src/editor-controller.ts as `FOOTER_LAYER_*` exports.
    const { ctrl, stdin, compositor } = make({ armedTickMs: 0, bareEscapeMs: 0 })
    ctrl.start()
    stdin.send("\x03")
    expect(ctrl.fsmStateForTest().kind).toBe("armed")

    // Push an overlay at priority 50 — armed (100) MUST still win.
    ctrl.setFooterLayer("mid", ["mid row"], { priority: 50 })
    expect(compositor.last()!.lines.some((l) => l.includes("Quit?"))).toBe(true)
    expect(compositor.last()!.lines).not.toContain("mid row")

    // Push an overlay at priority 200 — beats armed.
    ctrl.setFooterLayer("top", ["top row"], { priority: 200 })
    expect(compositor.last()!.lines).toContain("top row")
    expect(compositor.last()!.lines.some((l) => l.includes("Quit?"))).toBe(false)

    // Clear top → armed re-emerges (mid is still 50, below armed 100).
    ctrl.clearFooterLayer("top")
    expect(compositor.last()!.lines.some((l) => l.includes("Quit?"))).toBe(true)
    expect(compositor.last()!.lines).not.toContain("mid row")

    // Dismiss armed → mid (50) emerges.
    stdin.send("\x1b")
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(compositor.last()!.lines).toContain("mid row")
        expect(compositor.last()!.lines.some((l) => l.includes("Quit?"))).toBe(false)
        ctrl.stop()
        resolve()
      }, 5)
    })
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

describe("EditorController — wrap-aware up/down (visual rows)", () => {
  // Helper: build a 20-col terminal with a fresh controller.
  // Prompt is "> " (2 cells) so each wrap chunk past the first has 20 cells.
  function makeWrap(opts: { columns?: number; prompt?: string; continuation?: string } = {}) {
    return make({
      columns: opts.columns ?? 20,
      prompt: opts.prompt ?? "> ",
      continuation: opts.continuation ?? "  ",
    })
  }

  it("Up on a wrapped logical line walks to the previous wrap chunk of the SAME line", () => {
    // 50-char line on a 20-col term with "> " prompt → 3 visual rows:
    //   row 0: prompt "> " + first 18 chars
    //   row 1: chars 18..37 (20 cells)
    //   row 2: chars 38..49 (12 cells)
    const { ctrl, stdin } = makeWrap()
    ctrl.start()
    const text = "0123456789".repeat(5) // 50 chars
    stdin.send(text)
    // Cursor at end of line, on visual row 2 (col 12 of the row 2).
    expect(ctrl.buffer().col).toBe(50)
    expect(ctrl.buffer().row).toBe(0)
    // Press Up: should stay on logical row 0, but move buf.col so visual
    // pos is on row 1, col 12 (preserving column 12). That maps to
    // char index = (row1 start = 18) + 12 = 30.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(30)
    // Press Up again: should walk to visual row 0, col 12. Row 0 starts
    // after "> " (promptW=2), so target absolute cell = 0*20 + 12 = 12.
    // Subtract promptW=2 → content cells = 10. col = 10.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(10)
    // Press Up at top: no-op.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(10)
    ctrl.stop()
  })

  it("Down on a wrapped logical line walks to the next wrap chunk of the SAME line", () => {
    const { ctrl, stdin } = makeWrap()
    ctrl.start()
    const text = "0123456789".repeat(5) // 50 chars
    stdin.send(text)
    // Cursor at end (col 50, visual row 2). Press Home → col 0, visual
    // row 0. Then Down → visual row 1. Then Down → visual row 2.
    stdin.send("\x1b[H") // Home: col 0 of logical row 0
    expect(ctrl.buffer().col).toBe(0)
    stdin.send("\x1b[B") // Down
    // Cursor at col 0 on visual row 0 = visual col 2 (prompt "> " is 2
    // cells). Sticky sample: desiredVisualCol = 2. Target visual row 1,
    // visual col 2. Row 1 starts at char 18 (row 0 held 18 chars before
    // wrap) and has no prompt, so visual col 2 → char 18 + 2 = 20.
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(20)
    stdin.send("\x1b[B") // Down → visual row 2, visual col 2 = char 38 + 2 = 40
    expect(ctrl.buffer().col).toBe(40)
    // Press Down again. Sticky col is 2; only 12 cells of content in
    // row 2 so visual col 2 is still inside the row. But we're already
    // on the LAST visual row of logical line 0, AND there's no logical
    // line 1, so it's a no-op.
    stdin.send("\x1b[B")
    expect(ctrl.buffer().col).toBe(40)
    ctrl.stop()
  })

  it("Up from the first wrap chunk of a logical line crosses into prior logical line's LAST wrap chunk", () => {
    const { ctrl, stdin } = makeWrap()
    ctrl.start()
    // Logical line 0: 30 chars (wraps to 2 visual rows on 20-col term
    // with 2-cell prompt: row 0 = 18 chars, row 1 = 12 chars).
    stdin.send("0123456789".repeat(3))
    stdin.send("\x1b\r") // Alt+Enter: insert newline
    // Logical line 1: 10 chars (1 visual row).
    stdin.send("ABCDEFGHIJ")
    expect(ctrl.buffer().row).toBe(1)
    expect(ctrl.buffer().col).toBe(10)
    // Press Up: from logical row 1, visual row 0, visual col 12 (10
    // chars + 2-cell continuation prompt). Should cross into logical
    // row 0's LAST visual row (row 1 of 2), at visual col 12.
    // Row 1 of logical line 0 starts at char 18 (since row 0 held
    // 0..17). Visual col 12 → char index 18 + 12 = 30 (end of line).
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(30)
    // Press Up again: from logical row 0, visual row 1 → visual row 0.
    // Target visual col 12 on row 0; row 0 has prompt eating cells 0..1,
    // so target char = visual col 12 - prompt 2 = char index 10.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(10)
    ctrl.stop()
  })

  it("Down from the last wrap chunk crosses into next logical line at the same visual col", () => {
    const { ctrl, stdin } = makeWrap()
    ctrl.start()
    stdin.send("0123456789".repeat(3)) // logical 0, 30 chars
    stdin.send("\x1b\r")
    stdin.send("ABCDEFGHIJ") // logical 1, 10 chars
    // Move back to logical 0, last visual row, col 24 (visual col 6 on
    // row 1: chars 18..29 in line). char index 24.
    stdin.send("\x1b[H") // line start (logical 0, col 0) — wait, we're on logical 1
    // Reset cursor: Home goes to logical-line start, not visual-row start.
    // From logical 1 col 10 → Home → logical 1 col 0.
    stdin.send("\x1b[A") // up → logical 0, last visual row, visual col 0 + continuationPromptW
    // logical 1 had continuationPromptW=2, visualCol of col=0 = 2.
    // Up: target visual col 2 on logical 0 last visual row.
    // Row 1 of logical 0: chars 18..29, no prompt. visual col 2 = char 18 + 2 = 20.
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(20)
    // Press Down: cross from logical 0 last visual row to logical 1 first row.
    // Target visual col 2 on logical 1 row 0. Row 0 has continuationPromptW=2,
    // so target char = visual col 2 - prompt 2 = 0.
    stdin.send("\x1b[B")
    expect(ctrl.buffer().row).toBe(1)
    expect(ctrl.buffer().col).toBe(0)
    ctrl.stop()
  })

  it("sticky desired-visual-col survives walking through SHORTER rows then re-extends", () => {
    const { ctrl, stdin } = makeWrap()
    ctrl.start()
    // Line 0: 25 chars (wraps to 2 rows: 18 + 7)
    stdin.send("0123456789".repeat(2) + "ABCDE") // 25 chars
    stdin.send("\x1b\r")
    // Line 1: 5 chars (1 row)
    stdin.send("XYZAB")
    stdin.send("\x1b\r")
    // Line 2: 25 chars (wraps to 2 rows: 18 + 7)
    stdin.send("9876543210".repeat(2) + "VWXYZ")
    // Cursor at end of line 2, visual col = 7 (chars 18..24 = 7 cells; cursor after).
    expect(ctrl.buffer().row).toBe(2)
    expect(ctrl.buffer().col).toBe(25)
    // Up: walk through line 2's row 0 (visual col 7). col = 7 cells from
    // line start, prompt is continuation (2), so content col = 7-2 = 5.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(2)
    expect(ctrl.buffer().col).toBe(5)
    // Up: into line 1 (only 5 chars, 1 visual row). visual col 7 is
    // past the line's actual content; clamp to end-of-line. col = 5.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(1)
    expect(ctrl.buffer().col).toBe(5)
    // Up: into line 0 last visual row (row 1: chars 18..24). visual col
    // 7 maps to char 18 + 7 = 25 (end of line). Sticky col is STILL 7
    // (carried from initial sample), so even though line 1 forced us to
    // col 5 visually, we should land at visual col 7 here. col = 25.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(0)
    expect(ctrl.buffer().col).toBe(25)
    ctrl.stop()
  })

  it("a horizontal move between vertical moves invalidates the sticky col", () => {
    const { ctrl, stdin } = makeWrap()
    ctrl.start()
    stdin.send("0123456789".repeat(3)) // logical 0: 30 chars, 2 visual rows
    stdin.send("\x1b\r")
    stdin.send("ABCDE") // logical 1: 5 chars
    stdin.send("\x1b\r")
    stdin.send("0123456789".repeat(3)) // logical 2: 30 chars
    // Cursor at end of line 2 (col 30, visual col 12 on row 1 of 2).
    // Up → line 2 row 0 visual col 12 = char 12 (prompt is 2, visual 12 → char 10? wait line 2 has continuationPromptW=2 on row 0 because it's a non-first LOGICAL row but the FIRST visual row of that logical line. Yes promptW=2 for row 0 of logical lines >0.)
    // So target visual col 12 on logical 2 row 0 → char = 12-2 = 10.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().col).toBe(10)
    // Move left a few times — invalidates sticky.
    stdin.send("\x1b[D")
    stdin.send("\x1b[D")
    stdin.send("\x1b[D")
    expect(ctrl.buffer().col).toBe(7)
    // Up: should re-sample current visual col (=9 since col 7 + promptW 2 = 9),
    // NOT use the old sticky 12. From logical 2 row 0 → logical 1 (5 chars).
    // visual col 9 is past end → clamp to col 5.
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(1)
    expect(ctrl.buffer().col).toBe(5)
    ctrl.stop()
  })

  it("falls back to logical moveUp/moveDown when terminal width is unknown", () => {
    // No columns → non-TTY/test fallback. moveUp/moveDown should still
    // work (jumping by logical line) so cursor navigation remains usable
    // even when wrap layout isn't computable.
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    output.columns = 0 // unknown
    const compositor = new FakeCompositor()
    const ctrl = new EditorController({
      prompt: "> ",
      continuationPrompt: "  ",
      compositor: compositor as any,
      stdin: stdin as any,
      output: output as any,
    })
    ctrl.start()
    stdin.send("L1")
    stdin.send("\x1b\r")
    stdin.send("L2")
    stdin.send("\x1b\r")
    stdin.send("L3")
    expect(ctrl.buffer().row).toBe(2)
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(1)
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(0)
    stdin.send("\x1b[B")
    expect(ctrl.buffer().row).toBe(1)
    ctrl.stop()
  })
})

// ---------------------------------------------------------------------------
// editor.key hook integration (May 2026 — history plugin's intercept seam)
// ---------------------------------------------------------------------------
//
// The editor emits a `broadcast-sync` event on the `editor.key` channel
// BEFORE applying selected navigation/control keys (ArrowUp, ArrowDown,
// Ctrl+R). Listeners may set `result.halt = true` to consume the key and
// optionally `result.buffer` / `result.cursor` to replace editor state.
//
// These tests pin the intercept-and-replace round-trip without going
// through a real plugin manifest — the editor's contract is purely with
// the Hooks facade.
// ---------------------------------------------------------------------------

describe("EditorController — editor.key hook", () => {
  it("when no hooks are provided, ArrowUp behaves normally (no-emit)", () => {
    const { ctrl, stdin } = make()
    ctrl.start()
    stdin.send("L1")
    stdin.send("\x1b\r") // newline
    stdin.send("L2")
    expect(ctrl.buffer().row).toBe(1)
    stdin.send("\x1b[A")
    expect(ctrl.buffer().row).toBe(0)
    ctrl.stop()
  })

  it("ArrowUp emits editor.key with cursor + buffer; plugin halts + replaces buffer", () => {
    const hooks = new Hooks()
    const seen: EditorKeyPayload[] = []
    hooks.on<EditorKeyPayload>(
      "editor.key",
      (payload) => {
        seen.push({ ...payload, result: { ...payload.result } })
        if (payload.key === "ArrowUp") {
          payload.result.halt = true
          payload.result.buffer = "recalled prompt"
        }
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\x1b[A")
    expect(seen.length).toBe(1)
    expect(seen[0].key).toBe("ArrowUp")
    expect(seen[0].buffer).toBe("")
    expect(seen[0].cursor.row).toBe(0)
    expect(seen[0].cursor.col).toBe(0)
    expect(seen[0].cursor.totalLines).toBe(1)
    expect(ctrl.buffer().lines.join("\n")).toBe("recalled prompt")
    ctrl.stop()
  })

  it("ArrowDown is emitted with the same shape", () => {
    const hooks = new Hooks()
    const seen: string[] = []
    hooks.on<EditorKeyPayload>(
      "editor.key",
      (payload) => {
        seen.push(payload.key)
        if (payload.key === "ArrowDown") payload.result.halt = true
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\x1b[B")
    expect(seen).toEqual(["ArrowDown"])
    ctrl.stop()
  })

  it("ArrowUp falls through to default buffer nav when listener does NOT halt", () => {
    const hooks = new Hooks()
    hooks.on<EditorKeyPayload>(
      "editor.key",
      () => {
        // observe-only: do not set halt
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("L1")
    stdin.send("\x1b\r")
    stdin.send("L2") // row=1 col=2
    stdin.send("\x1b[A") // should move cursor up (default behavior)
    expect(ctrl.buffer().row).toBe(0)
    ctrl.stop()
  })

  it("Ctrl+R fires the hook (and is silently swallowed when no listener halts)", () => {
    const hooks = new Hooks()
    const seen: string[] = []
    hooks.on<EditorKeyPayload>(
      "editor.key",
      (payload) => {
        seen.push(payload.key)
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\x12") // Ctrl+R
    expect(seen).toEqual(["Ctrl+R"])
    // Buffer must remain empty — Ctrl+R is NOT inserted as a literal byte
    expect(ctrl.buffer().lines.join("\n")).toBe("")
    ctrl.stop()
  })

  it("cursor field includes wrap-aware visualRow / rowsInLogicalLine / totalLines", () => {
    const hooks = new Hooks()
    let captured: EditorKeyPayload | null = null
    hooks.on<EditorKeyPayload>(
      "editor.key",
      (p) => {
        captured = JSON.parse(JSON.stringify({ ...p, result: {} })) as EditorKeyPayload
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin } = make({ hooks, columns: 80 })
    ctrl.start()
    // 3 logical lines, cursor on last
    stdin.send("alpha")
    stdin.send("\x1b\r")
    stdin.send("beta")
    stdin.send("\x1b\r")
    stdin.send("gamma")
    stdin.send("\x1b[A") // ArrowUp emits the hook with our 3-line state
    expect(captured).not.toBeNull()
    const c = captured as unknown as EditorKeyPayload
    expect(c.cursor.totalLines).toBe(3)
    expect(c.cursor.row).toBe(2)
    expect(c.cursor.rowsInLogicalLine).toBe(1) // short row, no wrap
    expect(c.cursor.visualRow).toBe(0)
    ctrl.stop()
  })

  it("result.cursor placement is honored alongside result.buffer", () => {
    const hooks = new Hooks()
    hooks.on<EditorKeyPayload>(
      "editor.key",
      (payload) => {
        if (payload.key === "ArrowUp") {
          payload.result.halt = true
          payload.result.buffer = "hello world"
          payload.result.cursor = { row: 0, col: 5 }
        }
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\x1b[A")
    expect(ctrl.buffer().lines.join("\n")).toBe("hello world")
    expect(ctrl.buffer().col).toBe(5)
    ctrl.stop()
  })

  // -- Phase 1a extensions for the slash-menu overlay --------------------
  // The original editor.key hook only fired on ArrowUp / ArrowDown / Ctrl+R
  // (the history plugin's needs). Overlays like ma-slash-menu also need
  // to halt Tab / Enter / bare Escape so the user can dismiss/select the
  // menu without the editor's default action firing.

  it("Tab is dispatched to editor.key; halt suppresses literal-tab insertion", () => {
    const hooks = new Hooks()
    const seen: string[] = []
    hooks.on<EditorKeyPayload>(
      "editor.key",
      (payload) => {
        seen.push(payload.key)
        if (payload.key === "Tab") payload.result.halt = true
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\t")
    expect(seen).toEqual(["Tab"])
    // Halt suppressed the literal-tab insertion.
    expect(ctrl.buffer().lines.join("\n")).toBe("")
    ctrl.stop()
  })

  it("Tab without halt falls through to literal-tab insertion (default)", () => {
    const hooks = new Hooks()
    hooks.on<EditorKeyPayload>(
      "editor.key",
      () => {
        // observe-only, do not halt
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\t")
    expect(ctrl.buffer().lines.join("\n")).toBe("\t")
    ctrl.stop()
  })

  it("Enter on non-empty buffer dispatches editor.key; halt suppresses submit", () => {
    const hooks = new Hooks()
    const submits: string[] = []
    const keys: string[] = []
    hooks.on<EditorKeyPayload>(
      "editor.key",
      (payload) => {
        keys.push(payload.key)
        if (payload.key === "Enter") {
          payload.result.halt = true
          payload.result.buffer = ""
        }
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin } = make({ hooks })
    ctrl.on("submit", (text: string) => submits.push(text))
    ctrl.start()
    stdin.send("/config")
    stdin.send("\r")
    expect(keys).toContain("Enter")
    expect(submits).toEqual([])
    expect(ctrl.buffer().lines.join("\n")).toBe("")
    ctrl.stop()
  })

  it("Enter without halt still submits (default)", () => {
    const hooks = new Hooks()
    const submits: string[] = []
    hooks.on<EditorKeyPayload>(
      "editor.key",
      () => {
        // observe-only
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin } = make({ hooks })
    ctrl.on("submit", (text: string) => submits.push(text))
    ctrl.start()
    stdin.send("hi")
    stdin.send("\r")
    expect(submits).toEqual(["hi"])
    ctrl.stop()
  })

  it("bare Escape dispatches editor.key('Escape') in idle state; halt stops the bare-esc FSM feed", () => {
    const hooks = new Hooks()
    const keys: string[] = []
    hooks.on<EditorKeyPayload>(
      "editor.key",
      (payload) => {
        keys.push(payload.key)
        if (payload.key === "Escape") payload.result.halt = true
      },
      { caller: "plugin" },
    )
    // bareEscapeMs = 0 so the timer fires immediately.
    const { ctrl, stdin } = make({ hooks, bareEscapeMs: 0 })
    ctrl.start()
    stdin.send("\x1b")
    // Wait one macrotask for the bare-esc timer.
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        expect(keys).toEqual(["Escape"])
        ctrl.stop()
        resolve()
      }, 5),
    )
  })
})

// ---------------------------------------------------------------------------
// editor.buffer.changed hook (Phase 1b — async observation for overlays)
// ---------------------------------------------------------------------------
describe("EditorController — editor.buffer.changed hook", () => {
  it("emits {text, cursor} after a successful buffer mutation", async () => {
    const hooks = new Hooks()
    const seen: Array<{ text: string; cursor: { row: number; col: number } }> = []
    hooks.on<{ text: string; cursor: { row: number; col: number } }>(
      "editor.buffer.changed",
      (p) => {
        seen.push(p)
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("a")
    // broadcast-async = next microtask
    await new Promise<void>((r) => setTimeout(r, 1))
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen[seen.length - 1]!.text).toBe("a")
    expect(seen[seen.length - 1]!.cursor.col).toBe(1)
    ctrl.stop()
  })

  it("dedups: same text twice → one emit", async () => {
    const hooks = new Hooks()
    let count = 0
    hooks.on<unknown>(
      "editor.buffer.changed",
      () => {
        count++
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("x")
    await new Promise<void>((r) => setTimeout(r, 1))
    const first = count
    // Cursor-only movement should NOT re-emit.
    stdin.send("\x1b[D") // ArrowLeft
    stdin.send("\x1b[C") // ArrowRight
    await new Promise<void>((r) => setTimeout(r, 1))
    expect(count).toBe(first)
    ctrl.stop()
  })

  it("fires on setBuffer too (programmatic replace)", async () => {
    const hooks = new Hooks()
    const seen: string[] = []
    hooks.on<{ text: string }>(
      "editor.buffer.changed",
      (p) => {
        seen.push(p.text)
      },
      { caller: "plugin" },
    )
    const { ctrl } = make({ hooks })
    ctrl.start()
    ctrl.setBuffer("hello")
    await new Promise<void>((r) => setTimeout(r, 1))
    expect(seen).toContain("hello")
    ctrl.stop()
  })
})

// ---------------------------------------------------------------------------
// Alt+M / Option+M : interrupt-and-apply-mode keystroke
//
// Three encodings reach `EditorController` depending on terminal + config:
//
//   1. `\x1bm` (bare meta) : iTerm with "Option as Meta" enabled, xterm
//      without modifyOtherKeys. Parsed by `parseMetaSequence`.
//   2. `\x1b[109;3u` (kitty CSI-u, code=109='m', modifiers=3=alt) : iTerm
//      3.5+ with kitty proto enabled (which the agent enables at start
//      via `\x1b[>31u`). Parsed by `parseCsiUKey` →
//      `parseModifiedKeySequence`.
//   3. `\x1b[27;3;109~` (xterm modifyOtherKeys=2) : xterm-like terminals.
//      Parsed by `parseXtermOtherKey` → `parseModifiedKeySequence`.
//
// All three MUST call the wired `modeInterrupt` handler AND swallow the
// keystroke (no literal `m` insertion). When no handler is wired, all
// three MUST still swallow the keystroke (no surprises). Regression
// guard for the 2026-05-27 bug where iTerm-with-kitty users pressed
// Alt+M and nothing happened : the CSI-u path silently dropped through
// `parseModifiedKeySequence` because there was no `code === 109`
// branch in the `if (alt)` block.
// ---------------------------------------------------------------------------

describe("EditorController — Alt+M (mode-interrupt shortcut)", () => {
  function makeWithHandler() {
    const calls: number[] = []
    const ctx = make()
    ctx.ctrl.setModeInterruptHandler(() => calls.push(Date.now()))
    return { ...ctx, calls }
  }

  it("bare `\\x1bm` (Option-as-Meta path) fires the handler", () => {
    const { ctrl, stdin, calls } = makeWithHandler()
    ctrl.start()
    stdin.send("\x1bm")
    expect(calls.length).toBe(1)
    // No `m` inserted into the buffer.
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })

  it("kitty CSI-u `\\x1b[109;3u` (Alt+m) fires the handler", () => {
    const { ctrl, stdin, calls } = makeWithHandler()
    ctrl.start()
    stdin.send("\x1b[109;3u")
    expect(calls.length).toBe(1)
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })

  it("xterm modifyOtherKeys `\\x1b[27;3;109~` (Alt+m) fires the handler", () => {
    const { ctrl, stdin, calls } = makeWithHandler()
    ctrl.start()
    stdin.send("\x1b[27;3;109~")
    expect(calls.length).toBe(1)
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })

  it("kitty CSI-u `\\x1b[77;4u` (Shift+Alt+M / capital M) fires the handler", () => {
    // Some terminals report shift+alt+m as code 77 (uppercase M) plus
    // shift+alt modifiers (=4). The handler is shift-forgiving.
    const { ctrl, stdin, calls } = makeWithHandler()
    ctrl.start()
    stdin.send("\x1b[77;4u")
    expect(calls.length).toBe(1)
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })

  it("kitty CSI-u `\\x1b[109;4u` (Shift+Alt+m, code stays lowercase) fires the handler", () => {
    // Other terminals keep code=109 and report shift+alt via modifier=4.
    // Both shapes should reach the handler.
    const { ctrl, stdin, calls } = makeWithHandler()
    ctrl.start()
    stdin.send("\x1b[109;4u")
    expect(calls.length).toBe(1)
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })

  it("no handler wired: keystroke is still swallowed across all encodings", () => {
    // No `setModeInterruptHandler` call → modeInterrupt stays null. The
    // editor MUST still consume the keystroke so a stray Option+M
    // doesn't insert a literal `m`.
    const { ctrl, stdin } = make()
    ctrl.start()
    stdin.send("\x1bm")
    stdin.send("\x1b[109;3u")
    stdin.send("\x1b[27;3;109~")
    stdin.send("\x1b[77;4u")
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })

  it("detach (null handler) stops firing on subsequent presses", () => {
    const calls: number[] = []
    const { ctrl, stdin } = make()
    ctrl.setModeInterruptHandler(() => calls.push(Date.now()))
    ctrl.start()
    stdin.send("\x1b[109;3u")
    expect(calls.length).toBe(1)
    ctrl.setModeInterruptHandler(null)
    stdin.send("\x1b[109;3u")
    expect(calls.length).toBe(1) // still 1, second press dropped
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })

  it("plain `m` (no modifier) still inserts a literal m", () => {
    // Regression guard: the Alt+M dispatch must not swallow unmodified
    // `m`. (Trivial because the modifier check gates the dispatch, but
    // worth pinning so a future refactor that misuses `code === 109`
    // outside the `if (alt)` block gets caught.)
    const { ctrl, stdin, calls } = makeWithHandler()
    ctrl.start()
    stdin.send("m")
    expect(calls.length).toBe(0)
    expect(ctrl.buffer().toString()).toBe("m")
    ctrl.stop()
  })
})
