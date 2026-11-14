/**
 * A hung subprocess event handler is registered in the child registry and
 * killed when the bus abort fires (agent shutdown). Event subs have no
 * manifest timeout, so the abort is the kill point besides the exit
 * listener. Bun kills no child on exit
 * (https://bun.com/reference/bun/Spawn/SpawnOptions/detached). The handler
 * runs in its own process group, so the abort also kills a grandchild that
 * holds stdout open (review-4a finding 4).
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { childRegistry } from "../../infra/child-registry.ts"
import type { EventHandlerContext } from "../types.ts"

import { invokeEventSubprocess } from "./event-subs.ts"

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

function within<T>(p: Promise<T>, ms: number): Promise<T | "late"> {
  return Promise.race([p, Bun.sleep(ms).then(() => "late" as const)])
}

describe("subprocess event handler", () => {
  it("is registered and killed when the bus abort fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-event-orphan-"))
    const pidFile = join(dir, "pid")
    const body = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(300_000)`
    const ctrl = new AbortController()
    const ctx = {
      event: "test.event",
      payload: {},
      packageDir: dir,
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      emit: () => {},
      abort: ctrl.signal,
      log: () => {},
    } as unknown as EventHandlerContext

    const before = new Set(childRegistry.pids())
    const p = invokeEventSubprocess(process.execPath, ["-e", body], ctx)
    const pid = await readPidFile(pidFile, 5000)
    started.push(pid)

    expect(childRegistry.pids().filter((x) => !before.has(x))).toEqual([pid])
    ctrl.abort()
    expect(await within(p, 3000)).toBeUndefined()
    expect(await goneWithin(pid, 2000)).toBe(true)
    expect(childRegistry.pids()).not.toContain(pid)
  }, 15_000)

  it("abort kills a grandchild that holds stdout and the call settles within 2 s", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-event-grand-"))
    const script = join(dir, "handler")
    const pidFile = join(dir, "pid")
    const gpidFile = join(dir, "gpid")
    // `sleep` inherits stdout, so a pid-only kill leaves the pipe open.
    writeFileSync(
      script,
      `#!/bin/sh\nsleep 300 &\necho $! > "${gpidFile}"\necho ${SELF_PID} > "${pidFile}"\nwait\n`,
    )
    chmodSync(script, 0o755)
    const ctrl = new AbortController()
    const ctx = {
      event: "test.event",
      payload: {},
      packageDir: dir,
      cwd: dir,
      env: { PATH: process.env.PATH ?? "" },
      emit: () => {},
      abort: ctrl.signal,
      log: () => {},
    } as unknown as EventHandlerContext

    const p = invokeEventSubprocess(script, [], ctx)
    const pid = await readPidFile(pidFile, 5000)
    const gpid = await readPidFile(gpidFile, 5000)
    started.push(pid, gpid)

    ctrl.abort()
    expect(await within(p, 2000)).toBeUndefined()
    expect(await goneWithin(gpid, 2000)).toBe(true)
    expect(await goneWithin(pid, 2000)).toBe(true)
  }, 15_000)
})
