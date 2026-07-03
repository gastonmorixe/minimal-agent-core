import { describe, expect, it } from "bun:test"

import { AbortBus } from "../bus/abort-bus.ts"
import { Hooks } from "../plugins/hooks/hooks.ts"

import { make } from "./editor-controller.fixtures.ts"
import type { EditorController, EditorKeyPayload } from "./editor-controller.ts"

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

describe("EditorController — overlay key dispatch (editor.key hook)", () => {
  // Regression: a blocking overlay (ask-user modal) subscribes to `editor.key`
  // and halts. The editor must dispatch its navigation/confirm keys to the hook
  // chain. Pre-fix, ArrowLeft/ArrowRight bypassed the hook (cursor-move only)
  // and Enter on a BLANK buffer was eaten by the no-op before the hook fired —
  // so a modal could not be navigated or confirmed.
  it("dispatches ArrowLeft/ArrowRight/Enter-on-blank to the editor.key hook chain", () => {
    const hooks = new Hooks()
    const seen: string[] = []
    hooks.on(
      "editor.key",
      (payload: { key: string; result: { halt?: boolean } }) => {
        seen.push(payload.key)
        payload.result.halt = true // claim the key, as a modal does
      },
      { caller: "agent", priority: 9999, label: "test:modal" },
    )
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    stdin.send("\x1b[D") // ArrowLeft
    stdin.send("\x1b[C") // ArrowRight
    stdin.send("\r") // Enter on a blank buffer
    expect(seen).toEqual(["ArrowLeft", "ArrowRight", "Enter"])
    ctrl.stop()
  })

  it("does NOT submit a blank buffer when a listener claims Enter", () => {
    const hooks = new Hooks()
    hooks.on(
      "editor.key",
      (p: { key: string; result: { halt?: boolean } }) => {
        if (p.key === "Enter") p.result.halt = true
      },
      { caller: "agent", priority: 9999, label: "test:modal" },
    )
    const submits: string[] = []
    const { ctrl, stdin } = make({ hooks })
    ctrl.on("submit", (t) => submits.push(t))
    ctrl.start()
    stdin.send("\r")
    expect(submits).toEqual([]) // claimed by the overlay, not submitted
    ctrl.stop()
  })

  it("with no listener, ←/→ still move the buffer cursor (default preserved)", () => {
    const submits: string[] = []
    const { ctrl, stdin } = make()
    ctrl.on("submit", (t) => submits.push(t))
    ctrl.start()
    stdin.send("ac") // "ac", cursor at end
    stdin.send("\x1b[D") // left → between a and c
    stdin.send("b") // insert → "abc"
    stdin.send("\r") // submit (non-blank)
    expect(submits).toEqual(["abc"])
    ctrl.stop()
  })
})

