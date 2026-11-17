/**
 * SPEC v6.1 D8 (M2): the `outcome` record form goes to the JSONL record
 * through the explicit 4th argument of `appendToolResult`, and restore puts
 * a valid value back on the block. The live block and the restored block are
 * deep-equal (D8 rule 8).
 */

import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import type { ToolOutcome } from "../../plugin-api/src/types/tool-outcome.ts"
import type { PersistedToolOutcome } from "../../plugin-api/src/types/tool-outcome-record.ts"
import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import { messageFromCanonical, messageToCanonical } from "../llm/codec/message-codec.ts"
import type { Message, ToolResultBlock } from "../llm/messages.ts"
import { finalizeOutcome } from "../loops/tool-outcome-finalize.ts"
import { attachPersistedOutcome } from "../sdk/tool-outcome-record.ts"

import { loadSession, loadSessionFromText } from "./session-restore.ts"
import { SessionStore } from "./session-store.ts"

const baseOpenOpts = {
  model: "test-model",
  cwd: "/tmp/x",
  systemHash: "h",
  toolsHash: "h",
  agentVersion: "test",
}

const liveOutcome: ToolOutcome = {
  body: { text: "one\ntwo", data: { lines: 2 }, schema: { type: "object" } },
  annotations: [
    {
      kind: "raw-output",
      attrs: { path: "/b", bytes: 9 },
      text: "<raw />",
      join: "\n\n",
      owner: "core",
    },
    { kind: "policy", text: "policy line", join: "\n", owner: "core" },
    { kind: "mode-active", text: "<mode />", join: "\n\n", joinWhenEmpty: false, owner: "core" },
  ],
  isError: false,
  aborted: false,
  hostHints: { header: "not persisted" },
  truncInfo: { truncated: false } as unknown as ToolOutcome["truncInfo"],
}

function open(sid: string): SessionStore {
  const dir = mkdtempSync(join(tmpdir(), "ma-outcome-tr-"))
  return SessionStore.open({ ...baseOpenOpts, sid, dir })
}

function writeTurn(
  store: SessionStore,
  block: ToolResultBlock,
  outcome?: PersistedToolOutcome,
  rawBlob?: { path: string; bytes: number; sha256: string },
): void {
  store.appendUser("go")
  store.appendAssistant(
    [{ type: "tool_use", id: block.tool_use_id, name: "T", input: {} }],
    "tool_use",
  )
  store.appendToolResult(block, undefined, rawBlob, outcome)
  store.appendAssistant([{ type: "text", text: "done" }], "end_turn")
}

function restoredBlock(store: SessionStore, sid: string): ToolResultBlock | undefined {
  const loaded = loadSession(sid, join(store.path, ".."))
  for (const m of loaded.messages) {
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) if (b.type === "tool_result") return b
  }
  return undefined
}

function toolResultRecord(path: string): Record<string, unknown> {
  const line = readFileSync(path, "utf-8")
    .split("\n")
    .find((l) => l.includes('"kind":"tool_result"'))
  return JSON.parse(line ?? "{}") as Record<string, unknown>
}

