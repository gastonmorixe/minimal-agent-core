/**
 * Compact row `meta`: writer, restore with and without meta, type import.
 *
 * @module session/compact-meta.test
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { CompactionProvider, CompactMeta } from "../../plugin-api/src/types/compaction.ts"
import { COMPACTION_USER_MARKER } from "../agent/context-compact.ts"
import { runCompact } from "../agent/run-compact.ts"
import type { Message } from "../llm/messages.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { fixtureSidebandOrNone } from "../test-utils/sideband-fixture.ts"

import { loadSessionFromText } from "./session-restore.ts"
import { type CompactRecord, type SessionRecord, SessionStore } from "./session-store.ts"

const SB = fixtureSidebandOrNone()

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compact-meta-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function openStore(): SessionStore {
  return SessionStore.open({
    sid: "s1",
    model: "m",
    cwd: "/",
    systemHash: "x",
    toolsHash: "y",
    agentVersion: "0",
    dir,
  })
}

function history(): Message[] {
  const out: Message[] = []
  for (let i = 0; i < 10; i++) {
    out.push({ role: "user", content: `u${i}` })
    out.push({ role: "assistant", content: `a${i}` })
  }
  return out
}

function compactRows(store: SessionStore): CompactRecord[] {
  return readFileSync(store.path, "utf-8")
    .split("\n")
    .filter((l) => l.includes('"kind":"compact"'))
    .map((l) => JSON.parse(l) as CompactRecord)
}

const BASE = {
  reason: "manual" as const,
  compactKind: "local" as const,
  messagesBefore: 4,
  messagesAfter: 1,
  replacementMessages: [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: `${COMPACTION_USER_MARKER} kind="local" />\nbody` }],
    },
  ],
}

describe("compact row meta writer", () => {
  it("writes meta for tail and local, with at equal to ts", async () => {
    const store = openStore()
    const common = {
      lifecycle: NOOP_LIFECYCLE,
      model: "does-not-matter",
      auth: { type: "api-key" as const, token: "x" },
      reason: "manual" as const,
      appendCompact: (rec: Parameters<SessionStore["appendCompact"]>[0]) =>
        store.appendCompact(rec),
    }
    await runCompact({ ...common, messages: history(), mode: "tail", keepTail: 3, focus: " f " })
    await runCompact({ ...common, messages: history(), preferRemote: false, keepTail: 4 })
    const [tail, local] = compactRows(store)
    expect(tail?.meta?.kind).toBe("tail")
    expect(tail?.meta?.retained).toBe(tail ? tail.replacementMessages.length - 1 : -1)
    expect(tail?.meta?.focus).toBe(" f ")
    expect(tail?.meta?.at).toBe(tail?.ts)
    expect(local?.meta?.kind).toBe("local")
    expect(local?.meta?.retained).toBe(local ? local.replacementMessages.length - 1 : -1)
    expect(local?.meta && "focus" in local.meta).toBe(false)
    expect(local?.meta?.at).toBe(local?.ts)
  })

  it("writes no meta for a row built without it, byte identical to the old shape", () => {
    const store = openStore()
    store.appendCompact({ ...BASE, ts: "T" })
    const line = readFileSync(store.path, "utf-8").trim().split("\n").pop()
    expect(line).toBe(
      JSON.stringify({
        kind: "compact",
        ts: "T",
        reason: "manual",
        compactKind: "local",
        messagesBefore: 4,
        messagesAfter: 1,
        replacementMessages: BASE.replacementMessages,
      }),
    )
  })

  it("puts meta last", () => {
    const store = openStore()
    store.appendCompact({ ...BASE, ts: "T", meta: { kind: "local", retained: 0 } })
    const row = compactRows(store)[0]
    expect(Object.keys(row ?? {}).pop()).toBe("meta")
    expect(row?.meta).toEqual({ kind: "local", retained: 0, at: "T" })
  })
})

function sessionText(compact: Record<string, unknown>): string {
  const rows: SessionRecord[] = [
    {
      kind: "meta",
      formatVersion: 1,
      sid: "s",
      createdAt: "t",
      model: "m",
      cwd: "/",
      systemHash: "x",
      toolsHash: "y",
      agentVersion: "0",
    },
    { kind: "user", ts: "t", content: "first" },
    { kind: "assistant", ts: "t", content: [{ type: "text", text: "r" }], stopReason: "end_turn" },
    compact as unknown as SessionRecord,
    { kind: "user", ts: "t", content: "next" },
    { kind: "assistant", ts: "t", content: [{ type: "text", text: "ok" }], stopReason: "end_turn" },
  ]
  return `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`
}

const ROW = { kind: "compact", ts: "T", ...BASE }
const META: CompactMeta = { kind: "local", retained: 0, at: "T" }

describe("restore with and without meta", () => {
  it("gives identical messages", () => {
    const withMeta = loadSessionFromText(sessionText({ ...ROW, meta: META }), {
      sideband: SB,
    }).messages
    const without = loadSessionFromText(sessionText(ROW), { sideband: SB }).messages
    expect(withMeta).toEqual(without)
    expect(withMeta.length).toBe(2)
    expect(JSON.stringify(withMeta)).toContain(COMPACTION_USER_MARKER)
  })

  it("uses meta even when the checkpoint text has no marker", () => {
    const plain = {
      ...ROW,
      replacementMessages: [{ role: "user", content: [{ type: "text", text: "checkpoint" }] }],
    }
    const withMeta = loadSessionFromText(sessionText({ ...plain, meta: META }), {
      sideband: SB,
    }).messages
    expect(JSON.stringify(withMeta)).toContain("checkpoint")
    expect(JSON.stringify(withMeta)).toContain("next")
    expect(withMeta.length).toBe(2)
  })

  it("restores a remote row without meta through the marker path", () => {
    const remote = { ...ROW, compactKind: "remote" }
    const msgs = loadSessionFromText(sessionText(remote), { sideband: SB }).messages
    expect(msgs.length).toBe(2)
    expect(JSON.stringify(msgs)).toContain(COMPACTION_USER_MARKER)
    expect(JSON.stringify(msgs)).toContain("next")
  })
})

describe("compaction module", () => {
  it("accepts a stub provider by type", () => {
    const p: CompactionProvider = {
      summarySystemPrompt: (f) => f ?? "",
      checkpointMessage: (_k, i) => [{ type: "text", text: String(i.retained) }],
      flattenLabel: (k) => k,
    }
    expect(p.flattenLabel("tool_use", {})).toBe("tool_use")
    expect(p.checkpointMessage("tail", { retained: 2 })[0]?.text).toBe("2")
  })
})