describe("EditorController — submit-queue navigation hook (setQueueKeyHandler)", () => {
  type Call = { key: string; buffer: string; atTop: boolean }
  /** Install a recording handler returning a per-key canned result. */
  function withHandler(
    ctrl: EditorController,
    results: Record<string, { handled: boolean; buffer?: string }>,
  ): Call[] {
    const calls: Call[] = []
    ctrl.setQueueKeyHandler((key, ctx) => {
      calls.push({ key, buffer: ctx.buffer, atTop: ctx.atTop })
      return results[key] ?? { handled: false }
    })
    return calls
  }

  it("routes ArrowUp to the handler and applies the returned buffer", () => {
    const { ctrl, stdin } = make()
    withHandler(ctrl, { ArrowUp: { handled: true, buffer: "dequeued text" } })
    ctrl.start()
    stdin.send("\x1b[A")
    // buffer replaced by the handler's text (queue dequeued back to prompt)
    stdin.send("!") // append to prove the buffer is "dequeued text"
    const submits: string[] = []
    ctrl.on("submit", (t) => submits.push(t))
    stdin.send("\r")
    expect(submits).toEqual(["dequeued text!"])
    ctrl.stop()
  })

  it("passes buffer + atTop context (empty prompt → atTop true)", () => {
    const { ctrl, stdin } = make()
    const calls = withHandler(ctrl, {})
    ctrl.start()
    stdin.send("\x1b[A")
    expect(calls).toEqual([{ key: "ArrowUp", buffer: "", atTop: true }])
    ctrl.stop()
  })

  it("atTop is false when the cursor sits below the first visual row", () => {
    const { ctrl, stdin } = make()
    const calls = withHandler(ctrl, {})
    ctrl.start()
    stdin.send("a")
    stdin.send("\x1b\r") // Alt+Enter → newline, cursor now on row 1
    stdin.send("b")
    stdin.send("\x1b[A")
    const up = calls.find((c) => c.key === "ArrowUp")
    expect(up?.atTop).toBe(false)
    expect(up?.buffer).toBe("a\nb")
    ctrl.stop()
  })

  it("ArrowUp pass-through (handled:false) does not alter the buffer", () => {
    const { ctrl, stdin } = make()
    withHandler(ctrl, { ArrowUp: { handled: false } })
    ctrl.start()
    stdin.send("hello")
    stdin.send("\x1b[A") // not claimed → cursor-up no-op on single line
    const submits: string[] = []
    ctrl.on("submit", (t) => submits.push(t))
    stdin.send("\r")
    expect(submits).toEqual(["hello"])
    ctrl.stop()
  })

  it("printable 'd' claimed by the handler is NOT inserted", () => {
    const { ctrl, stdin } = make()
    const calls = withHandler(ctrl, { d: { handled: true } })
    ctrl.start()
    stdin.send("d")
    const submits: string[] = []
    ctrl.on("submit", (t) => submits.push(t))
    stdin.send("\r") // blank buffer → no submit
    expect(submits).toEqual([])
    expect(calls.some((c) => c.key === "d")).toBe(true)
    ctrl.stop()
  })

  it("printable pass-through still inserts (incl. the greedy run)", () => {
    const { ctrl, stdin } = make()
    withHandler(ctrl, {}) // everything pass-through
    ctrl.start()
    stdin.send("dxk") // a greedy printable run
    const submits: string[] = []
    ctrl.on("submit", (t) => submits.push(t))
    stdin.send("\r")
    expect(submits).toEqual(["dxk"])
    ctrl.stop()
  })

  it("'k' returning a multi-line buffer sets a multi-line prompt", () => {
    const { ctrl, stdin } = make()
    withHandler(ctrl, { k: { handled: true, buffer: "1. a\n2. b" } })
    ctrl.start()
    stdin.send("k")
    const submits: string[] = []
    ctrl.on("submit", (t) => submits.push(t))
    stdin.send("\r")
    expect(submits).toEqual(["1. a\n2. b"])
    ctrl.stop()
  })

  it("Enter claimed by the handler does NOT submit (dequeue selection)", () => {
    const { ctrl, stdin } = make()
    withHandler(ctrl, { Enter: { handled: true, buffer: "picked" } })
    const submits: string[] = []
    ctrl.on("submit", (t) => submits.push(t))
    ctrl.start()
    stdin.send("\r")
    expect(submits).toEqual([]) // consumed by the overlay
    stdin.send("!")
    ctrl.setQueueKeyHandler(null) // let the next Enter submit
    stdin.send("\r")
    expect(submits).toEqual(["picked!"])
    ctrl.stop()
  })

  it("Enter pass-through still submits a non-blank buffer", () => {
    const { ctrl, stdin } = make()
    withHandler(ctrl, {}) // Enter not claimed
    const submits: string[] = []
    ctrl.on("submit", (t) => submits.push(t))
    ctrl.start()
    stdin.send("hi")
    stdin.send("\r")
    expect(submits).toEqual(["hi"])
    ctrl.stop()
  })

  it("kitty CSI-u Esc claimed by the handler does NOT abort the turn", () => {
    const bus = new AbortBus()
    const { ctrl, stdin } = make({ abortBus: bus, armedTickMs: 0 })
    withHandler(ctrl, { Escape: { handled: true } })
    ctrl.start()
    bus.beginTurn()
    ctrl.notifyTurnStart()
    stdin.send("\x1b[27u") // kitty CSI-u Esc
    expect(bus.isTurnInFlight()).toBe(true) // overlay ate it, no abort
    ctrl.stop()
  })

  it("kitty CSI-u Esc pass-through (handled:false) still aborts the turn", () => {
    const bus = new AbortBus()
    const aborts: unknown[] = []
    bus.on("abort", (r) => aborts.push(r))
    const { ctrl, stdin } = make({ abortBus: bus, armedTickMs: 0 })
    withHandler(ctrl, { Escape: { handled: false } })
    ctrl.start()
    bus.beginTurn()
    ctrl.notifyTurnStart()
    stdin.send("\x1b[27u")
    expect(aborts.length).toBe(1)
    expect(bus.isTurnInFlight()).toBe(false)
    ctrl.stop()
  })

  it("kitty CSI-u 'd' (\\x1b[100u) routes to the handler", () => {
    const { ctrl, stdin } = make()
    const calls = withHandler(ctrl, { d: { handled: true } })
    ctrl.start()
    stdin.send("\x1b[100u")
    const submits: string[] = []
    ctrl.on("submit", (t) => submits.push(t))
    stdin.send("\r")
    expect(submits).toEqual([]) // 'd' swallowed, buffer still blank
    expect(calls.some((c) => c.key === "d")).toBe(true)
    ctrl.stop()
  })

  it("a throwing handler is swallowed → key falls through to default", () => {
    const { ctrl, stdin } = make()
    ctrl.setQueueKeyHandler(() => {
      throw new Error("boom")
    })
    ctrl.start()
    stdin.send("d") // handler throws → default insert
    const submits: string[] = []
    ctrl.on("submit", (t) => submits.push(t))
    stdin.send("\r")
    expect(submits).toEqual(["d"]) // inserted despite the throw
    ctrl.stop()
  })

  it("detach (null handler) restores plain key handling", () => {
    const { ctrl, stdin } = make()
    withHandler(ctrl, { d: { handled: true } })
    ctrl.setQueueKeyHandler(null)
    ctrl.start()
    stdin.send("d")
    const submits: string[] = []
    ctrl.on("submit", (t) => submits.push(t))
    stdin.send("\r")
    expect(submits).toEqual(["d"]) // 'd' inserted normally
    ctrl.stop()
  })
})

