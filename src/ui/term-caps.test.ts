import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import { detectSynchronizedOutput } from "./term-caps.ts"

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

describe("detectSynchronizedOutput", () => {
  it("returns supported=false immediately on a non-TTY", async () => {
    const stdin = new FakeStdin()
    stdin.isTTY = false
    const stdout = new FakeStdout()
    stdout.isTTY = false
    const result = await detectSynchronizedOutput(stdin as any, stdout as any, 50)
    expect(result.syncOutput).toBe(false)
    expect(result.unparsed).toBe("")
    // Did not even send the probe (no TTY → moot).
    expect(stdout.writes).toEqual([])
  })

  it("sends the DECRPM query and parses status=1 (currently set) as supported", async () => {
    const stdin = new FakeStdin()
    const stdout = new FakeStdout()
    const p = detectSynchronizedOutput(stdin as any, stdout as any, 200)
    // Yield so the probe sends its query and attaches the data listener.
    await Promise.resolve()
    expect(stdout.writes).toContain("\x1b[?2026$p")
    stdin.emit("data", "\x1b[?2026;1$y")
    const result = await p
    expect(result.syncOutput).toBe(true)
    expect(result.unparsed).toBe("")
  })

  it("parses status=2 (currently reset) as supported", async () => {
    const stdin = new FakeStdin()
    const stdout = new FakeStdout()
    const p = detectSynchronizedOutput(stdin as any, stdout as any, 200)
    await Promise.resolve()
    stdin.emit("data", "\x1b[?2026;2$y")
    expect((await p).syncOutput).toBe(true)
  })

  it("parses status=0 (mode not recognized) as unsupported", async () => {
    const stdin = new FakeStdin()
    const stdout = new FakeStdout()
    const p = detectSynchronizedOutput(stdin as any, stdout as any, 200)
    await Promise.resolve()
    stdin.emit("data", "\x1b[?2026;0$y")
    expect((await p).syncOutput).toBe(false)
  })

  it("times out and returns supported=false when the terminal never replies", async () => {
    const stdin = new FakeStdin()
    const stdout = new FakeStdout()
    const start = Date.now()
    const result = await detectSynchronizedOutput(stdin as any, stdout as any, 30)
    const elapsed = Date.now() - start
    expect(result.syncOutput).toBe(false)
    // Should have waited approximately the timeout, give or take scheduler jitter.
    expect(elapsed).toBeGreaterThanOrEqual(25)
    expect(elapsed).toBeLessThan(500)
  })

  it("preserves typeahead bytes that arrived alongside the DECRPM reply", async () => {
    const stdin = new FakeStdin()
    const stdout = new FakeStdout()
    const p = detectSynchronizedOutput(stdin as any, stdout as any, 200)
    await Promise.resolve()
    // The user managed to type 'h' 'i' before/after the reply landed.
    stdin.emit("data", "h")
    stdin.emit("data", "\x1b[?2026;1$y")
    stdin.emit("data", "i")
    // Note: the listener resolves on the FIRST chunk that completes the
    // match. The trailing 'i' arrives after detect() resolved; that's
    // fine — it lands on the next listener (the editor) since we already
    // detached. We assert the typeahead seen up to the resolve point.
    const result = await p
    expect(result.syncOutput).toBe(true)
    expect(result.unparsed).toBe("h")
  })

  it("removes its data listener after resolving (no leak)", async () => {
    const stdin = new FakeStdin()
    const stdout = new FakeStdout()
    const p = detectSynchronizedOutput(stdin as any, stdout as any, 50)
    await Promise.resolve()
    stdin.emit("data", "\x1b[?2026;1$y")
    await p
    expect(stdin.listenerCount("data")).toBe(0)
  })

  it("puts stdin into raw mode for the duration of the probe", async () => {
    const stdin = new FakeStdin()
    const stdout = new FakeStdout()
    const p = detectSynchronizedOutput(stdin as any, stdout as any, 50)
    await Promise.resolve()
    expect(stdin.rawModes).toEqual([true])
    stdin.emit("data", "\x1b[?2026;1$y")
    await p
    // We intentionally do NOT flip raw mode back to false here — the
    // editor sets its own raw mode immediately after, and a flip-flop
    // would cause a visible cursor blip on some terminals.
    expect(stdin.rawModes).toEqual([true])
  })
})
