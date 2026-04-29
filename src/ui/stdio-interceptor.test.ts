/**
 * Tests for {@link StdioInterceptor}.
 *
 * The interceptor's job: while installed, every `process.stdout.write` and
 * `process.stderr.write` call (including ones from `console.log` /
 * `console.error` / library code) must be redirected to
 * `compositor.writeStream`, AND the compositor's own writes (which would
 * otherwise recurse) must continue to reach the real terminal.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { StdioInterceptor } from "./stdio-interceptor.ts"

class FakeCompositor {
  readonly streams: string[] = []
  writeStream(chunk: string): void {
    this.streams.push(chunk)
  }
}

const restorers: Array<() => void> = []
afterEach(() => {
  while (restorers.length) {
    const r = restorers.pop()
    if (r) r()
  }
})

function installOn(target: any, comp: FakeCompositor): StdioInterceptor {
  const i = new StdioInterceptor(comp as any, {
    stdout: target.stdout,
    stderr: target.stderr,
  })
  i.install()
  restorers.push(() => i.uninstall())
  return i
}

function makeFakeStream() {
  const calls: Array<string> = []
  return {
    calls,
    stream: {
      write(chunk: string | Uint8Array, encOrCb?: any, cb?: any): boolean {
        calls.push(
          typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk as Uint8Array),
        )
        const fn = typeof encOrCb === "function" ? encOrCb : cb
        if (typeof fn === "function") fn()
        return true
      },
    },
  }
}

describe("StdioInterceptor", () => {
  it("redirects stdout writes through compositor.writeStream while installed", () => {
    const out = makeFakeStream()
    const err = makeFakeStream()
    const comp = new FakeCompositor()
    installOn({ stdout: out.stream, stderr: err.stream }, comp)

    out.stream.write("hello\n")

    expect(comp.streams).toEqual(["hello\n"])
    // Original stream NOT written to directly while intercepted.
    expect(out.calls).toEqual([])
  })

  it("redirects stderr writes too (so debug logging via console.error is captured)", () => {
    const out = makeFakeStream()
    const err = makeFakeStream()
    const comp = new FakeCompositor()
    installOn({ stdout: out.stream, stderr: err.stream }, comp)

    err.stream.write("warning!\n")

    expect(comp.streams).toEqual(["warning!\n"])
    expect(err.calls).toEqual([])
  })

  it("compositor.writeStream's OWN underlying writes still reach the real stream (no recursion)", () => {
    const out = makeFakeStream()
    const err = makeFakeStream()
    const comp = new FakeCompositor()
    const i = installOn({ stdout: out.stream, stderr: err.stream }, comp)

    // Simulate the compositor wanting to draw an escape sequence.
    i.rawStdoutWrite("\x1b[?25l")

    expect(out.calls).toEqual(["\x1b[?25l"])
    // It did NOT go back through the wrapper / compositor.
    expect(comp.streams).toEqual([])
  })

  it("uninstall stops intercepting and writes go straight through again", () => {
    const out = makeFakeStream()
    const err = makeFakeStream()
    const comp = new FakeCompositor()
    const i = installOn({ stdout: out.stream, stderr: err.stream }, comp)
    out.stream.write("during")
    i.uninstall()
    restorers.pop() // we just uninstalled it
    out.stream.write("after")
    expect(comp.streams).toEqual(["during"])
    expect(out.calls).toEqual(["after"])
  })

  it("forwards the optional write() callback so back-pressure callers don't hang", () => {
    const out = makeFakeStream()
    const err = makeFakeStream()
    const comp = new FakeCompositor()
    installOn({ stdout: out.stream, stderr: err.stream }, comp)

    let cbCalled = false
    out.stream.write("x", (() => {
      cbCalled = true
    }) as any)
    expect(cbCalled).toBe(true)
  })

  it("intercepts console.log / console.error too (Bun bypasses process.stdout/stderr.write)", () => {
    const out = makeFakeStream()
    const err = makeFakeStream()
    const comp = new FakeCompositor()
    installOn({ stdout: out.stream, stderr: err.stream }, comp)

    console.log("hi from log")
    console.error("hi from error")
    console.warn("hi from warn")
    console.info("hi from info")

    expect(comp.streams).toEqual([
      "hi from log\n",
      "hi from error\n",
      "hi from warn\n",
      "hi from info\n",
    ])
  })

  it("formats console args like Node's util.format (numbers, objects)", () => {
    const out = makeFakeStream()
    const err = makeFakeStream()
    const comp = new FakeCompositor()
    installOn({ stdout: out.stream, stderr: err.stream }, comp)

    console.log("count:", 42, { a: 1 })
    expect(comp.streams[0]).toContain("count: 42")
    expect(comp.streams[0]).toContain("a: 1")
  })

  it("uninstall restores the original console methods", () => {
    const out = makeFakeStream()
    const err = makeFakeStream()
    const comp = new FakeCompositor()
    const origLog = console.log
    const i = installOn({ stdout: out.stream, stderr: err.stream }, comp)
    expect(console.log).not.toBe(origLog)
    i.uninstall()
    restorers.pop()
    expect(console.log).toBe(origLog)
  })

  it("decodes Buffer/Uint8Array chunks to strings before forwarding", () => {
    const out = makeFakeStream()
    const err = makeFakeStream()
    const comp = new FakeCompositor()
    installOn({ stdout: out.stream, stderr: err.stream }, comp)

    const bytes = new TextEncoder().encode("héllo")
    out.stream.write(bytes)
    expect(comp.streams).toEqual(["héllo"])
  })

  it("keeps partial ANSI state separate for stdout and stderr", () => {
    const out = makeFakeStream()
    const err = makeFakeStream()
    const comp = new FakeCompositor()
    installOn({ stdout: out.stream, stderr: err.stream }, comp)

    err.stream.write("\x1b[31")
    out.stream.write("plain")
    err.stream.write("mred\x1b[0m")

    expect(comp.streams).toEqual(["plain", "\x1b[31mred\x1b[0m"])
  })
})