// ---------------------------------------------------------------------------
// Modal overlay ownership (editor.overlay.open / close)
// ---------------------------------------------------------------------------
//
// A command TUI (/config, /usage) takes modal ownership of the input line.
// While owned the editor: hides the prompt row + cursor, blocks submit (so a
// typed `/cmd` can't leak to scrollback), and routes every key — including
// printable chars + Backspace — through the editor.key hook so the overlay
// drives its own draft instead of the shared prompt buffer.

describe("EditorController — modal overlay ownership", () => {
  it("hides the prompt row + parks the cursor while owned", () => {
    const { ctrl, compositor } = make()
    ctrl.start()
    expect(compositor.last().lines).toEqual(["> "])
    ctrl.openOverlay("config")
    // Prompt row is gone; the overlay paints via its own footer (none here).
    expect(compositor.last().lines).toEqual([])
    expect(compositor.last().cursor).toEqual({ row: 0, col: 0 })
    expect(ctrl.isOverlayOwned()).toBe(true)
    ctrl.stop()
  })

  it("blocks submit while owned (no scrollback leak) and restores on close", () => {
    const { ctrl, stdin, compositor } = make()
    const submits: string[] = []
    ctrl.on("submit", (t) => submits.push(t))
    ctrl.start()
    ctrl.openOverlay("config")
    // Even an Enter (or any pending buffer) must not produce a submit.
    stdin.send("\r")
    expect(submits).toEqual([])
    ctrl.closeOverlay("config")
    expect(ctrl.isOverlayOwned()).toBe(false)
    // Prompt is back.
    expect(compositor.last().lines).toEqual(["> "])
    // And submit works again.
    stdin.send("hi")
    stdin.send("\r")
    expect(submits).toEqual(["hi"])
    ctrl.stop()
  })

  it("routes printable chars through editor.key (not the prompt buffer) while owned", () => {
    const hooks = new Hooks()
    const keys: string[] = []
    hooks.on<EditorKeyPayload>(
      "editor.key",
      (payload) => {
        keys.push(payload.key)
        payload.result.halt = true
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    ctrl.openOverlay("config")
    stdin.send("abc")
    // Each printable arrived as its own editor.key event.
    expect(keys).toEqual(["a", "b", "c"])
    // The prompt buffer was NOT mutated.
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })

  it("routes Backspace as an editor.key 'Backspace' while owned", () => {
    const hooks = new Hooks()
    const keys: string[] = []
    hooks.on<EditorKeyPayload>(
      "editor.key",
      (payload) => {
        keys.push(payload.key)
        payload.result.halt = true
      },
      { caller: "plugin" },
    )
    const { ctrl, stdin } = make({ hooks })
    ctrl.start()
    ctrl.openOverlay("config")
    stdin.send("\x7f")
    expect(keys).toEqual(["Backspace"])
    ctrl.stop()
  })

  it("close is owner-checked: a non-owner close is ignored", () => {
    const { ctrl } = make()
    ctrl.start()
    ctrl.openOverlay("config")
    ctrl.closeOverlay("usage") // different owner → ignored
    expect(ctrl.isOverlayOwned()).toBe(true)
    ctrl.closeOverlay("config") // the owner closes
    expect(ctrl.isOverlayOwned()).toBe(false)
    ctrl.stop()
  })

  it("a non-printable control key (Ctrl+A) can't edit the hidden prompt while owned", () => {
    const { ctrl, stdin } = make()
    ctrl.start()
    stdin.send("seed") // buffer has content before opening
    ctrl.openOverlay("config")
    // Ctrl+A (move-line-start) and friends are swallowed while owned.
    stdin.send("\x01")
    stdin.send("x") // printable → routed to editor.key, not the buffer
    // The buffer is whatever openOverlay cleared it to (empty) — unchanged by
    // the swallowed control byte or the routed printable.
    expect(ctrl.buffer().toString()).toBe("")
    ctrl.stop()
  })
})
