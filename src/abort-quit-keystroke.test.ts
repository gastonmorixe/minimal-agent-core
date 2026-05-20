/**
 * Integration tests pinning the abort-quit UX contract at the
 * **keystroke encoding** layer (May 2026 - see project memory
 * `#abort-quit-fsm` + `#abort-quit-ux-spec`).
 *
 * Background
 * ----------
 * The canonical UX (per the user spec):
 *
 *   - working + ESC      → abort the turn, no arm, no quit
 *   - working + Ctrl+C   → abort the turn + arm 10s `post-abort` window
 *   - idle    + ESC      → no-op (ESC never arms)
 *   - idle    + Ctrl+C   → arm 10s `idle-confirm` window
 *   - armed   + Ctrl+C   → quit (confirmed) + goodbye banner
 *   - armed   + ESC      → dismiss the armed modal back to idle
 *   - any state, 2× Ctrl+C within 500ms → force-quit (escape-hatch backstop)
 *
 * The pure FSM (`src/abort-quit-fsm.ts`) encodes the transition table and is
 * already exhaustively tested in `src/abort-quit-fsm.test.ts`. THIS file
 * tests the **wiring** between actual byte sequences arriving on stdin and
 * the FSM - the gap that allowed real-terminal bugs to slip through CI:
 *
 *   - **Bug A** (May 2026, reproduced via tmux): kitty-encoded Ctrl+C
 *     (`\x1b[99;5u`) AND xterm modifyOtherKeys Ctrl+C (`\x1b[27;5;99~`) on a
 *     BLANK buffer hit `parseModifiedKeySequence` case 99 → returns
 *     `"cancel"` → bare `emit("cancel")` in consumePending → bypasses FSM
 *     entirely. abortBus never fires; the host's legacy `on("cancel")`
 *     handler sets `cancelled=true` and exits the REPL silently with NO
 *     goodbye banner.
 *
 *   - **Bug B** (May 2026, reproduced via tmux): kitty-encoded ESC
 *     (`\x1b[27u`) AND xterm modifyOtherKeys ESC (`\x1b[27;1;27~`) fall
 *     through `parseModifiedKeySequence` to `"ignore"` → silent no-op.
 *     ESC never reaches the FSM, no abort fires.
 *
 * Both bugs survived the existing `agent.abort-repl.test.ts` because that
 * suite uses `FakeEditor` and synthesises aborts by calling
 * `abortBus.requestAbort` DIRECTLY, skipping the entire keyboard parser.
 * The `editor-controller.test.ts` Ctrl+C tests ran in the `idle` FSM state
 * only (never called `notifyTurnStart`), so the `working` rules were
 * unverified at the byte level.
 *
 * This file feeds raw bytes through `FakeTTYInput.send(...)` into the
 * **real** `EditorController` and asserts:
 *
 *   1. The right FSM input is delivered (`{kind:"esc"}` or `{kind:"ctrl-c"}`).
 *   2. The abortBus receives the abort with the right `key` field.
 *   3. No bare `emit("cancel")` fires (the spec says only quit/escape-hatch
 *      emit `cancel` for back-compat; the legacy "exit REPL on cancel"
 *      path is gone).
 *   4. The host doesn't see a phantom quit event when the user only meant
 *      to abort.
 *
 * Encodings exercised (matrix):
 *
 *   | Variant                | bytes              | FSM input |
 *   |------------------------|--------------------|-----------|
 *   | bare ESC               | `\x1b`             | esc       |
 *   | kitty CSI-u ESC        | `\x1b[27u`         | esc       |
 *   | xterm modifyOtherKeys  | `\x1b[27;1;27~`    | esc       |
 *   | bare Ctrl+C            | `\x03`             | ctrl-c    |
 *   | kitty CSI-u Ctrl+C     | `\x1b[99;5u`       | ctrl-c    |
 *   | xterm modifyOtherKeys  | `\x1b[27;5;99~`    | ctrl-c    |
 *
 * Cross-references:
 *   - `tmp/abort-real-editor-tmux.ts` - visual tmux smoke driver.
 *   - `src/abort-quit-fsm.test.ts` - pure FSM transducer tests.
 *   - `src/agent.abort-repl.test.ts` - REPL-side behavior (uses FakeEditor;
 *     intentionally complementary to this file's byte-level coverage).
 *   - Project memory `#abort-quit-ux-spec`, `#abort-quit-fsm`.
 */
