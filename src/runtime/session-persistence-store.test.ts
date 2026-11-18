/**
 * Review W2 M2 (SPEC v6.1 D8 rule 8): on the SDK/runtime path, the record
 * that `SessionStorePersistence` writes holds the same outcome as the live
 * block that `runToolCalls` makes. A real `SessionStore` in a temp dir, and
 * the normal restore entry point (`loadSession`).
 */

import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

import type { ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"
import type { ToolExecutor } from "../sdk/ports.ts"
import { runToolCalls } from "../sdk/tool-calls.ts"
import { withBlockOutcome, withInternalOutcome } from "../sdk/tool-outcome-record.ts"
import { loadSession } from "../session/session-restore.ts"
import { SessionStore, sessionFilePath } from "../session/session-store.ts"

import { SessionStorePersistence } from "./session-persistence-store.ts"

const record = {
  v: 1 as const,
  bodyEnd: 2,
  annotations: [{ kind: "policy", start: 3, end: 6 }],
}

const toolUse: ToolUseBlock = { type: "tool_use", id: "t1", name: "Bash", input: { command: "x" } }

function openStore(sid: string): { store: SessionStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ma-sps-outcome-"))
  const store = SessionStore.open({
    sid,
    model: "m",
    cwd: "/",
    systemHash: "x",
    toolsHash: "y",
    agentVersion: "0",
    dir,
  })
  return { store, dir }
}

/** Write one turn through the port, with the tool step of `runToolCalls`. */
async function runTurn(sid: string, executor: ToolExecutor) {
  const { store, dir } = openStore(sid)
  const persistence = new SessionStorePersistence(store)
  persistence.appendUser("go")
  persistence.appendAssistant([toolUse], "tool_use")
  const live = await runToolCalls(
    { executor, persistence, emit: () => {}, wantsToolOutput: false, now: () => 0 },
    [toolUse],
    undefined,
  )
  const loaded = loadSession(sid, dir)
  const restoredOf = (messages: typeof loaded.messages) =>
    messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : [],
    ) as ToolResultBlock[]
  const lines = readFileSync(sessionFilePath(sid, dir), "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
  const rec = lines.find((l) => l.kind === "tool_result")
  return {
    live,
    model: restoredOf(loaded.messages),
    display: restoredOf(loaded.displayMessages),
    rec,
  }
}

describe("SessionStorePersistence / outcome record (review W2 M2)", () => {
  test("core's own executor: live block == restored block, WITH the outcome", async () => {
    const r = await runTurn("sps-core", {
      execute: async () => withInternalOutcome({ content: "ok\nabc", isError: false }, record),
    })
    expect(r.live[0]?.outcome).toEqual(record)
    expect(r.rec?.outcome).toEqual(record)
    expect(r.model).toHaveLength(1)
    expect(r.model[0]).toEqual(r.live[0] as ToolResultBlock)
    expect(r.display[0]).toEqual(r.live[0] as ToolResultBlock)
  })

  test("a host executor result with an `outcome` key: none on the live block, none in the record (F18)", async () => {
    const r = await runTurn("sps-host", {
      execute: async () => ({ content: "ok\nabc", isError: false, outcome: record }) as never,
    })
    const live = r.live[0]
    expect(live !== undefined && "outcome" in live).toBe(false)
    expect(r.rec !== undefined && "outcome" in r.rec).toBe(false)
    expect(r.model[0]).toEqual(live as ToolResultBlock)
    expect(r.model[0] !== undefined && "outcome" in r.model[0]).toBe(false)
  })

  test("the port never copies an `outcome` key that is on the block itself", () => {
    const { store, dir } = openStore("sps-key")
    const persistence = new SessionStorePersistence(store)
    persistence.appendUser("go")
    persistence.appendAssistant([toolUse], "tool_use")
    persistence.appendToolResult({
      type: "tool_result",
      tool_use_id: "t1",
      content: "ok\nabc",
      is_error: false,
      outcome: record,
    })
    const text = readFileSync(sessionFilePath("sps-key", dir), "utf8")
    expect(text.includes('"outcome"')).toBe(false)
  })

  test("a registered record that does not fit the block content is not written", () => {
    const { store, dir } = openStore("sps-bad")
    const persistence = new SessionStorePersistence(store)
    persistence.appendUser("go")
    persistence.appendAssistant([toolUse], "tool_use")
    const block: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "t1",
      content: "ok",
      is_error: false,
    }
    persistence.appendToolResult(withBlockOutcome(block, record))
    const text = readFileSync(sessionFilePath("sps-bad", dir), "utf8")
    expect(text.includes('"outcome"')).toBe(false)
  })
})
