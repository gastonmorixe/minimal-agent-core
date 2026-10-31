/**
 * The stream-json tail must survive the exit code 1 on the waiting path.
 *
 * When a run pauses (outcome `waiting`), the route ends with exit code 1
 * right after the last line. On Bun 1.4.x, `process.exit` can drop large
 * writes still queued for a pipe when the reader is slow (measured: 1 MB and
 * 4 MB lost 5 of 5 runs). So the route sets `process.exitCode` and returns.
 * This test spawns a child that runs the real route with the real
 * `process.stdout` and the real exit path, then reads its stdout slowly.
 * Every line must parse, the last line must be `run_finished` with outcome
 * `waiting`, and the child must end by itself with code 1.
 *
 * Limit: the child calls `runNonInteractivePrompt` directly. It does not go
 * through `src/index.ts`. The CLI test transport always completes, so a
 * paused run cannot be reached through the real CLI.
 *
 * @module host/startup/stream-json-exit-tail.test
 */

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

const CHILD = join(import.meta.dir, "fixtures", "stream-json-exit-child.ts")
const RUNS = 5

/** Read a stream with a 5 ms pause between reads, like a slow consumer. */
async function readSlowly(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    chunks.push(value)
    await Bun.sleep(5)
  }
  return Buffer.concat(chunks).toString("utf8")
}

/** The child must end by itself. A hang past this is a test failure. */
const END_BY_ITSELF_MS = 30000

async function runChild(bytes: number): Promise<{ exitCode: number; stdout: string }> {
  const p = Bun.spawn(["bun", "run", CHILD, String(bytes)], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const hang = Bun.sleep(END_BY_ITSELF_MS).then(() => "hang" as const)
  const done = Promise.all([p.exited, readSlowly(p.stdout)])
  const first = await Promise.race([done, hang])
  if (first === "hang") {
    p.kill("SIGKILL")
    throw new Error(`child did not end by itself within ${END_BY_ITSELF_MS} ms (open handle?)`)
  }
  const [exitCode, stdout] = first
  return { exitCode, stdout }
}

describe("stream-json tail on the exit(1) waiting path", () => {
  for (const bytes of [70_000, 1_000_000, 4_000_000]) {
    it(
      `${bytes} bytes of text, slow reader: last line is run_finished waiting, every run`,
      async () => {
        let lost = 0
        for (let i = 0; i < RUNS; i++) {
          const { exitCode, stdout } = await runChild(bytes)
          expect(exitCode).toBe(1)
          const lines = stdout.split("\n").filter((l) => l.length > 0)
          let last: Record<string, unknown> | undefined
          try {
            last = JSON.parse(lines.at(-1) ?? "") as Record<string, unknown>
          } catch {
            last = undefined
          }
          if (last?.type !== "run_finished" || last.outcome !== "waiting") lost++
        }
        expect(lost).toBe(0)
      },
      RUNS * 60000,
    )
  }
})