import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { AbortBus, type AbortReason } from "./abort-bus.ts"
import { EditorController } from "./editor-controller.ts"

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
}

class FakeCompositor {
  liveAreaCalls: Array<{
    lines: string[]
    cursor: { row: number; col: number } | null
  }> = []
  liveHeight = 1
  setLiveArea(lines: string[], cursor: { row: number; col: number } | null): void {
    this.liveAreaCalls.push({ lines: [...lines], cursor: cursor ? { ...cursor } : null })
  }
  setLiveHeight(n: number): void {
    this.liveHeight = n
  }
  last() {
    return this.liveAreaCalls[this.liveAreaCalls.length - 1]
  }
}

interface Harness {
  ctrl: EditorController
  stdin: FakeTTYInput
  compositor: FakeCompositor
  bus: AbortBus
  cancels: unknown[]
  quits: unknown[]
  aborts: AbortReason[]
}

function makeWorkingHarness(opts: { bareEscapeMs?: number; armedTickMs?: number } = {}): Harness {
  const bus = new AbortBus()
  const stdin = new FakeTTYInput()
  const output = new FakeOutput()
  const compositor = new FakeCompositor()
  const ctrl = new EditorController({
    prompt: "> ",
    continuationPrompt: "  ",
    compositor: compositor as any,
    stdin: stdin as any,
    output: output as any,
    abortBus: bus,
    // 0ms so bare-Esc fires on the next microtask without real timers.
    bareEscapeMs: opts.bareEscapeMs ?? 0,
    armedTickMs: opts.armedTickMs ?? 0,
  })
  const cancels: unknown[] = []
  const quits: unknown[] = []
  const aborts: AbortReason[] = []
  ctrl.on("cancel", (r) => cancels.push(r))
  ctrl.on("quit", (r) => quits.push(r))
  bus.on("abort", (r: AbortReason) => aborts.push(r))
  ctrl.start()
  return { ctrl, stdin, compositor, bus, cancels, quits, aborts }
}

/**
 * Drive the harness into the `working` FSM state, ready for the byte under
 * test. Mirrors what `runReplLiveArea` does around an agent turn:
 *
 *   bus.beginTurn()
 *   editor.notifyTurnStart()
 *   …user keystroke arrives…
 *
 * After the keystroke, the caller is expected to assert on `harness.aborts`,
 * `harness.cancels`, `harness.quits`, and `ctrl.fsmStateForTest()`.
 */
function enterWorking(h: Harness): void {
  h.bus.beginTurn()
  h.ctrl.notifyTurnStart()
  expect(h.ctrl.fsmStateForTest().kind).toBe("working")
}

/**
 * Wait one macrotask. Used after bare-Esc to let the `bareEscapeMs=0` timer
 * fire (it's `setTimeout(0)`, not `Promise.resolve()`).
 */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1))

// ---------------------------------------------------------------------------
// Working state - ESC variants (rule 1: abort only, no arm, no quit)
// ---------------------------------------------------------------------------

describe("EditorController - ESC while working aborts via FSM (all encodings)", () => {
  it("bare ESC (`\\x1b`) fires abort-turn, FSM stays `working`, no quit", async () => {
    const h = makeWorkingHarness()
    enterWorking(h)
    h.stdin.send("\x1b")
    // bareEscape disambiguation timer needs one macrotask.
    await tick()
    expect(h.aborts).toEqual([{ kind: "user-key", key: "Ctrl+C" }])
    expect(h.cancels).toEqual([])
    expect(h.quits).toEqual([])
    expect(h.ctrl.fsmStateForTest().kind).toBe("working")
    h.ctrl.stop()
  })

  it("kitty CSI-u ESC (`\\x1b[27u`) fires abort-turn (Bug B regression guard)", () => {
    const h = makeWorkingHarness()
    enterWorking(h)
    h.stdin.send("\x1b[27u")
    expect(h.aborts).toEqual([{ kind: "user-key", key: "Ctrl+C" }])
    expect(h.cancels).toEqual([])
    expect(h.quits).toEqual([])
    expect(h.ctrl.fsmStateForTest().kind).toBe("working")
    h.ctrl.stop()
  })

  it("xterm modifyOtherKeys ESC (`\\x1b[27;1;27~`) fires abort-turn", () => {
    const h = makeWorkingHarness()
    enterWorking(h)
    h.stdin.send("\x1b[27;1;27~")
    expect(h.aborts).toEqual([{ kind: "user-key", key: "Ctrl+C" }])
    expect(h.cancels).toEqual([])
    expect(h.quits).toEqual([])
    expect(h.ctrl.fsmStateForTest().kind).toBe("working")
    h.ctrl.stop()
  })
})