describe("tool_result outcome: persist and restore (SPEC v6.1 D8)", () => {
  it("live block and restored block are deep-equal, with outcome (R7)", () => {
    const text = finalizeOutcome(liveOutcome).text
    const live: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: text,
      is_error: false,
    }
    const record = attachPersistedOutcome(live, liveOutcome, text)
    expect(record).toBeDefined()
    expect(live.outcome).toBe(record)

    const store = open("oc-live")
    writeTurn(store, live, record)
    const restored = restoredBlock(store, "oc-live")
    expect(restored).toEqual(live)
    expect(restored?.outcome).toEqual(record)
  })

  it("the record holds the record form: no text, no hostHints, no truncInfo", () => {
    const text = finalizeOutcome(liveOutcome).text
    const live: ToolResultBlock = { type: "tool_result", tool_use_id: "tu_1", content: text }
    const record = attachPersistedOutcome(live, liveOutcome, text)
    const store = open("oc-shape")
    writeTurn(store, live, record)
    const rec = toolResultRecord(store.path)
    expect(rec.content).toBe(text)
    const outcome = rec.outcome as Record<string, unknown>
    expect(Object.keys(outcome).sort()).toEqual(["annotations", "bodyEnd", "data", "schema", "v"])
    expect(JSON.stringify(outcome)).not.toContain("not persisted")
  })

  it("the store reads only the argument, not block.outcome", () => {
    const text = finalizeOutcome(liveOutcome).text
    const live: ToolResultBlock = { type: "tool_result", tool_use_id: "tu_1", content: text }
    attachPersistedOutcome(live, liveOutcome, text)
    const store = open("oc-noarg")
    writeTurn(store, live)
    expect(readFileSync(store.path, "utf-8")).not.toContain('"outcome"')
    const restored = restoredBlock(store, "oc-noarg")
    expect(restored !== undefined && "outcome" in restored).toBe(false)
  })

  it("rawBlob and outcome are written together", () => {
    const text = finalizeOutcome(liveOutcome).text
    const live: ToolResultBlock = { type: "tool_result", tool_use_id: "tu_1", content: text }
    const record = attachPersistedOutcome(live, liveOutcome, text)
    const store = open("oc-raw")
    writeTurn(store, live, record, { path: "/b", bytes: 9, sha256: "abc" })
    const rec = toolResultRecord(store.path)
    expect(rec.rawPath).toBe("/b")
    expect(rec.outcome).toEqual(record as unknown as Record<string, unknown>)
  })

  it("media content: offsets refer to the first text block", () => {
    const text = finalizeOutcome(liveOutcome).text
    const live: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu_1",
      content: [
        { type: "text", text },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } },
      ],
      is_error: false,
    }
    const record = attachPersistedOutcome(live, liveOutcome, text)
    const store = open("oc-media")
    writeTurn(store, live, record)
    expect(restoredBlock(store, "oc-media")).toEqual(live)
  })
})

describe("tool_result outcome: old and bad records", () => {
  const header = JSON.stringify({ kind: "meta", sid: "old", v: 1, ...baseOpenOpts })
  const lines = (toolResult: Record<string, unknown>): string =>
    [
      header,
      JSON.stringify({ kind: "user", ts: "t", content: [{ type: "text", text: "go" }] }),
      JSON.stringify({
        kind: "assistant",
        ts: "t",
        content: [{ type: "tool_use", id: "tu_1", name: "T", input: {} }],
        stopReason: "tool_use",
      }),
      JSON.stringify({
        kind: "tool_result",
        ts: "t",
        tool_use_id: "tu_1",
        isError: false,
        ...toolResult,
      }),
    ].join("\n")

  function block(text: string): ToolResultBlock | undefined {
    const { messages } = loadSessionFromText(text)
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue
      for (const b of m.content) if (b.type === "tool_result") return b
    }
    return undefined
  }

  it("an old record with no outcome restores with no outcome key (same shape as before)", () => {
    const b = block(lines({ content: "ok" }))
    expect(b).toEqual({ type: "tool_result", tool_use_id: "tu_1", content: "ok", is_error: false })
    expect(b !== undefined && "outcome" in b).toBe(false)
  })

  it("a bad outcome is dropped from the block; content stays", () => {
    const bads: unknown[] = [
      { v: 2, bodyEnd: 0, annotations: [] },
      { v: 1, bodyEnd: 99, annotations: [] },
      { v: 1, bodyEnd: 0, annotations: [{ kind: "k", start: 0, end: 99 }] },
      "x",
      null,
    ]
    for (const outcome of bads) {
      const b = block(lines({ content: "ok", outcome }))
      expect(b?.content).toBe("ok")
      expect(b !== undefined && "outcome" in b).toBe(false)
    }
  })

  it("a dataRef with a missing target restores as metadata; no error", () => {
    const outcome = {
      v: 1,
      bodyEnd: 2,
      annotations: [],
      dataRef: { path: "/no/such/blob", bytes: 3, sha256: "abc" },
    }
    expect(block(lines({ content: "ok", outcome }))?.outcome).toEqual(
      outcome as PersistedToolOutcome,
    )
  })
})

