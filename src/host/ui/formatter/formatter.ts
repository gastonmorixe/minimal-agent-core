/**
 * Formatter module: pipe streamed text through an external Unix process.
 *
 * Spawns a formatter subprocess once when streaming starts, writes chunks to
 * its stdin as they arrive (with explicit flush for byte-level realtime),
 * and reads its stdout concurrently to display the formatted output. The
 * subprocess persists for the entire stream — it is NOT re-spawned per chunk.
 *
 * **Designed for tools like:**
 * - `mdstream` — byte-level realtime markdown renderer (Rust)
 * - `bat --language=md --paging=never --color=always --style=plain` — line-level
 *   syntax highlighting via `bat`
 *
 * **Critical Bun gotcha**: `proc.stdin` returned by `Bun.spawn({stdin:"pipe"})`
 * is a `FileSink`, not a `WritableStream`. Without an explicit `.flush()` call
 * after each `.write()`, data sits in an internal buffer instead of reaching
 * the subprocess. {@link Formatter.write} calls `flush()` on every write, so
 * upstream callers don't need to think about it.
 *
 * **Backpressure**: not implemented. The current API is fire-and-forget. For
 * the use case (streaming a few KB/sec from an LLM through a fast formatter)
 * this is fine. If you ever pipe high-bandwidth data, you'd need to await
 * the result of `stdin.write()` and handle drain events.
 *
 * @example
 * ```ts
 * const fmt = new Formatter(["mdstream"]);
 * fmt.start();
 * for await (const chunk of someAsyncGenerator()) {
 *   fmt.write(chunk);
 * }
 * await fmt.end();
 * ```
 *
 * @module ui/formatter/formatter
 */

import type { FileSink, Subprocess } from "bun"

import { AnsiStreamBuffer } from "../terminal/ansi-stream.ts"

type FormatterOutput = Pick<NodeJS.WriteStream, "write"> & {
  columns?: number
  rows?: number
}

/**
 * Wraps an external formatter subprocess and pipes byte-level streamed text
 * to it in realtime.
 *
 * **Lifecycle**: `new` → `start()` → `write()` (many) → `end()`. Calling
 * `start()` twice is a no-op. Calling `write()` before `start()` throws.
 * `end()` is idempotent — safe to call from a `finally` block.
 *
 * @example
 * ```ts
 * const fmt = new Formatter(["bat", "--language=md", "--paging=never"]);
 * fmt.start();
 * try {
 *   for await (const chunk of stream) fmt.write(chunk);
 * } finally {
 *   await fmt.end();
 * }
 * ```
 */
export class Formatter {
  /** Command argv to spawn (cmd[0] is the executable). */
  private cmd: string[]
  /** Output sink for formatted stdout. Defaults to process.stdout. */
  private output: FormatterOutput
  /** Active subprocess handle, or null when stopped. */
  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null
  /** Bun FileSink for the subprocess's stdin (requires explicit flush). */
  private stdin: FileSink | null = null
  /** Background task that drains the subprocess's stdout to our stdout. */
  private displayPromise: Promise<void> | null = null
  /** Tracks whether the formatter's first stdout chunk has been normalized yet. */
  private normalizedFirstChunk = false
  /**
   * Holds any partial CSI / OSC at the end of a stdout chunk so the
   * compositor never sees a write that ends mid-escape — otherwise the
   * live-area erase/redraw sequences we splice in afterwards get
   * absorbed into the broken escape and the terminal prints fragments
   * like `[1m` as literal text. See {@link AnsiStreamBuffer}.
   */
  private readonly stdoutAnsiBuffer = new AnsiStreamBuffer()
  /** Same protection for formatter stderr, which is also routed via output. */
  private readonly stderrAnsiBuffer = new AnsiStreamBuffer()

  /**
   * Create a formatter subprocess wrapper.
   *
   * @param cmd - Command argv. Must contain at least the executable name.
   *   Use {@link parseFormatterCommand} to convert a shell-style string.
   * @throws Error if `cmd` is empty.
   */
  constructor(cmd: string[], output: FormatterOutput = process.stdout) {
    if (cmd.length === 0) {
      throw new Error("Formatter requires at least one command argument")
    }
    this.cmd = cmd
    this.output = output
  }

  /**
   * Spawn the formatter process and start a background reader that drains
   * its stdout to `process.stdout`. Idempotent — calling twice is a no-op.
   *
   * Stderr is inherited so the formatter's error messages are visible
   * directly (useful for debugging missing fonts, ANSI issues, etc.).
   */
  start(): void {
    if (this.proc) return

    this.proc = Bun.spawn(this.cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: formatterEnv(this.output),
    })

    this.stdin = this.proc.stdin
    this.normalizedFirstChunk = false
    this.stdoutAnsiBuffer.flush()
    this.stderrAnsiBuffer.flush()

