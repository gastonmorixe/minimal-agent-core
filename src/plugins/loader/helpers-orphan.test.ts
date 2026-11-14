/**
 * Integration: a subprocess plugin handler must not outlive the host.
 *
 * `invokeSubprocess` spawns the handler with `detached: true`, so the
 * handler leads its own session and process group
 * (https://bun.com/reference/bun/Spawn/SpawnOptions/detached). Bun kills no
 * child on exit, so before the child registry a handler in flight at exit
 * became an orphan. The case runs a real host (`bun -e`) that starts a
 * handler, then gets SIGTERM and calls `process.exit(143)` the way the CLI
 * signal hooks do. The handler
 * prints its pid on stderr (inherited by the host). The test checks it.
 */
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { childRegistry } from "../../infra/child-registry.ts"
import type { ToolHandlerContext } from "../types.ts"

import { invokeSubprocess } from "./helpers.ts"

const HELPERS = join(import.meta.dir, "helpers.ts")

/** Pids that a case started. afterEach kills them by exact pid. */
const started: number[] = []

afterEach(() => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      /* already gone */
    }
  }
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await Bun.sleep(50)
  }
  return !alive(pid)
}

async function readPid(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let acc = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      acc += decoder.decode(value, { stream: true })
      const m = acc.match(/PID=(\d+)/)
      if (m) return Number(m[1])
    }
  } finally {
    reader.releaseLock()
  }
  throw new Error(`host printed no PID line: ${JSON.stringify(acc)}`)
}

/** Handler body: report the pid on stderr, then hang. */
const HANDLER = 'process.stderr.write("PID=" + process.pid + "\\n"); await Bun.sleep(300_000)'

describe("subprocess plugin handlers die with the host process", () => {
  it("a handler in flight dies when the host gets SIGTERM and calls process.exit(143)", async () => {
    const root = join(import.meta.dir, "..", "..", "..")
    const host = Bun.spawn(
      [
        process.execPath,
        "-e",
        [
          `import { invokeSubprocess } from ${JSON.stringify(HELPERS)}`,
          `void invokeSubprocess(process.execPath, ["-e", ${JSON.stringify(HANDLER)}], {`,
          `  trigger: { type: "tool", name: "Slow", input: {}, tool_use_id: "t1" },`,
          `  packageDir: ${JSON.stringify(root)},`,
          `  cwd: ${JSON.stringify(root)},`,
          "  env: { ...process.env },",
          "  log: () => {},",
          "})",
          `process.on("SIGTERM", () => process.exit(143))`,
        ].join("\n"),
      ],
      { cwd: root, stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    )
    started.push(host.pid)
    const pid = await readPid(host.stderr)
    started.push(pid)
    expect(alive(pid)).toBe(true)
    host.kill("SIGTERM")
    expect(await host.exited).toBe(143)
    expect(await goneWithin(pid, 2000)).toBe(true)
  }, 15_000)

  it("a handler that exits with no child leaves no registry entry", async () => {
    const root = join(import.meta.dir, "..", "..", "..")
    const before = new Set(childRegistry.pids())
    const r = await invokeSubprocess(process.execPath, ["-e", 'process.stdout.write("ok")'], {
      trigger: { type: "tool", name: "Quick", input: {}, tool_use_id: "t2" },
      packageDir: root,
      cwd: root,
      env: { ...process.env } as Record<string, string>,
      log: () => {},
    } as unknown as ToolHandlerContext)
    expect(r).toEqual({ kind: "tool_result", content: "ok", is_error: false })
    expect(childRegistry.pids().filter((x) => !before.has(x))).toEqual([])
  }, 15_000)
})
