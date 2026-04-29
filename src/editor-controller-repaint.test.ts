/**
 * Regression for B3 — every keystroke triggers a `setLiveArea` call,
 * even when the rendered live-area state hasn't changed (e.g. cursor
 * + lines identical to the previous frame). Each call eats one
 * `eraseLiveSeq` + `drawLiveSeq` cycle of work.
 *
 * We're explicitly NOT asserting "exactly one paint" — typing genuinely
 * changes the prompt every time. The bug is the redundant paints: when
 * the controller re-renders for events that don't change anything
 * visible (status pings, idle frames, mode toggles that no-op), the
 * live area is still re-drawn.
 */

import { describe, expect, it } from "bun:test"
import { EditorController } from "./editor-controller.ts"
import { EventEmitter } from "node:events"

class FakeStdin extends EventEmitter {
  isTTY = true
  encoding: BufferEncoding | null = null
  rawModes: boolean[] = []
  setEncoding(e: BufferEncoding) {
    this.encoding = e
    return this
  }
  resume() {
    return this
  }
  pause() {
    return this
  }
  setRawMode(v: boolean) {
    this.rawModes.push(v)
    return this
  }
  send(s: string) {
    this.emit("data", s)
  }
}

class FakeOutput {
  isTTY = true
  columns = 80
  rows = 24
  readonly chunks: string[] = []
  write(c: string | Uint8Array) {
    this.chunks.push(typeof c === "string" ? c : new TextDecoder().decode(c))
    return true
  }
}

function makeCompositorSpy() {
  const calls: { kind: string; lines?: string[]; cursor?: any }[] = []
  return {
    calls,
    compositor: {
      mount: () => {},
      unmount: () => {},
      writeStream: () => {},
      setLiveArea: (lines: string[], cursor: any) => {
        calls.push({ kind: "setLiveArea", lines: [...lines], cursor: cursor && { ...cursor } })
      },
      setLiveHeight: () => {},
      get liveHeight() {
        return 0
      },
      withSuspendedLiveArea: async (fn: () => any) => fn(),
      notifyResize: () => {},
    } as any,
  }
}

describe("EditorController — paint amplification (B3)", () => {
  it("setLiveArea is NOT called when neither lines nor cursor change", () => {
    const stdin = new FakeStdin()
    const output = new FakeOutput()
    const spy = makeCompositorSpy()

    const ed = new EditorController({
      prompt: "❯ ",
      continuationPrompt: "  ",
      compositor: spy.compositor,
      stdin: stdin as any,
      output: output as any,
    })
    ed.start()

    const initial = spy.calls.length
    // Same status twice in a row → second call should be a no-op.
    ed.setStatus("Thinking…")
    const afterFirst = spy.calls.length
    ed.setStatus("Thinking…")
    const afterSecond = spy.calls.length

    expect(afterFirst).toBeGreaterThan(initial)
    expect(afterSecond).toBe(afterFirst)

    ed.stop()
  })

  it("typing N distinct characters produces ≤ N paint calls (one per genuine change)", () => {
    const stdin = new FakeStdin()
    const output = new FakeOutput()
    const spy = makeCompositorSpy()

    const ed = new EditorController({
      prompt: "❯ ",
      continuationPrompt: "  ",
      compositor: spy.compositor,
      stdin: stdin as any,
      output: output as any,
    })
    ed.start()

    spy.calls.length = 0
    const text = "hello"
    for (const ch of text) stdin.send(ch)

    // Each keystroke genuinely changes the prompt → one paint each.
    // Allow a small fudge for any internal initial-frame paint.
    expect(spy.calls.length).toBeGreaterThanOrEqual(text.length)
    expect(spy.calls.length).toBeLessThanOrEqual(text.length + 1)

    ed.stop()
  })
})
