import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { SessionStore } from "../../../session/session-store.ts"

import { createSessionsWriteApi } from "./sessions-write.ts"

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

function seed(): { dir: string; id: string } {
  const dir = mkdtempSync(join(tmpdir(), "sessions-write-"))
  dirs.push(dir)
  const store = SessionStore.open({
    sid: "active",
    model: "m",
    cwd: "/p",
    systemHash: "s",
    toolsHash: "t",
    agentVersion: "0",
    dir,
  })
  const id = store.appendUser("first")
  store.appendUser("second")
  return { dir, id }
}

describe("sessions:write", () => {
  it("passes strict-prefix model messages to preflight before committing", async () => {
    const { dir, id } = seed()
    const seen: string[] = []
    const api = createSessionsWriteApi({
      dir,
      activeSessionId: "active",
      canCommit: () => true,
      beforeCommit: async ({ modelMessages }) => {
        for (const message of modelMessages)
          seen.push(typeof message.content === "string" ? message.content : "blocks")
      },
      onCommitted: async () => {},
    })
    const begun = await api.beginHistoryEdit({ targetUserId: id })
    if (!begun.ok) throw new Error(begun.message)
    expect(
      await api.commitHistoryEdit({ targetUserId: id, backupSid: begun.backupSid }),
    ).toMatchObject({ ok: true })
    expect(seen).toEqual([])
  })

  it("refuses a failing preflight without changing active bytes", async () => {
    const { dir, id } = seed()
    const api = createSessionsWriteApi({
      dir,
      activeSessionId: "active",
      canCommit: () => true,
      beforeCommit: async () => {
        throw new Error("cannot reload")
      },
      onCommitted: async () => {},
    })
    const begun = await api.beginHistoryEdit({ targetUserId: id })
    if (!begun.ok) throw new Error(begun.message)
    const path = join(dir, "active.jsonl")
    const before = readFileSync(path, "utf8")
    expect(
      await api.commitHistoryEdit({ targetUserId: id, backupSid: begun.backupSid }),
    ).toMatchObject({ ok: false, code: "commit_preflight_failed" })
    expect(readFileSync(path, "utf8")).toBe(before)
  })

  it("refuses a missing preflight without changing active bytes", async () => {
    const { dir, id } = seed()
    const api = createSessionsWriteApi({
      dir,
      activeSessionId: "active",
      canCommit: () => true,
      onCommitted: async () => {},
    })
    const begun = await api.beginHistoryEdit({ targetUserId: id })
    if (!begun.ok) throw new Error(begun.message)
    const path = join(dir, "active.jsonl")
    const before = readFileSync(path, "utf8")
    expect(
      await api.commitHistoryEdit({ targetUserId: id, backupSid: begun.backupSid }),
    ).toMatchObject({ ok: false, code: "commit_handler_unavailable" })
    expect(readFileSync(path, "utf8")).toBe(before)
  })

  it("refuses unavailable reload coordination without changing active bytes", async () => {
    const { dir, id } = seed()
    const api = createSessionsWriteApi({
      dir,
      activeSessionId: "active",
      onCommitted: async () => {},
      canCommit: () => false,
    })
    const begun = await api.beginHistoryEdit({ targetUserId: id })
    if (!begun.ok) throw new Error(begun.message)
    const path = join(dir, "active.jsonl")
    const before = readFileSync(path, "utf8")
    expect(
      await api.commitHistoryEdit({ targetUserId: id, backupSid: begun.backupSid }),
    ).toMatchObject({ ok: false, code: "commit_handler_unavailable" })
    expect(readFileSync(path, "utf8")).toBe(before)
  })
})