// ---------------------------------------------------------------------------
// Working state - Ctrl+C variants (rule 1+2: abort + arm post-abort, no quit)
// ---------------------------------------------------------------------------

describe("EditorController - Ctrl+C while working aborts + arms (all encodings)", () => {
  it("bare Ctrl+C (`\\x03`) fires abort-turn AND enters armed (post-abort)", () => {
    const h = makeWorkingHarness()
    enterWorking(h)
    h.stdin.send("\x03")
    expect(h.aborts).toEqual([{ kind: "user-key", key: "Ctrl+C" }])
    expect(h.cancels).toEqual([])
    expect(h.quits).toEqual([])
    const s = h.ctrl.fsmStateForTest()
    expect(s.kind).toBe("armed")
    if (s.kind === "armed") expect(s.source).toBe("post-abort")
    h.ctrl.stop()
  })

  it("kitty CSI-u Ctrl+C (`\\x1b[99;5u`) fires abort-turn AND arms (Bug A regression guard)", () => {
    const h = makeWorkingHarness()
    enterWorking(h)
    h.stdin.send("\x1b[99;5u")
    expect(h.aborts).toEqual([{ kind: "user-key", key: "Ctrl+C" }])
    expect(h.cancels).toEqual([])
    expect(h.quits).toEqual([])
    const s = h.ctrl.fsmStateForTest()
    expect(s.kind).toBe("armed")
    if (s.kind === "armed") expect(s.source).toBe("post-abort")
    h.ctrl.stop()
  })

  it("xterm modifyOtherKeys Ctrl+C (`\\x1b[27;5;99~`) fires abort-turn AND arms", () => {
    const h = makeWorkingHarness()
    enterWorking(h)
    h.stdin.send("\x1b[27;5;99~")
    expect(h.aborts).toEqual([{ kind: "user-key", key: "Ctrl+C" }])
    expect(h.cancels).toEqual([])
    expect(h.quits).toEqual([])
    const s = h.ctrl.fsmStateForTest()
    expect(s.kind).toBe("armed")
    if (s.kind === "armed") expect(s.source).toBe("post-abort")
    h.ctrl.stop()
  })
})

// ---------------------------------------------------------------------------
// Idle state - kitty/xterm Ctrl+C variants arm WITHOUT clearing buffer
// ---------------------------------------------------------------------------

describe("EditorController - Ctrl+C while idle arms (all encodings, buffer preserved)", () => {
  it("kitty CSI-u Ctrl+C on EMPTY buffer arms, does not emit bare cancel", () => {
    const h = makeWorkingHarness()
    // Don't enter working - stay idle.
    h.stdin.send("\x1b[99;5u")
    expect(h.aborts).toEqual([])
    expect(h.cancels).toEqual([])
    expect(h.quits).toEqual([])
    const s = h.ctrl.fsmStateForTest()
    expect(s.kind).toBe("armed")
    if (s.kind === "armed") expect(s.source).toBe("idle-confirm")
    h.ctrl.stop()
  })

  it("kitty CSI-u Ctrl+C on NON-EMPTY buffer arms AND preserves buffer (Bug A: was clearing)", () => {
    const h = makeWorkingHarness()
    h.stdin.send("oops")
    h.stdin.send("\x1b[99;5u")
    // Buffer text preserved (the old legacy path called `this.buf.clear()`).
    expect(h.compositor.last().lines[0]).toBe("> oops")
    expect(h.aborts).toEqual([])
    expect(h.cancels).toEqual([])
    expect(h.quits).toEqual([])
    expect(h.ctrl.fsmStateForTest().kind).toBe("armed")
    h.ctrl.stop()
  })

  it("xterm modifyOtherKeys Ctrl+C on EMPTY buffer arms", () => {
    const h = makeWorkingHarness()
    h.stdin.send("\x1b[27;5;99~")
    expect(h.aborts).toEqual([])
    expect(h.cancels).toEqual([])
    expect(h.quits).toEqual([])
    expect(h.ctrl.fsmStateForTest().kind).toBe("armed")
    h.ctrl.stop()
  })
})

