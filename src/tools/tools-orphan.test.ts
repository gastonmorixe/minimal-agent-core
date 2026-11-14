/**
 * Integration: a Bash tool child must not outlive the host process.
 *
 * The Bash tool spawns `bash -c` with `detached: true`, so bash leads its
 * own session and process group (https://bun.com/reference/bun/Spawn/SpawnOptions/detached).
 * Bun kills no child on exit, so before the child registry a background
 * `sleep` (or a command in flight at exit) became an orphan. Each case runs
 * a real host (`bun -e`) that calls `executeTool` and then exits the way
 * the CLI does (`process.exit`). The test then checks the exact sleep pid.
 */
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { childRegistry } from "../infra/child-registry.ts"

import { executeTool } from "./tools.ts"

const TOOLS = join(import.meta.dir, "tools.ts")

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

/** Poll until `pid` is gone, up to `ms`. Returns true when gone. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (!alive(pid)) return true
    await Bun.sleep(50)
  }
  return !alive(pid)
}

/** Spawn a host process that runs `source` with `bun -e`. */
function spawnHost(source: string) {
  return Bun.spawn([process.execPath, "-e", source], {
    cwd: join(import.meta.dir, "..", ".."),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
}

/** Read stdout until a `PID=<n>` line arrives. */
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

describe("Bash tool children die with the host process", () => {
  it("a background child of a finished command dies on process.exit(0)", async () => {
    // The redirect keeps sleep off the stdout pipe, so the Bash tool
    // returns when bash exits and does not wait 300 s for the pipe.
    const host = spawnHost(
      [
        `import { executeTool } from ${JSON.stringify(TOOLS)}`,
        `const r = await executeTool("Bash", { command: "sleep 300 >/dev/null 2>&1 & echo $!" }, {})`,
        `process.stdout.write("PID=" + String(r.content).trim() + "\\n")`,
        "process.exit(0)",
      ].join("\n"),
    )
    const pid = await readPid(host.stdout)
    started.push(pid)
    await host.exited
    expect(await goneWithin(pid, 2000)).toBe(true)
  }, 15_000)

  it("a command in flight dies when the host gets SIGHUP and calls process.exit(129)", async () => {
    // `exec` turns bash into sleep, so `$$` is the sleep pid. The SIGHUP
    // listener matches the CLI hooks (input.ts, editor-controller.ts).
    const host = spawnHost(
      [
        `import { executeTool } from ${JSON.stringify(TOOLS)}`,
        `process.on("SIGHUP", () => process.exit(129))`,
        `void executeTool("Bash", { command: "echo PID=$$; exec sleep 300" }, {`,
        `  onStdout: (s) => process.stdout.write(s),`,
        `})`,
      ].join("\n"),
    )
    const pid = await readPid(host.stdout)
    started.push(pid)
    expect(alive(pid)).toBe(true)
    host.kill("SIGHUP")
    expect(await host.exited).toBe(129)
    expect(await goneWithin(pid, 2000)).toBe(true)
  }, 15_000)
})

describe("Bash tool registry entries", () => {
  it("a finished command with no child leaves no entry, a `cmd &` child keeps its entry", async () => {
    const before = new Set(childRegistry.pids())
    const fresh = () => childRegistry.pids().filter((x) => !before.has(x))

    await executeTool("Bash", { command: "true" }, {})
    expect(fresh()).toEqual([])

    const r = await executeTool("Bash", { command: "sleep 300 >/dev/null 2>&1 & echo $!" }, {})
    const sleepPid = Number(r.content.trim())
    started.push(sleepPid)
    expect(sleepPid).toBeGreaterThan(1)
    // The bash leader exited, but `sleep` still lives in its group.
    expect(fresh().length).toBe(1)
    const [pgid] = fresh()
    // Unregister by hand so this test process's exit listener has no work.
    process.kill(sleepPid, "SIGKILL")
    expect(await goneWithin(sleepPid, 2000)).toBe(true)
    expect(childRegistry.releaseIfGone(pgid)).toBe(true)
  }, 15_000)
})
