import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { EventHandlerContext } from "../../../src/plugins/types.ts"
import { TaskStore } from "../lib/store.ts"

import taskLink from "./task_link.ts"

const SID = "lead-link-sid"

function ctx(payload: unknown, home: string): EventHandlerContext {
  // Point HOME at the tmp dir so the default TaskStore writes there.
  process.env.HOME = home
  return {
    event: "subagent.taskUpdate",
    payload,
    packageDir: "/x",
    cwd: "/x",
    env: { HOME: home } as Record<string, string>,
    emit: () => {},
    abort: new AbortController().signal,
    stderr: process.stderr,
    log: { debug() {}, info() {}, notice() {}, warn() {}, error() {} } as unknown as EventHandlerContext["log"],
    agent: { sessionId: SID, pid: 1, model: "m", version: "0" },
  }
}

describe("task_link", () => {
  let home: string
  let prevHome: string | undefined
  beforeEach(() => {
    prevHome = process.env.HOME
    home = mkdtempSync(join(tmpdir(), "task-link-"))
  })
  afterEach(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome
    rmSync(home, { recursive: true, force: true })
  })

  it("ticks a linked task done on a clean worker finish", async () => {
    const store = new TaskStore(SID, { home })
    const t = store.add({ title: "delegated unit" })
    await taskLink(ctx({ taskId: t.id, status: "done", bySubagent: "A1" }, home))
    expect(new TaskStore(SID, { home }).resolve(t.id)?.status).toBe("done")
  })

  it("cancels a linked task with a reason on worker failure", async () => {
    const store = new TaskStore(SID, { home })
    const t = store.add({ title: "delegated unit" })
    await taskLink(ctx({ taskId: t.id, status: "canceled", reason: "exited code 1", bySubagent: "A2" }, home))
    const after = new TaskStore(SID, { home }).resolve(t.id)
    expect(after?.status).toBe("canceled")
    expect(after?.reason).toContain("exited code 1")
  })

  it("ignores malformed / unknown payloads", async () => {
    const store = new TaskStore(SID, { home })
    const t = store.add({ title: "x" })
    await taskLink(ctx({ status: "done" }, home)) // no taskId
    await taskLink(ctx({ taskId: t.id, status: "weird" }, home)) // bad status
    await taskLink(ctx({ taskId: "nonexistent", status: "done" }, home)) // unknown id
    expect(new TaskStore(SID, { home }).resolve(t.id)?.status).toBe("todo")
  })
})