// ---------------------------------------------------------------------------
// Idle state - ESC variants (rule 4: ESC NEVER arms)
// ---------------------------------------------------------------------------

describe("EditorController - ESC while idle is a no-op (all encodings)", () => {
  it("bare ESC while idle is a no-op", async () => {
    const h = makeWorkingHarness()
    h.stdin.send("\x1b")
    await tick()
    expect(h.aborts).toEqual([])
    expect(h.cancels).toEqual([])
    expect(h.quits).toEqual([])
    expect(h.ctrl.fsmStateForTest().kind).toBe("idle")
    h.ctrl.stop()
  })

  it("kitty CSI-u ESC while idle is a no-op", () => {
    const h = makeWorkingHarness()
    h.stdin.send("\x1b[27u")
    expect(h.aborts).toEqual([])
    expect(h.cancels).toEqual([])
    expect(h.quits).toEqual([])
    expect(h.ctrl.fsmStateForTest().kind).toBe("idle")
    h.ctrl.stop()
  })

  it("xterm modifyOtherKeys ESC while idle is a no-op", () => {
    const h = makeWorkingHarness()
    h.stdin.send("\x1b[27;1;27~")
    expect(h.aborts).toEqual([])
    expect(h.cancels).toEqual([])
    expect(h.quits).toEqual([])
    expect(h.ctrl.fsmStateForTest().kind).toBe("idle")
    h.ctrl.stop()
  })
})

// ---------------------------------------------------------------------------
// Armed state - Ctrl+C variants quit; ESC dismisses
// ---------------------------------------------------------------------------

describe("EditorController - armed state transitions (all Ctrl+C encodings)", () => {
  it("kitty CSI-u Ctrl+C while armed via bare-Ctrl+C → quit confirmed", () => {
    const h = makeWorkingHarness({ armedTickMs: 0 })
    h.stdin.send("\x03") // arm via bare
    expect(h.ctrl.fsmStateForTest().kind).toBe("armed")
    h.stdin.send("\x1b[99;5u") // confirm via kitty
    // Either FSM-confirmed quit OR escape-hatch quit is acceptable (rule 5).
    expect(h.quits.length).toBeGreaterThanOrEqual(1)
    const reasons = new Set(h.quits.concat(h.cancels))
    expect([...reasons].some((r) => r === "confirmed" || r === "escape-hatch")).toBe(true)
    h.ctrl.stop()
  })

  it("xterm Ctrl+C while armed via kitty arm → quit confirmed", () => {
    const h = makeWorkingHarness({ armedTickMs: 0 })
    h.stdin.send("\x1b[99;5u") // arm via kitty
    expect(h.ctrl.fsmStateForTest().kind).toBe("armed")
    h.stdin.send("\x1b[27;5;99~") // confirm via xterm
    expect(h.quits.length).toBeGreaterThanOrEqual(1)
    h.ctrl.stop()
  })

  it("kitty ESC while armed dismisses the modal back to idle (Bug B regression guard)", () => {
    const h = makeWorkingHarness({ armedTickMs: 0 })
    h.stdin.send("\x03") // arm
    expect(h.ctrl.fsmStateForTest().kind).toBe("armed")
    h.stdin.send("\x1b[27u") // dismiss via kitty ESC
    expect(h.quits).toEqual([])
    expect(h.ctrl.fsmStateForTest().kind).toBe("idle")
    h.ctrl.stop()
  })
})
