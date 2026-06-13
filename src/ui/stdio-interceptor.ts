/**
 * Intercepts ALL writes to stdio and routes them through a
 * {@link Compositor}'s `writeStream` method so the live area stays in sync.
 *
 * Three places need to be intercepted:
 *
 *   1. `process.stdout.write` / `process.stderr.write` — patched in place.
 *   2. `console.log` / `console.error` / `console.warn` / `console.info`
 *      — Bun (and Node when console is constructed early) **do not** route
 *      these through `process.stderr.write`; they write directly to the
 *      underlying file descriptor. Patching `process.stderr.write` alone
 *      misses every `console.error` call. We swap the console methods so
 *      they format-and-forward to `process.stdout.write` /
 *      `process.stderr.write` (which ARE patched) — that round-trip puts
 *      them through the compositor.
 *   3. `rawStdoutWrite` / `rawStderrWrite` — escape hatches the compositor
 *      itself uses so its own escape sequences don't recurse.
 *
 * @module ui/stdio-interceptor
 */

import { format } from "node:util"

import { AnsiStreamBuffer } from "./terminal/ansi-stream.ts"

interface CompositorLike {
  writeStream(chunk: string): void
}

type WriteFn = (
  chunk: string | Uint8Array,
  encOrCb?: BufferEncoding | ((err?: Error | null) => void),
  cb?: (err?: Error | null) => void,
) => boolean

interface IOStreamLike {
  write: WriteFn
}

export interface StdioInterceptorOptions {
  stdout?: IOStreamLike
  stderr?: IOStreamLike
}

/**
 * Monkey-patches `process.stdout`/`stderr.write` (and the console methods)
 * to route every stray write through the compositor's scrollback path, so
 * third-party prints cannot tear the live area. Keeps the original write
 * functions for raw escape-hatch output and full uninstall, and buffers
 * partial ANSI sequences per stream so split escapes survive interception.
 */
export class StdioInterceptor {
  private readonly compositor: CompositorLike
  private readonly stdout: IOStreamLike
  private readonly stderr: IOStreamLike
  private readonly originalStdoutWrite: WriteFn
  private readonly originalStderrWrite: WriteFn
  private readonly stdoutAnsi = new AnsiStreamBuffer()
  private readonly stderrAnsi = new AnsiStreamBuffer()
  private originalConsole: {
    log: typeof console.log
    error: typeof console.error
    warn: typeof console.warn
    info: typeof console.info
    debug: typeof console.debug
  } | null = null
  private installed = false

  constructor(compositor: CompositorLike, opts: StdioInterceptorOptions = {}) {
    this.compositor = compositor
    this.stdout = opts.stdout ?? (process.stdout as unknown as IOStreamLike)
    this.stderr = opts.stderr ?? (process.stderr as unknown as IOStreamLike)
    this.originalStdoutWrite = this.stdout.write.bind(this.stdout) as WriteFn
    this.originalStderrWrite = this.stderr.write.bind(this.stderr) as WriteFn
  }

  install(): void {
    if (this.installed) return
    this.installed = true
    this.stdout.write = this.makeWrapper(this.stdoutAnsi)
    this.stderr.write = this.makeWrapper(this.stderrAnsi)
    // Bun's console.* writes directly to fd 1/2, bypassing
    // process.stdout.write / process.stderr.write entirely. Patch the
    // console methods to format-and-forward through the (now patched)
    // process streams so their output flows through the compositor.
    this.originalConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
      debug: console.debug,
    }
    const stdout = this.stdout
    const stderr = this.stderr
    console.log = (...args: unknown[]) => {
      stdout.write(format(...args) + "\n")
    }
    console.info = (...args: unknown[]) => {
      stdout.write(format(...args) + "\n")
    }
    console.debug = (...args: unknown[]) => {
      stderr.write(format(...args) + "\n")
    }
    console.warn = (...args: unknown[]) => {
      stderr.write(format(...args) + "\n")
    }
    console.error = (...args: unknown[]) => {
      stderr.write(format(...args) + "\n")
    }
  }

  uninstall(): void {
    if (!this.installed) return
    this.flushPending()
    this.installed = false
    this.stdout.write = this.originalStdoutWrite
    this.stderr.write = this.originalStderrWrite
    if (this.originalConsole) {
      console.log = this.originalConsole.log
      console.error = this.originalConsole.error
      console.warn = this.originalConsole.warn
      console.info = this.originalConsole.info
      console.debug = this.originalConsole.debug
      this.originalConsole = null
    }
  }

  /**
   * Direct-write escape hatch the compositor must use for its own escape
   * sequences, so they don't recurse through the wrapper and feed back
   * into `compositor.writeStream`.
   */
  rawStdoutWrite(chunk: string): boolean {
    return this.originalStdoutWrite(chunk)
  }

  rawStderrWrite(chunk: string): boolean {
    return this.originalStderrWrite(chunk)
  }

  private makeWrapper(buffer: AnsiStreamBuffer): WriteFn {
    const compositor = this.compositor
    return ((chunk, encOrCb, cb) => {
      const text =
        typeof chunk === "string"
          ? chunk
          : new TextDecoder(typeof encOrCb === "string" ? encOrCb : "utf-8").decode(chunk)
      const safe = buffer.push(text)
      if (safe.length > 0) compositor.writeStream(safe)
      const callback = typeof encOrCb === "function" ? encOrCb : cb
      if (typeof callback === "function") callback()
      return true
    }) as WriteFn
  }

  private flushPending(): void {
    const stdoutTail = this.stdoutAnsi.flush()
    if (stdoutTail.length > 0) this.compositor.writeStream(stdoutTail)
    const stderrTail = this.stderrAnsi.flush()
    if (stderrTail.length > 0) this.compositor.writeStream(stderrTail)
  }
}
