/**
 * Formatter module: pipe streamed text through an external Unix process.
 *
 * Spawns a formatter subprocess once when streaming starts, writes chunks
 * to its stdin as they arrive (with explicit flush for byte-level realtime),
 * and reads its stdout concurrently to display the formatted output.
 *
 * Designed for tools like:
 *   - mdstream (~/Projects/mdstream/target/debug/mdstream) — byte-level realtime markdown
 *   - bat --language=md --paging=never --color=always — line-level syntax highlighting
 *
 * Usage:
 *   const fmt = new Formatter(["mdstream"]);
 *   fmt.start();
 *   fmt.write("# Hello\n");
 *   fmt.write("**world**\n");
 *   await fmt.end();
 */

import type { Subprocess, FileSink } from "bun";

export class Formatter {
  private cmd: string[];
  private proc: Subprocess<"pipe", "pipe", "inherit"> | null = null;
  private stdin: FileSink | null = null;
  private displayPromise: Promise<void> | null = null;

  constructor(cmd: string[]) {
    if (cmd.length === 0) {
      throw new Error("Formatter requires at least one command argument");
    }
    this.cmd = cmd;
  }

  /**
   * Spawn the formatter process and start reading its stdout concurrently.
   * Must be called before write().
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
   * Write a chunk to the formatter's stdin.
   * IMPORTANT: Bun's FileSink buffers without explicit flush.
   * We call flush() after every write to get true byte-level realtime.
   */
  write(chunk: string): void {
    if (!this.stdin) {
      throw new Error("Formatter not started — call start() first");
    }
    this.stdin.write(chunk);
    this.stdin.flush();
  }

  /**
   * Close stdin, wait for the formatter to flush its remaining output,
   * and wait for the process to exit.
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
   * Force kill the process (e.g. on error).
   */
  kill(): void {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        // ignore
      }
      this.proc = null;
      this.stdin = null;
      this.displayPromise = null;
    }
  }
}

/**
 * Parse a formatter command string into argv.
 * Supports simple shell-like splitting (quoted args).
 *
 * Examples:
 *   "mdstream"                              -> ["mdstream"]
 *   "bat --language=md --paging=never"      -> ["bat", "--language=md", "--paging=never"]
 *   "/path/to/mdstream --padding 2"         -> ["/path/to/mdstream", "--padding", "2"]
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