describe("tool_result outcome: E14 caps on restore", () => {
  /** An old session text with one tool_result record (tool "Bash"). */
  function sessionText(content: string, outcome: unknown): string {
    return [
      JSON.stringify({ kind: "meta", sid: "cap", v: 1, ...baseOpenOpts }),
      JSON.stringify({ kind: "user", ts: "t", content: [{ type: "text", text: "go" }] }),
      JSON.stringify({
        kind: "assistant",
        ts: "t",
        content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: {} }],
        stopReason: "tool_use",
      }),
      JSON.stringify({
        kind: "tool_result",
        ts: "t",
        tool_use_id: "tu_1",
        content,
        isError: false,
        outcome,
      }),
    ].join("\n")
  }

  /** Content "body" and one span for each text, joined with a line break. */
  function hand(texts: string[], kind = "note", attrs?: Record<string, string>) {
    let content = "body"
    const annotations: unknown[] = []
    for (const t of texts) {
      content += "\n"
      const start = content.length
      content += t
      annotations.push({ kind, ...(attrs && { attrs }), start, end: content.length })
    }
    return { content, outcome: { v: 1, bodyEnd: 4, annotations } }
  }

  function restore(c: { content: string; outcome: unknown }) {
    const events: LogEvent[] = []
    const diagnostics = createDiagnostics({ emit: (e: LogEvent) => events.push(e) })
    const loaded = loadSessionFromText(sessionText(c.content, c.outcome), { diagnostics })
    const blocks = [...loaded.messages, ...loaded.displayMessages].flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : [],
    ) as ToolResultBlock[]
    const dropped = events.filter((e) => e.source === "tool-outcome.record-dropped")
    return { blocks, dropped }
  }

  const keys17 = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]))
  const cases: [string, ReturnType<typeof hand>, string][] = [
    ["9 plugin spans", hand(Array(9).fill("x")), "count"],
    ["a 3000-byte span", hand(["y".repeat(3000)]), "text-bytes"],
    ["17 attr keys", hand(["z"], "note", keys17), "attr-keys"],
    ["a 300-byte attr value", hand(["z"], "note", { k: "v".repeat(300) }), "attr-value-bytes"],
    ["9000 bytes in total", hand(Array(5).fill("w".repeat(1800))), "total-bytes"],
  ]
  for (const [name, c, cap] of cases) {
    it(`${name}: no outcome, same content, one record-dropped (${cap})`, () => {
      const { blocks, dropped } = restore(c)
      expect(blocks).toHaveLength(2) // model fold and display fold
      for (const b of blocks) {
        expect(b.content).toBe(c.content)
        expect("outcome" in b).toBe(false)
      }
      expect(dropped).toHaveLength(1)
      expect(dropped[0]?.message).toBe("")
      expect(dropped[0]?.structuredData).toEqual({ tool: "Bash", reason: "over-cap", cap })
    })
  }

  it("only core spans over the size limits: the outcome restores, no diagnostic", () => {
    const big = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, "v".repeat(300)]))
    const c = hand(Array(10).fill("p".repeat(3000)), "raw-output", big)
    const { blocks, dropped } = restore(c)
    for (const b of blocks) expect(b.outcome).toEqual(c.outcome as PersistedToolOutcome)
    expect(dropped).toEqual([])
  })
})

describe("tool_result outcome: codec round trip", () => {
  it("legacy -> canonical -> legacy keeps outcome deep-equal", () => {
    const outcome: PersistedToolOutcome = {
      v: 1,
      bodyEnd: 2,
      annotations: [{ kind: "k", attrs: { a: 1 }, start: 3, end: 4 }],
      data: { x: [1] },
    }
    const msg: Message = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok\nz", outcome }],
    }
    const canonical = messageToCanonical(msg)
    const cb = canonical.content[0]
    expect(cb?.type === "tool_result" ? cb.outcome : undefined).toEqual(outcome)
    const back = messageFromCanonical(canonical)
    const b = Array.isArray(back.content) ? back.content[0] : undefined
    expect(b?.type === "tool_result" ? b.outcome : undefined).toEqual(outcome)
  })

  it("no outcome: no key in either direction", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
    }
    const canonical = messageToCanonical(msg)
    expect("outcome" in (canonical.content[0] ?? {})).toBe(false)
    const back = messageFromCanonical(canonical)
    expect("outcome" in ((back.content as unknown[])[0] as object)).toBe(false)
  })
})