    // Read stdout and stderr concurrently and pipe them through the configured
    // output sink. Stderr must not inherit the real fd in live-area mode
    // because raw child writes would bypass the compositor and corrupt the UI.
    // The for-await loop runs in parallel with write() calls.
    this.displayPromise = Promise.all([
      this.drainOutput(this.proc.stdout, this.stdoutAnsiBuffer, true),
      this.drainOutput(this.proc.stderr, this.stderrAnsiBuffer, false),
    ]).then(() => undefined)
  }

  /**
   * Write a chunk to the formatter's stdin and flush immediately.
   *
   * **Why flush every time**: Bun's `FileSink` accumulates writes in an
   * internal buffer. Without `.flush()`, the formatter sees nothing until
   * the buffer fills (kilobytes later) or `.end()` is called. For
   * byte-level realtime rendering (mdstream's headline use case), every
   * write must flush.
   *
   * @param chunk - Text to write to the formatter
   * @throws Error if {@link start} hasn't been called yet
   */
  write(chunk: string): void {
    if (!this.stdin) {
      throw new Error("Formatter not started — call start() first")
    }
    void this.stdin.write(chunk)
    void this.stdin.flush()
  }

  /**
   * Close stdin (signaling EOF to the formatter), wait for the background
   * reader to drain any remaining output, and wait for the subprocess to
   * exit. Idempotent — safe to call from a `finally` block.
   */
  async end(): Promise<void> {
    if (!this.proc || !this.stdin) return

    void this.stdin.end()
    await this.displayPromise
    await this.proc.exited

    this.proc = null
    this.stdin = null
    this.displayPromise = null
  }

  private normalizeOutputChunk(chunk: Uint8Array): Uint8Array | null {
    if (this.normalizedFirstChunk) {
      return chunk
    }

    this.normalizedFirstChunk = true
    if (chunk.length >= 2 && chunk[0] === 0x0d && chunk[1] === 0x0a) {
      return chunk.length > 2 ? chunk.slice(2) : null
    }
    if (chunk[0] === 0x0a) {
      return chunk.length > 1 ? chunk.slice(1) : null
    }

    return chunk
  }

  private async drainOutput(
    stream: ReadableStream<Uint8Array>,
    ansiBuffer: AnsiStreamBuffer,
    normalizeFirstChunk: boolean,
  ): Promise<void> {
    const decoder = new TextDecoder()
    for await (const chunk of stream) {
      const normalized = normalizeFirstChunk ? this.normalizeOutputChunk(chunk) : chunk
      if (!normalized) continue
      const text = decoder.decode(normalized, { stream: true })
      const safe = ansiBuffer.push(text)
      if (safe.length > 0) this.output.write(safe)
    }
    const tail = decoder.decode() + ansiBuffer.flush()
    if (tail.length > 0) this.output.write(tail)
  }

  /**
   * Force-kill the subprocess immediately. Use only on unrecoverable errors;
   * prefer {@link end} for graceful shutdown. After calling `kill()`, the
   * formatter must be `start()`ed again before further writes.
   */
  kill(): void {
    if (this.proc) {
      try {
        this.proc.kill()
      } catch {
        // ignore — process may have already exited
      }
      this.proc = null
      this.stdin = null
      this.displayPromise = null
      this.stdoutAnsiBuffer.flush()
      this.stderrAnsiBuffer.flush()
    }
  }
}

/**
 * Parse a formatter command string into a `Bun.spawn`-compatible argv array.
 *
 * Re-exported from the leaf `@minimal-agent/plugin-api` package so the host
 * formatter, the CLI entry, and core config tokenize identically. Kept on
 * this path for back-compat with existing importers.
 *
 * @see parseFormatterCommand in `@minimal-agent/plugin-api/utils/shell-args`
 */
export { parseFormatterCommand } from "@minimal-agent/plugin-api/utils/shell-args"

/**
 * Build the env passed to the formatter subprocess. We export `COLUMNS`
 * and `LINES` from the host's view of the controlling terminal so the
 * child renders to the same surface the compositor is tracking.
 *
 * **`COLUMNS` is load-bearing for `mdstream` ≥ 0.2.2.** Earlier
 * versions ignored `COLUMNS` and queried `/dev/tty` directly, which can
 * disagree with `process.stdout.columns` (multiplexer indirection,
 * mid-stream resize observed at different times). The mismatch surfaced
 * as duplicate paragraphs in scrollback: mdstream computed the wrong
 * partial-redraw row count and only cleared the bottom wrap row,
 * stranding the top row of raw markdown above the rendered version.
 *
 * We do NOT refresh `COLUMNS` mid-stream on `SIGWINCH`. The formatter is
 * spawned once per session, so a resize between spawn and a flush is
 * still possible. mdstream 0.2.2 mitigates that on its side by tracking
 * the wrap row count incrementally as bytes are emitted (using whatever
 * width was live at each emit) — see mdstream's CHANGELOG entry under
 * the unreleased section.
 */
function formatterEnv(output: FormatterOutput): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  if (Number.isFinite(output.columns) && output.columns && output.columns > 0) {
    env.COLUMNS = String(Math.floor(output.columns))
  }
  if (Number.isFinite(output.rows) && output.rows && output.rows > 0) {
    env.LINES = String(Math.floor(output.rows))
  }
  return env
}
