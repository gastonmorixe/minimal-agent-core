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

/**
 * Unset TMUX/STY for the duration of a probe test so the multiplexer
 * guard doesn't short-circuit it (we run inside tmux in dev).
 */
function withNoMultiplexer(fn: () => Promise<void>): () => Promise<void> {
  return async () => {
    const savedTmux = process.env.TMUX
    const savedSty = process.env.STY
    const savedTerm = process.env.TERM
    delete process.env.TMUX
    delete process.env.STY
    process.env.TERM = "xterm-256color"
    try {
      await fn()
    } finally {
      if (savedTmux !== undefined) process.env.TMUX = savedTmux
      if (savedSty !== undefined) process.env.STY = savedSty
      if (savedTerm !== undefined) process.env.TERM = savedTerm
    }
  }
}

describe("detectSynchronizedOutput", () => {
  it("returns supported=false immediately when inside tmux (TMUX env set)", async () => {
    const orig = process.env.TMUX
    process.env.TMUX = "/tmp/tmux-501/default,98738,26"
    try {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const result = await detectSynchronizedOutput(stdin as any, stdout as any, 50)
      expect(result.syncOutput).toBe(false)
      expect(result.unparsed).toBe("")
      expect(stdout.writes).toEqual([])
    } finally {
      if (orig === undefined) delete process.env.TMUX
      else process.env.TMUX = orig
    }
  })

  it("returns supported=false immediately on a non-TTY", async () => {
    const stdin = new FakeStdin()
    stdin.isTTY = false
    const stdout = new FakeStdout()
    stdout.isTTY = false
    const result = await detectSynchronizedOutput(stdin as any, stdout as any, 50)
    expect(result.syncOutput).toBe(false)
    expect(result.unparsed).toBe("")
    expect(stdout.writes).toEqual([])
  })

  it(
    "sends the DECRPM query and parses status=1 (currently set) as supported",
    withNoMultiplexer(async () => {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const p = detectSynchronizedOutput(stdin as any, stdout as any, 200)
      await Promise.resolve()
      expect(stdout.writes).toContain("\x1b[?2026$p")
      stdin.emit("data", "\x1b[?2026;1$y")
      const result = await p
      expect(result.syncOutput).toBe(true)
      expect(result.unparsed).toBe("")
    }),
  )

  it(
    "parses status=2 (currently reset) as supported",
    withNoMultiplexer(async () => {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const p = detectSynchronizedOutput(stdin as any, stdout as any, 200)
      await Promise.resolve()
      stdin.emit("data", "\x1b[?2026;2$y")
      expect((await p).syncOutput).toBe(true)
    }),
  )

  it(
    "parses status=0 (mode not recognized) as unsupported",
    withNoMultiplexer(async () => {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const p = detectSynchronizedOutput(stdin as any, stdout as any, 200)
      await Promise.resolve()
      stdin.emit("data", "\x1b[?2026;0$y")
      expect((await p).syncOutput).toBe(false)
    }),
  )

  it(
    "times out and returns supported=false when the terminal never replies",
    withNoMultiplexer(async () => {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const start = Date.now()
      const result = await detectSynchronizedOutput(stdin as any, stdout as any, 30)
      const elapsed = Date.now() - start
      expect(result.syncOutput).toBe(false)
      expect(elapsed).toBeGreaterThanOrEqual(25)
      expect(elapsed).toBeLessThan(500)
    }),
  )

  it(
    "preserves typeahead bytes that arrived alongside the DECRPM reply",
    withNoMultiplexer(async () => {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const p = detectSynchronizedOutput(stdin as any, stdout as any, 200)
      await Promise.resolve()
      stdin.emit("data", "h")
      stdin.emit("data", "\x1b[?2026;1$y")
      stdin.emit("data", "i")
      const result = await p
      expect(result.syncOutput).toBe(true)
      expect(result.unparsed).toBe("h")
    }),
  )

  it(
    "removes its data listener after resolving (no leak)",
    withNoMultiplexer(async () => {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const p = detectSynchronizedOutput(stdin as any, stdout as any, 50)
      await Promise.resolve()
      stdin.emit("data", "\x1b[?2026;1$y")
      await p
      expect(stdin.listenerCount("data")).toBe(0)
    }),
  )

  it(
    "puts stdin into raw mode for the duration of the probe",
    withNoMultiplexer(async () => {
      const stdin = new FakeStdin()
      const stdout = new FakeStdout()
      const p = detectSynchronizedOutput(stdin as any, stdout as any, 50)
      await Promise.resolve()
      expect(stdin.rawModes).toEqual([true])
      stdin.emit("data", "\x1b[?2026;1$y")
      await p
      expect(stdin.rawModes).toEqual([true])
    }),
  )
})
