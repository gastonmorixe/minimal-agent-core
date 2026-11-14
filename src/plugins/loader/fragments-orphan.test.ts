/**
 * Subprocess prompt-fragment probes and the child registry.
 *
 * 1. A probe that is slower than its `timeoutMs` but finishes is NOT
 *    killed by `runFragment`. The loader race (loader.ts) owns the deadline,
 *    and it starts later than the probe (review-4a finding 3).
 * 2. A hung probe stays registered while it runs, and the entry is released
 *    once the probe settles.
 * 3. The probe runs in the process group of the host, NOT detached. Bun
 *    `detached` calls `setsid()`
 *    (https://bun.com/reference/bun/Spawn/SpawnOptions/detached), and a
 *    process after `setsid()` has no controlling terminal
 *    (https://pubs.opengroup.org/onlinepubs/9799919799/functions/setsid.html).
 *    ma-env-info-plugin/gather.sh reads `stty size </dev/tty`, so the probe
 *    must keep the tty (fix-3j).
 * 4. A hung probe is killed by pid when the host calls process.exit(0).
 *    Bun kills no child on exit, so the child registry exit listener does it.
 *    A grandchild of the probe can outlive the host (accepted, fix-3j).
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { childRegistry } from "../../infra/child-registry.ts"
import type { ManifestPromptFragment } from "../types.ts"

import { startFragment } from "./fragments.ts"

const FRAGMENTS = join(import.meta.dir, "fragments.ts")
/** The shell pid variable, built by repeat so no editor collapses the pair. */
const SELF_PID = "$".repeat(2)

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
    await Bun.sleep(25)
  }
  return !alive(pid)
}

/** Wait for the probe to write its pid file, then return the pid. */
async function readPidFile(path: string, ms: number): Promise<number> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf-8").trim()
      if (text) return Number(text)
    }
    await Bun.sleep(25)
  }
  throw new Error(`no pid file at ${path}`)
}

/** Resolve to "late" when `p` does not settle within `ms`. */
function within<T>(p: Promise<T>, ms: number): Promise<T | "late"> {
  return Promise.race([p, Bun.sleep(ms).then(() => "late" as const)])
}

describe("subprocess prompt fragment probe", () => {
  it("is not killed when it runs past its timeoutMs (the loader owns the deadline)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-frag-slow-"))
    const body = 'await Bun.sleep(800); process.stdout.write("slow-ok")'
    const frag: ManifestPromptFragment = {
      id: "slow",
      handler: { type: "subprocess", command: [process.execPath, "-e", body] },
      timeoutMs: 200,
    }
    const out = await within(
      startFragment(frag, dir, () => {}, undefined, "test", undefined),
      8000,
    )
    expect(out).toBe("slow-ok")
  }, 15_000)

  it("a hung probe stays registered while it runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-frag-orphan-"))
    const pidFile = join(dir, "pid")
    const body = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(300_000)`
    const frag: ManifestPromptFragment = {
      id: "hung",
      handler: { type: "subprocess", command: [process.execPath, "-e", body] },
      timeoutMs: 1500,
    }
    const before = new Set(childRegistry.pids())
    const p = startFragment(frag, dir, () => {}, undefined, "test", undefined)
    const pid = await readPidFile(pidFile, 5000)
    started.push(pid)

    expect(childRegistry.pids().filter((x) => !before.has(x))).toEqual([pid])
    // No self-timer: the probe is still alive after its timeoutMs.
    await Bun.sleep(1700)
    expect(alive(pid)).toBe(true)
    // Kill it from outside (the registry does this at host exit). The probe
    // settles as a failure (null) and its entry is released.
    process.kill(pid, "SIGKILL")
    expect(await within(p, 3000)).toBeNull()
    expect(childRegistry.pids()).not.toContain(pid)
  }, 15_000)

  it("runs in the process group of the host, so it keeps the controlling tty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-frag-pgid-"))
    const probe = join(dir, "probe")
    writeFileSync(probe, `#!/bin/sh\nps -o pgid= -p ${SELF_PID}\n`)
    chmodSync(probe, 0o755)
    const frag: ManifestPromptFragment = {
      id: "pgid",
      handler: { type: "subprocess", command: ["probe"] },
      timeoutMs: 5000,
    }
    const out = await within(
      startFragment(frag, dir, () => {}, undefined, "test", undefined),
      8000,
    )
    const own = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)])
    const ownPgid = own.stdout.toString().trim()
    expect(ownPgid).toMatch(/^\d+$/)
    expect(typeof out === "string" ? out.trim() : out).toBe(ownPgid)
  }, 15_000)

  it("a hung probe dies by pid when the host calls process.exit(0)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-frag-exit-"))
    const probe = join(dir, "probe")
    const pidFile = join(dir, "pid")
    // `exec` keeps one process (the pid in the file), so the pid kill at host
    // exit leaves no grandchild behind in this test.
    writeFileSync(probe, `#!/bin/sh\necho ${SELF_PID} > "${pidFile}"\nexec sleep 300\n`)
    chmodSync(probe, 0o755)
    const host = Bun.spawn(
      [
        process.execPath,
        "-e",
        [
          `import { existsSync } from "node:fs"`,
          `import { startFragment } from ${JSON.stringify(FRAGMENTS)}`,
          `const frag = { id: "g", handler: { type: "subprocess", command: ["probe"] }, timeoutMs: 1500 }`,
          `void startFragment(frag, ${JSON.stringify(dir)}, () => {}, undefined, "test", undefined)`,
          "const end = Date.now() + 5000",
          `while (!existsSync(${JSON.stringify(pidFile)}) && Date.now() < end) await Bun.sleep(20)`,
          "process.exit(0)",
        ].join("\n"),
      ],
      { cwd: dir, stdin: "ignore", stdout: "ignore", stderr: "inherit" },
    )
    started.push(host.pid)
    const pid = await readPidFile(pidFile, 5000)
    started.push(pid)
    expect(await host.exited).toBe(0)
    expect(await goneWithin(pid, 2000)).toBe(true)
  }, 15_000)
})
