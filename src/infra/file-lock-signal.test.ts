/**
 * The file-lock SIGINT/SIGTERM listener and the plugin signal fan-out
 * protocol (`Symbol.for("minimal-agent.signal-fanout")`), in a REAL child
 * process with a real signal.
 *
 * - The lock listener is a tagged fan-out. With only fan-outs (the lock
 *   listener and a plugin fan-out), SIGTERM ends the process with 143 and
 *   the lock file is gone. Before this fix, each side counted the other as
 *   an owner and the process stayed alive.
 * - With an untagged owner (for example the headless wrap-up), nothing
 *   exits until the owner exits. Then the `exit` hook removes the lock.
 *
 * The plugin fan-outs are copies of the two plugin listeners (ma-hooks
 * `engine/runner.ts` `onCleanupSignal`, ma-background `lib/registry.ts`
 * `signalListener`): count the owners, and with no owner remove itself and
 * raise the signal again.
 *
 * @module infra/file-lock-signal.test
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { SIGNAL_FANOUT, signalOwnerCount } from "./file-lock.ts"

const LOCK_MODULE = join(import.meta.dir, "file-lock.ts")

/** A plugin-style fan-out listener (the protocol of runner.ts / registry.ts). */
const PLUGIN_FANOUT = [
  `const FANOUT = Symbol.for("minimal-agent.signal-fanout")`,
  `const owners = (sig) => process.listeners(sig).filter((l) => l[FANOUT] !== true).length`,
  `const fanout = () => {`,
  `  if (owners("SIGTERM") > 0) return`,
  `  process.removeListener("SIGTERM", fanout)`,
  `  process.kill(process.pid, "SIGTERM")`,
  `}`,
  `fanout[FANOUT] = true`,
].join("\n")

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "file-lock-signal-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Spawn a host that takes a lock on `target`, then runs `setup`. */
function spawnHost(target: string, setup: string, fanoutFirst = false) {
  const source = [
    `import { acquireLock } from ${JSON.stringify(LOCK_MODULE)}`,
    PLUGIN_FANOUT,
    fanoutFirst ? `process.on("SIGTERM", fanout)` : "",
    `await acquireLock(${JSON.stringify(target)}, { sessionId: "s", tool: "Edit" })`,
    fanoutFirst ? "" : `process.on("SIGTERM", fanout)`,
    setup,
    `setInterval(() => {}, 1000)`,
    `process.stdout.write("READY\\n")`,
  ].join("\n")
  const script = join(dir, "host.ts")
  writeFileSync(script, source)
  return Bun.spawn([process.execPath, script], {
    cwd: dir,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
}

/** Read stdout until `READY`. */
async function waitReady(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let acc = ""
  try {
    while (!acc.includes("READY")) {
      const { done, value } = await reader.read()
      if (done) throw new Error(`host printed no READY line: ${JSON.stringify(acc)}`)
      acc += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

/** Resolve with the exit code, or `null` when the process is alive after `ms`. */
async function exitWithin(p: { exited: Promise<number> }, ms: number): Promise<number | null> {
  return await Promise.race([p.exited, Bun.sleep(ms).then(() => null)])
}

describe("file-lock signal listener (fan-out protocol)", () => {
  it("is tagged as a fan-out, so it is never an owner", () => {
    expect(SIGNAL_FANOUT as symbol).toBe(Symbol.for("minimal-agent.signal-fanout"))
    const tagged = Object.assign(() => {}, { [SIGNAL_FANOUT]: true })
    const before = signalOwnerCount("SIGUSR2")
    process.on("SIGUSR2", tagged)
    try {
      expect(signalOwnerCount("SIGUSR2")).toBe(before)
    } finally {
      process.removeListener("SIGUSR2", tagged)
    }
  })

  for (const fanoutFirst of [false, true]) {
    it(`lock listener + one plugin fan-out (fan-out ${fanoutFirst ? "first" : "last"}) + SIGTERM => exit 143, lock removed`, async () => {
      const target = join(dir, "f.txt")
      const host = spawnHost(target, "", fanoutFirst)
      await waitReady(host.stdout)
      expect(existsSync(`${target}.locked`)).toBe(true)
      host.kill("SIGTERM")
      expect(await exitWithin(host, 5000)).toBe(143)
      expect(existsSync(`${target}.locked`)).toBe(false)
    }, 15_000)
  }

  it("with an untagged owner: no exit until the owner exits", async () => {
    const target = join(dir, "f.txt")
    const owner = [
      `process.on("SIGTERM", () => {`,
      `  process.stdout.write("OWNER\\n")`,
      `  setTimeout(() => process.exit(143), 600)`,
      `})`,
    ].join("\n")
    const host = spawnHost(target, owner)
    await waitReady(host.stdout)
    host.kill("SIGTERM")
    // The fan-outs defer to the owner: the process stays alive and keeps the lock.
    expect(await exitWithin(host, 250)).toBeNull()
    expect(existsSync(`${target}.locked`)).toBe(true)
    // The owner exits. The `exit` hook removes the lock.
    expect(await exitWithin(host, 5000)).toBe(143)
    expect(existsSync(`${target}.locked`)).toBe(false)
  }, 15_000)
})
