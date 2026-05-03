/**
 * EditorController "input" event — coalesced, content-only buffer notifications.
 *
 * Tests run with `inputDebounceMs: 0` so the emit fires synchronously
 * during repaint(), keeping assertions deterministic. The 120ms default
 * is exercised by the tmux smoke driver.
 */
import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { EditorController } from "./editor-controller.ts"

class FakeTTYInput extends EventEmitter {
  isTTY = true
  encoding: BufferEncoding | null = null
  resumed = false
  rawModes: boolean[] = []
  setEncoding(e: BufferEncoding) {
    this.encoding = e
    return this
  }
  resume() {
    this.resumed = true
    return this
  }
  pause() {
    this.resumed = false
    return this
  }
  setRawMode(v: boolean) {
    this.rawModes.push(v)
    return this
  }
  send(c: string) {
    this.emit("data", c)
  }
}

class FakeOutput {
  chunks: string[] = []
  isTTY = true
  columns = 80
  rows = 24
  write(c: string | Uint8Array) {
    this.chunks.push(typeof c === "string" ? c : new TextDecoder().decode(c))
    return true
  }
}

class FakeCompositor {
  liveAreaCalls: any[] = []
  liveHeight = 1
  setLiveArea(lines: string[], cursor: any) {
    this.liveAreaCalls.push({ lines: [...lines], cursor })
  }
  setLiveHeight(n: number) {
    this.liveHeight = n
  }
}

interface InputEvent {
  text: string
  seq: number
}

function make() {
  const stdin = new FakeTTYInput()
  const output = new FakeOutput()
  const compositor = new FakeCompositor()
  const ctrl = new EditorController({
    prompt: "> ",
    continuationPrompt: "  ",
    compositor: compositor as any,
    stdin: stdin as any,
    output: output as any,
    inputDebounceMs: 0, // synchronous for deterministic tests
  })
  const events: InputEvent[] = []
  ctrl.on("input", (e: InputEvent) => events.push(e))
  return { ctrl, stdin, events }
}

describe("EditorController — input event", () => {
  it("fires once per typed character batch with the full buffer text", () => {
    const { ctrl, stdin, events } = make()
    ctrl.start()
    // start() → repaint() emits initial empty-buffer event… BUT lastEmitted
    // starts at null, so the first repaint with empty buffer DOES fire.
    // Document this: empty initial fire, then per-keystroke.
    expect(events.length).toBe(1)
    expect(events[0]).toEqual({ text: "", seq: 1 })

    stdin.send("h")
    stdin.send("i")
    expect(events.map((e) => e.text)).toEqual(["", "h", "hi"])
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3])
    ctrl.stop()
  })

  it("does NOT fire on cursor-only moves (left/right arrow)", () => {
    const { ctrl, stdin, events } = make()
    ctrl.start()
    stdin.send("hello")
    const seqAfterTyping = events[events.length - 1].seq
    // Cursor left (CSI D): no buffer change → no new "input" event.
    stdin.send("\x1b[D")
    stdin.send("\x1b[D")
    stdin.send("\x1b[C")
    // Same final seq — no new emissions.
    expect(events[events.length - 1].seq).toBe(seqAfterTyping)
    expect(events[events.length - 1].text).toBe("hello")
    ctrl.stop()
  })

  it("seq is strictly monotonic", () => {
    const { ctrl, stdin, events } = make()
    ctrl.start()
    for (const ch of "abcde") stdin.send(ch)
    const seqs = events.map((e) => e.seq)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
    }
    ctrl.stop()
  })

  it("backspace is treated as a buffer mutation and fires", () => {
    const { ctrl, stdin, events } = make()
    ctrl.start()
    stdin.send("ab")
    const before = events.length
    stdin.send("\x7f") // backspace
    expect(events.length).toBe(before + 1)
    expect(events[events.length - 1].text).toBe("a")
    ctrl.stop()
  })

  it("submit clears buffer and fires an empty-text event", () => {
    const { ctrl, stdin, events } = make()
    ctrl.start()
    stdin.send("hi")
    stdin.send("\r") // Enter → submit → buf.clear() → repaint
    const last = events[events.length - 1]
    expect(last.text).toBe("")
    ctrl.stop()
  })

  it("debounced mode: one event per pause, not per keystroke", async () => {
    // Use the real debounce path with a tiny window.
    const stdin = new FakeTTYInput()
    const output = new FakeOutput()
    const compositor = new FakeCompositor()
    const ctrl = new EditorController({
      prompt: "> ",
      continuationPrompt: "  ",
      compositor: compositor as any,
      stdin: stdin as any,
      output: output as any,
      inputDebounceMs: 30,
    })
    const events: InputEvent[] = []
    ctrl.on("input", (e: InputEvent) => events.push(e))
    ctrl.start()
    // start() schedules an emit for the empty buffer; wait for it to land.
    await new Promise((r) => setTimeout(r, 50))
    expect(events.length).toBe(1)

    // Burst-type 10 characters within the debounce window.
    for (const ch of "abcdefghij") {
      stdin.send(ch)
      await new Promise((r) => setTimeout(r, 5)) // 5ms < 30ms window
    }
    // Wait for debounce to fire.
    await new Promise((r) => setTimeout(r, 50))

    // Should have ONE additional emission with the final text — not 10.
    expect(events.length).toBe(2)
    expect(events[1].text).toBe("abcdefghij")
    ctrl.stop()
  })
})
