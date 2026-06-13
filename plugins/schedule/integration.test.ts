/**
 * Handler-level integration: drive the CronCreate / CronList / CronDelete
 * tool handlers with a constructed context and a redirected store dir,
 * asserting the full create → list → delete flow + validation + the
 * disable gate.
 *
 * @module schedule/integration.test
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import cronCreate from "./handlers/cron_create.ts"
import cronDelete from "./handlers/cron_delete.ts"
import cronList from "./handlers/cron_list.ts"
import { CronStore } from "./lib/store.ts"

/**
 * Local structural mirror of the host's `tool_result` TUIResult variant.
 * Plugins must not import src/ (plugin-decoupling invariant I1); the
 * handler results are structurally compatible with this shape.
 */
type ToolResult = {
  kind: "tool_result"
  content: string
  is_error?: boolean
  display?: string
  displayFooter?: string
}

/** Narrow a handler result to the `tool_result` variant (throws otherwise). */
function asTool(r: { kind: string }): ToolResult {
  if (r.kind !== "tool_result") throw new Error(`expected tool_result, got ${r.kind}`)
  return r as ToolResult
}

let dir: string
const SID = "integ-session"

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-sched-integ-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Minimal TUIContext for a tool call. */
function ctx(input: Record<string, unknown>, env: Record<string, string> = {}) {
  return {
    trigger: { type: "tool" as const, name: "X", input, tool_use_id: "t1" },
    packageDir: "/tmp",
    cwd: "/tmp",
    env: { MINIMAL_AGENT_CRON_DIR: dir, ...env },
    abort: new AbortController().signal,
    stdout: process.stdout,
    stdin: process.stdin,
    stderr: process.stderr,
    log: { info() {}, warn() {}, error() {}, debug() {} } as never,
    agent: { sessionId: SID, pid: 1, model: "m", version: "0" },
  }
}

describe("CronCreate", () => {
  it("creates from an interval and persists", async () => {
    const r = asTool(await cronCreate(ctx({ every: "5m", prompt: "check deploy" })))
    expect(r.is_error).toBeUndefined()
    expect(r.content).toContain("Scheduled task")
    expect(new CronStore(SID, { dir }).count()).toBe(1)
  })

  it("creates from a raw cron", async () => {
    const r = asTool(await cronCreate(ctx({ cron: "0 9 * * 1-5", prompt: "morning report" })))
    expect(r.is_error).toBeUndefined()
    const e = new CronStore(SID, { dir }).load()[0]
    expect(e?.cron).toBe("0 9 * * 1-5")
  })

  it("creates a one-shot with a future fire time", async () => {
    const r = asTool(await cronCreate(ctx({ cron: "30 14 15 3 *", prompt: "push", recurs: false })))
    expect(r.is_error).toBeUndefined()
    const e = new CronStore(SID, { dir }).load()[0]
    expect(e?.recurs).toBe(false)
    expect(typeof e?.nextAtMs).toBe("number")
  })

  it("rejects missing prompt / bad cron / no schedule", async () => {
    expect(asTool(await cronCreate(ctx({ every: "5m" }))).is_error).toBe(true)
    expect(asTool(await cronCreate(ctx({ cron: "not cron", prompt: "p" }))).is_error).toBe(true)
    expect(asTool(await cronCreate(ctx({ prompt: "p" }))).is_error).toBe(true)
  })

  it("honors the disable gate", async () => {
    const r = asTool(
      await cronCreate(ctx({ every: "5m", prompt: "p" }, { MINIMAL_AGENT_DISABLE_CRON: "1" })),
    )
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("disabled")
  })
})

describe("CronList + CronDelete", () => {
  it("lists created tasks and deletes by id", async () => {
    await cronCreate(ctx({ every: "5m", prompt: "task one" }))
    await cronCreate(ctx({ cron: "0 9 * * *", prompt: "task two" }))

    const listed = asTool(await cronList(ctx({})))
    expect(listed.content).toContain("task one")
    expect(listed.content).toContain("task two")

    const id = new CronStore(SID, { dir }).load()[0]?.id as string
    const del = asTool(await cronDelete(ctx({ id })))
    expect(del.is_error).toBeUndefined()
    expect(del.content).toContain("Canceled")
    expect(new CronStore(SID, { dir }).count()).toBe(1)

    // Deleting an unknown id errors.
    const bad = asTool(await cronDelete(ctx({ id: "zzzzzzzz" })))
    expect(bad.is_error).toBe(true)
  })

  it("lists empty cleanly", async () => {
    const listed = asTool(await cronList(ctx({})))
    expect(listed.content).toContain("No scheduled tasks")
  })
})
