import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { beginHistoryEdit, commitHistoryEdit, prepareHistoryEdit } from "./session-history-edit.ts"
import { parseLines, SessionStore } from "./session-store.ts"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(): { dir: string; sid: string; ids: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "ma-history-edit-"))
  dirs.push(dir)
  const sid = "active-session"
  const store = SessionStore.open({
    sid,
    model: "test",
    cwd: "/project",
    systemHash: "system",
    toolsHash: "tools",
    agentVersion: "0",
    dir,
  })
  const ids = [store.appendUser("first"), store.appendUser("second"), store.appendUser("third")]
  writeFileSync(join(dir, `${sid}.draft`), "draft")
  return { dir, sid, ids }
}

describe("history edit transaction", () => {
  it("creates a durable backup before touching the active transcript", () => {
    const { dir, sid, ids } = fixture()
    const before = readFileSync(join(dir, `${sid}.jsonl`), "utf8")

    const result = beginHistoryEdit({ sid, targetUserId: ids[1] }, { dir, now: () => new Date(0) })

    expect(result).toMatchObject({
      ok: true,
      backupSid: "active-session-backup-01",
      selectedText: "second",
      targetRecordIndex: 2,
      userPromptOrdinal: 2,
      totalUserPrompts: 3,
    })
    expect(readFileSync(join(dir, `${sid}.jsonl`), "utf8")).toBe(before)
    const backup = parseLines(
      readFileSync(join(dir, "active-session-backup-01.jsonl"), "utf8"),
    ).records
    expect(backup[0]).toMatchObject({
      kind: "meta",
      sid: "active-session-backup-01",
      backup: true,
      backupOfSid: sid,
    })
    expect(backup.filter((r) => r.kind === "user")).toHaveLength(3)
    // Sidecar archival is deliberately deferred. The JSONL is the first-slice
    // durable backup contract and is complete before any active mutation.
    expect(() => readFileSync(join(dir, "active-session-backup-01.draft"), "utf8")).toThrow()
  })

  it("increments backup suffixes deterministically", () => {
    const { dir, sid, ids } = fixture()
    expect(beginHistoryEdit({ sid, targetUserId: ids[0] }, { dir })).toMatchObject({
      backupSid: "active-session-backup-01",
    })
    expect(beginHistoryEdit({ sid, targetUserId: ids[0] }, { dir })).toMatchObject({
      backupSid: "active-session-backup-02",
    })
  })

  it("prepares model history strictly before the selected prompt", () => {
    const { dir, sid, ids } = fixture()
    const prepared = prepareHistoryEdit({ sid, targetUserId: ids[1] }, { dir })
    if (!prepared.ok) throw new Error(prepared.message)
    expect(prepared.modelMessages).toHaveLength(1)
    expect(prepared.modelMessages[0]?.content).toBe("first")
  })

  it("repairs an incomplete tool pair in the strict prefix", () => {
    const { dir, sid } = fixture()
    const store = SessionStore.open({
      sid,
      model: "test",
      cwd: "/project",
      systemHash: "system",
      toolsHash: "tools",
      agentVersion: "0",
      dir,
      existsOk: true,
    })
    store.appendAssistant([{ type: "tool_use", id: "orphan", name: "Bash", input: {} }], "tool_use")
    const target = store.appendUser("replace after orphan")
    const prepared = prepareHistoryEdit({ sid, targetUserId: target }, { dir })
    if (!prepared.ok) throw new Error(prepared.message)
    expect(prepared.modelMessages).toHaveLength(1)
    expect(
      prepared.modelMessages.some((message) => JSON.stringify(message).includes("orphan")),
    ).toBe(false)
  })

  it("strictly cuts before the selected prompt and writes an audit record", () => {
    const { dir, sid, ids } = fixture()
    const begun = beginHistoryEdit({ sid, targetUserId: ids[1] }, { dir, now: () => new Date(0) })
    if (!begun.ok) throw new Error(begun.message)

    const committed = commitHistoryEdit(
      { sid, targetUserId: ids[1], backupSid: begun.backupSid },
      { dir, now: () => new Date(1000) },
    )

    expect(committed).toEqual({ ok: true, droppedRecordCount: 2 })
    const active = parseLines(readFileSync(join(dir, `${sid}.jsonl`), "utf8")).records
    expect(active.map((r) => r.kind)).toEqual(["meta", "user", "history_edit"])
    expect(active[2]).toMatchObject({
      targetUserId: ids[1],
      backupSid: begun.backupSid,
      droppedRecordCount: 2,
    })
  })

  it("rejects missing backup without mutating active history", () => {
    const { dir, sid, ids } = fixture()
    const before = readFileSync(join(dir, `${sid}.jsonl`), "utf8")
    expect(
      commitHistoryEdit({ sid, targetUserId: ids[0], backupSid: "missing" }, { dir }),
    ).toMatchObject({
      ok: false,
      code: "backup_not_found",
    })
    expect(readFileSync(join(dir, `${sid}.jsonl`), "utf8")).toBe(before)
  })
})
