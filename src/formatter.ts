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
 * @module formatter
 */

import type { Subprocess, FileSink } from "bun";

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
  private cmd: string[];
  /** Active subprocess handle, or null when stopped. */
  private proc: Subprocess<"pipe", "pipe", "inherit"> | null = null;
  /** Bun FileSink for the subprocess's stdin (requires explicit flush). */
  private stdin: FileSink | null = null;
  /** Background task that drains the subprocess's stdout to our stdout. */
  private displayPromise: Promise<void> | null = null;

  /**
   * @param cmd - Command argv. Must contain at least the executable name.
   *   Use {@link parseFormatterCommand} to convert a shell-style string.
   * @throws Error if `cmd` is empty.
   */
  constructor(cmd: string[]) {
    if (cmd.length === 0) {
      throw new Error("Formatter requires at least one command argument");
    }
    this.cmd = cmd;
  }

  /**
   * Spawn the formatter process and start a background reader that drains
   * its stdout to `process.stdout`. Idempotent — calling twice is a no-op.
   *
   * Stderr is inherited so the formatter's error messages are visible
   * directly (useful for debugging missing fonts, ANSI issues, etc.).
   */
  start(): void {
    if (this.proc) return;

    this.proc = Bun.spawn(this.cmd, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    }) as Subprocess<"pipe", "pipe", "inherit">;

    this.stdin = this.proc.stdin;

    // Read stdout concurrently and pipe straight to our stdout.
    // The for-await loop runs in parallel with write() calls.
    this.displayPromise = (async () => {
      for await (const chunk of this.proc!.stdout) {
        process.stdout.write(chunk);
      }
    })();
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
      throw new Error("Formatter not started — call start() first");
    }
    this.stdin.write(chunk);
    this.stdin.flush();
  }

  /**
   * Close stdin (signaling EOF to the formatter), wait for the background
   * reader to drain any remaining output, and wait for the subprocess to
   * exit. Idempotent — safe to call from a `finally` block.
   */
  async end(): Promise<void> {
    if (!this.proc || !this.stdin) return;

    this.stdin.end();
    await this.displayPromise;
    await this.proc.exited;

    this.proc = null;
    this.stdin = null;
    this.displayPromise = null;
  }

  /**
   * Force-kill the subprocess immediately. Use only on unrecoverable errors;
   * prefer {@link end} for graceful shutdown. After calling `kill()`, the
   * formatter must be `start()`ed again before further writes.
   */
  kill(): void {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // ignore — process may have already exited
      }
      this.proc = null;
      this.stdin = null;
      this.displayPromise = null;
    }
  }
}

/**
 * Parse a formatter command string into a `Bun.spawn`-compatible argv array.
 *
 * Supports simple shell-like splitting: whitespace separates tokens, but
 * single and double quoted strings are treated as one token. Does NOT
 * support backslash escaping, variable expansion, pipes, or redirects —
 * if you need those, do shell parsing yourself.
 *
 * @param cmd - Shell-style command string
 * @returns argv array suitable for `Bun.spawn` or `Formatter` constructor
 *
 * @example
 * ```ts
 * parseFormatterCommand("mdstream")
 * // ["mdstream"]
 *
 * parseFormatterCommand("bat --language=md --paging=never")
 * // ["bat", "--language=md", "--paging=never"]
 *
 * parseFormatterCommand("/path/to/fmt --title 'My Doc'")
 * // ["/path/to/fmt", "--title", "My Doc"]
 * ```
 */
export function parseFormatterCommand(cmd: string): string[] {
  const args: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(cmd)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}
