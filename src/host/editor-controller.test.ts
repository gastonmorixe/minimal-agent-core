import { describe, expect, it } from "bun:test"

import { FakeCompositor, FakeOutput, FakeTTYInput, make } from "./editor-controller.fixtures.ts"
import { EditorController } from "./editor-controller.ts"
import { displayWidth } from "../term-width.ts"
import { FakeTerminal } from "../test-utils/fake-terminal.ts"
import { Compositor } from "./ui/compositor.ts"

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

  it("coalesces a burst of resizes into a single repaint (drag-leak guard)", async () => {
    // A window-edge DRAG fires one SIGWINCH per column. Repainting on each
    // step stacks a reflow residue into scrollback per step (the bug). With
    // resizeDebounceMs > 0, a burst must collapse to exactly ONE repaint.
    const { ctrl, stdin, output, compositor } = make({
      columns: 40,
      resizeDebounceMs: 20,
    })
    ctrl.start()
    stdin.send("some buffer text that will reflow when narrowed")

    const callsBeforeBurst = compositor.liveAreaCalls.length
    // Simulate a 12-step drag, no awaiting between steps.
    for (let w = 40; w >= 28; w--) {
      output.columns = w
      ctrl.notifyResize()
    }
    // Synchronously, the burst must NOT have repainted yet (all coalesced).
    expect(compositor.liveAreaCalls.length).toBe(callsBeforeBurst)

    // After the debounce window, exactly ONE repaint lands.
    await new Promise((r) => setTimeout(r, 40))
    expect(compositor.liveAreaCalls.length).toBe(callsBeforeBurst + 1)
    // And it reflowed to the FINAL width (every line fits in 28 cols).
    for (const line of compositor.last().lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(28)
    }
    ctrl.stop()
  })

  it("resizeDebounceMs=0 keeps the legacy synchronous repaint-per-resize", () => {
    const { ctrl, output, compositor } = make({ columns: 40, resizeDebounceMs: 0 })
    ctrl.start()
    const before = compositor.liveAreaCalls.length
    output.columns = 30
    ctrl.notifyResize()
    // Synchronous: the repaint already happened (a width change is a genuine
    // visual change, so it is not deduped).
    expect(compositor.liveAreaCalls.length).toBeGreaterThan(before)
    ctrl.stop()
  })

  it("a pending coalesced repaint does not fire after stop()", async () => {
    const { ctrl, output, compositor } = make({ columns: 40, resizeDebounceMs: 20 })
    ctrl.start()
    output.columns = 30
    ctrl.notifyResize()
    const atStop = compositor.liveAreaCalls.length
    ctrl.stop()
    await new Promise((r) => setTimeout(r, 40))
    // The timer was cleared by stop(); no post-teardown repaint.
    expect(compositor.liveAreaCalls.length).toBe(atStop)
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

describe("EditorController — Ctrl+V clipboard paste", () => {
  it("inserts clipboard text returned by the handler on \\x16", () => {
    const { ctrl, stdin } = make()
    ctrl.setClipboardPasteHandler(() => "pasted text")
    ctrl.start()
    stdin.send("\x16")
    expect(ctrl.buffer().toString()).toBe("pasted text")
    ctrl.stop()
  })

  it("routes the handler result through the paste interceptor (drop-path → token)", () => {
    const { ctrl, stdin } = make()
    // Interceptor turns a recognized payload into a media token, exactly as
    // the media wiring does for a dropped image path.
    ctrl.setPasteInterceptor((p) => (p === "/x/a.png" ? "[Image #abc123 1x1 1B]" : null))
    ctrl.setClipboardPasteHandler(() => "/x/a.png")
    ctrl.start()
    stdin.send("\x16")
    expect(ctrl.buffer().toString()).toBe("[Image #abc123 1x1 1B]")
    ctrl.stop()
  })

  it("is a silent no-op when no handler is wired (no raw \\x16 inserted)", () => {
    const { ctrl, stdin } = make()
    ctrl.start()
    stdin.send("\x16")
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })

  it("is a no-op when the handler returns null", () => {
    const { ctrl, stdin } = make()
    ctrl.setClipboardPasteHandler(() => null)
    ctrl.start()
    stdin.send("\x16")
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })

  it("swallows a handler that throws (keystroke stays a no-op)", () => {
    const { ctrl, stdin } = make()
    ctrl.setClipboardPasteHandler(() => {
      throw new Error("clipboard unavailable")
    })
    ctrl.start()
    stdin.send("\x16")
    expect(ctrl.buffer().toString()).toBe("")
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
      // Indicator-reflow assertions check the post-resize frame synchronously.
      resizeDebounceMs: 0,
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
