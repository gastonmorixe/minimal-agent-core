/**
 * Handler-level tests for the /loop and /schedule command handlers.
 *
 * @module schedule/commands.test
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import cmdLoop from "./handlers/cmd_loop.ts"
import cmdSchedule from "./handlers/cmd_schedule.ts"
import { CronStore } from "./lib/store.ts"

let dir: string
const SID = "cmd-session"

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-sched-cmd-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Minimal CommandContext. */
function ctx(argv: string, name = "loop", env: Record<string, string> = {}) {
  return {
    name,
    argv,
    rawLine: `/${name} ${argv}`,
    cwd: dir,
    env: { MINIMAL_AGENT_CRON_DIR: dir, ...env },
    abort: new AbortController().signal,
    log: { info() {}, warn() {}, error() {}, debug() {} } as never,
    emit: () => {},
    agent: { sessionId: SID, pid: 1, model: "m", version: "0" },
  }
}

function store(): CronStore {
  return new CronStore(SID, { dir })
}

describe("/loop", () => {
  it("creates a fixed-interval recurring loop", async () => {
    const r = await cmdLoop(ctx("5m check the deploy"))
    expect(r.kind).toBe("notice")
    const e = store().load()[0]
    expect(e).toMatchObject({ recurs: true, pace: "fixed", label: "5m", source: "loop" })
    expect(e?.prompt).toBe("check the deploy")
    expect(e?.cron).toBe("*/5 * * * *")
    if (r.kind === "notice") expect(r.block?.title).toBe("loop")
  })

  it("creates a self-paced loop when no interval is given", async () => {
    const r = await cmdLoop(ctx("check CI and address review comments"))
    expect(r.kind).toBe("notice")
    const e = store().load()[0]
    expect(e?.pace).toBe("dynamic")
    expect(typeof e?.nextAtMs).toBe("number")
  })

  it("uses the maintenance prompt for a bare /loop", async () => {
    const r = await cmdLoop(ctx(""))
    expect(r.kind).toBe("notice")
    const e = store().load()[0]
    expect(e?.prompt).toContain("unfinished work")
  })

  it("honors the disable gate", async () => {
    const r = await cmdLoop(ctx("5m x", "loop", { MINIMAL_AGENT_DISABLE_CRON: "1" }))
    expect(r.kind).toBe("error")
  })
})

describe("/schedule", () => {
  it("creates from a quoted cron", async () => {
    const r = await cmdSchedule(ctx('"0 9 * * 1-5" run the morning report', "schedule"))
    expect(r.kind).toBe("notice")
    const e = store().load()[0]
    expect(e).toMatchObject({ cron: "0 9 * * 1-5", recurs: true, source: "schedule" })
    expect(e?.prompt).toBe("run the morning report")
  })

  it("lists tasks", async () => {
    await cmdSchedule(ctx('"*/5 * * * *" poll', "schedule"))
    const r = await cmdSchedule(ctx("list", "schedule"))
    expect(r.kind).toBe("notice")
    if (r.kind === "notice") expect(r.block?.body?.join("\n")).toContain("poll")
  })

  it("cancels by id", async () => {
    await cmdSchedule(ctx('"*/5 * * * *" poll', "schedule"))
    const id = store().load()[0]?.id as string
    const r = await cmdSchedule(ctx(`cancel ${id}`, "schedule"))
    expect(r.kind).toBe("notice")
    expect(store().count()).toBe(0)
  })

  it("errors on an invalid cron", async () => {
    const r = await cmdSchedule(ctx('"not a cron" do it', "schedule"))
    expect(r.kind).toBe("error")
  })

  it("shows usage for bare /schedule", async () => {
    const r = await cmdSchedule(ctx("", "schedule"))
    expect(r.kind).toBe("notice")
    if (r.kind === "notice") expect(r.lines?.join("\n")).toContain("usage")
  })

  it("errors when canceling an unknown id", async () => {
    const r = await cmdSchedule(ctx("cancel zzzzzzzz", "schedule"))
    expect(r.kind).toBe("error")
  })
})
