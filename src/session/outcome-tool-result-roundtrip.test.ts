/**
 * SPEC v6.1 D8 (M2): the `outcome` record form goes to the JSONL record
 * through the explicit 4th argument of `appendToolResult`, and restore puts
 * a valid value back on the block. The live block and the restored block are
 * deep-equal (D8 rule 8).
 */

import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { beforeAll, describe, expect, it } from "bun:test"

import type { ToolOutcome } from "../../plugin-api/src/types/tool-outcome.ts"
import type { PersistedToolOutcome } from "../../plugin-api/src/types/tool-outcome-record.ts"
import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import { formatDiagnosticsAnnotation } from "../agent/tool-preview-budget.ts"
import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import { messageFromCanonical, messageToCanonical } from "../llm/codec/message-codec.ts"
import type { Message, ToolResultBlock } from "../llm/messages.ts"
import { finalizeOutcome } from "../loops/tool-outcome-finalize.ts"
import { modeActiveStampText } from "../modes/mode-text.ts"
import { PluginLoader } from "../plugins/loader.ts"
import { wrapHookContext } from "../sdk/hook-context.ts"
import {
  attachPersistedOutcome,
  CORE_SPAN_TEXT_MAX_BYTES,
  validatePersistedToolOutcome,
} from "../sdk/tool-outcome-record.ts"
import { SIBLING_REPO_ROOT, siblingPluginPresent } from "../test-utils/sibling-repo.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"
import {
  policyRewriteNoteText,
  previewTagText,
  truncatedNoticeText,
} from "../tools/tool-result-text.ts"
import { MAX_TOOL_OUTPUT_BYTES, truncateToolOutput } from "../tools/truncation.ts"

import { formatRawOutputFooter } from "./blob-store.ts"
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
    const record = attachPersistedOutcome(live, liveOutcome)
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
    const record = attachPersistedOutcome(live, liveOutcome)
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
    attachPersistedOutcome(live, liveOutcome)
    const store = open("oc-noarg")
    writeTurn(store, live)
    expect(readFileSync(store.path, "utf-8")).not.toContain('"outcome"')
    const restored = restoredBlock(store, "oc-noarg")
    expect(restored !== undefined && "outcome" in restored).toBe(false)
  })

  it("rawBlob and outcome are written together", () => {
    const text = finalizeOutcome(liveOutcome).text
    const live: ToolResultBlock = { type: "tool_result", tool_use_id: "tu_1", content: text }
    const record = attachPersistedOutcome(live, liveOutcome)
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
    const record = attachPersistedOutcome(live, liveOutcome)
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

/** One tool_use + tool_result session text for a hand-made stored outcome. */
function oneResultSession(content: string, outcome: unknown, tool = "Bash"): string {
  return [
    JSON.stringify({ kind: "meta", sid: "s", v: 1, ...baseOpenOpts }),
    JSON.stringify({ kind: "user", ts: "t", content: [{ type: "text", text: "go" }] }),
    JSON.stringify({
      kind: "assistant",
      ts: "t",
      content: [{ type: "tool_use", id: "tu_1", name: tool, input: {} }],
      stopReason: "tool_use",
    }),
    JSON.stringify({
      kind: "tool_result",
      ts: "t",
      tool_use_id: "tu_1",
      content,
      isError: false,
      ...(outcome === undefined ? {} : { outcome }),
    }),
  ].join("\n")
}

/** Load a session text with a capture of the diagnostics. */
function loadCaptured(text: string) {
  const events: LogEvent[] = []
  const diagnostics = createDiagnostics({ emit: (e: LogEvent) => events.push(e) })
  const loaded = loadSessionFromText(text, { diagnostics })
  const results = (messages: Message[]) =>
    messages.flatMap((m) =>
      Array.isArray(m.content) ? m.content.filter((b) => b.type === "tool_result") : [],
    ) as ToolResultBlock[]
  return {
    model: results(loaded.messages),
    display: results(loaded.displayMessages),
    events,
    dropped: events.filter((e) => e.source === "tool-outcome.record-dropped"),
  }
}

/** An outcome with `n` plugin annotations ("note", owner p1 or p2), each "n" x 4. */
function pluginOutcome(n: number): ToolOutcome {
  return {
    body: { text: "body" },
    annotations: Array.from({ length: n }, (_, i) => ({
      kind: "note",
      text: "nnnn",
      join: "\n",
      owner: i % 2 === 0 ? "p1" : "p2",
    })),
    isError: false,
    aborted: false,
  }
}

describe("tool_result outcome: compact replacementMessages restore (F16)", () => {
  /** A session with one compact record whose replacement holds one tool_result block. */
  function compactSession(block: Record<string, unknown>): string {
    return [
      JSON.stringify({ kind: "meta", sid: "c", v: 1, ...baseOpenOpts }),
      JSON.stringify({ kind: "user", ts: "t", content: [{ type: "text", text: "old" }] }),
      JSON.stringify({
        kind: "compact",
        ts: "t",
        reason: "manual",
        compactKind: "local",
        messagesBefore: 1,
        messagesAfter: 3,
        replacementMessages: [
          { role: "user", content: [{ type: "text", text: "checkpoint" }] },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "tu_c", name: "Bash", input: {} }],
          },
          { role: "user", content: [block] },
        ],
      }),
    ].join("\n")
  }

  function compactBlock(c: ReturnType<typeof loadCaptured>): ToolResultBlock | undefined {
    return c.model.find((b) => b.tool_use_id === "tu_c")
  }

  it("a valid outcome is kept (deep-equal), no diagnostic", () => {
    const o = pluginOutcome(2)
    const text = finalizeOutcome(o).text
    const live: ToolResultBlock = { type: "tool_result", tool_use_id: "tu_c", content: text }
    const record = attachPersistedOutcome(live, o)
    expect(record).toBeDefined()
    const c = loadCaptured(
      compactSession(JSON.parse(JSON.stringify(live)) as Record<string, unknown>),
    )
    expect(compactBlock(c)).toEqual(live)
    expect(compactBlock(c)?.outcome).toEqual(record as PersistedToolOutcome)
    expect(c.dropped).toEqual([])
  })

  it('a junk outcome {v:99, bodyEnd:999, annotations:"junk"} is removed; content stays', () => {
    const c = loadCaptured(
      compactSession({
        type: "tool_result",
        tool_use_id: "tu_c",
        content: "kept text",
        outcome: { v: 99, bodyEnd: 999, annotations: "junk" },
      }),
    )
    const b = compactBlock(c)
    expect(b?.content).toBe("kept text")
    expect(b !== undefined && "outcome" in b).toBe(false)
    expect(c.dropped).toEqual([])
  })

  it("9 plugin spans: the outcome is removed, content stays, ONE record-dropped", () => {
    let content = "body"
    const annotations: unknown[] = []
    for (let i = 0; i < 9; i++) {
      content += "\n"
      const start = content.length
      content += "x"
      annotations.push({ kind: "note", start, end: content.length })
    }
    const c = loadCaptured(
      compactSession({
        type: "tool_result",
        tool_use_id: "tu_c",
        content,
        outcome: { v: 1, bodyEnd: 4, annotations },
      }),
    )
    const b = compactBlock(c)
    expect(b?.content).toBe(content)
    expect(b !== undefined && "outcome" in b).toBe(false)
    expect(c.dropped).toHaveLength(1)
    expect(c.dropped[0]?.structuredData).toEqual({ tool: "Bash", reason: "over-cap", cap: "count" })
  })

  it("the restored copy does not alias the stored record", () => {
    const o = pluginOutcome(1)
    const text = finalizeOutcome(o).text
    const live: ToolResultBlock = { type: "tool_result", tool_use_id: "tu_c", content: text }
    attachPersistedOutcome(live, o)
    const c = loadCaptured(
      compactSession(JSON.parse(JSON.stringify(live)) as Record<string, unknown>),
    )
    const first = compactBlock(c)
    const again = compactBlock(
      loadCaptured(compactSession(JSON.parse(JSON.stringify(live)) as Record<string, unknown>)),
    )
    expect(first?.outcome).not.toBe(again?.outcome)
  })
})

describe("restore never throws on bad stored content (M1)", () => {
  // bodyEnd 1: valid for the text "x" (and "ok"), not valid for the text "" of bad content.
  const goodOutcome = { v: 1, bodyEnd: 1, annotations: [] }
  const header = JSON.stringify({ kind: "meta", sid: "bad", v: 1, ...baseOpenOpts })
  const user = JSON.stringify({ kind: "user", ts: "t", content: [{ type: "text", text: "go" }] })
  const assistant = (content: unknown) =>
    JSON.stringify({ kind: "assistant", ts: "t", content, stopReason: "tool_use" })
  const toolResult = (content: unknown, outcome: unknown = goodOutcome) =>
    JSON.stringify({
      kind: "tool_result",
      ts: "t",
      tool_use_id: "tu_1",
      content,
      isError: false,
      outcome,
    })
  const badContents: [string, unknown][] = [
    ["content: null", null],
    ["content: [null]", [null]],
    ['content: "x" (a string)', "x"],
    ["an item {} with no type", [{}]],
  ]

  /** Load in the three ways that the restore uses: model fold, display fold, compact copies. */
  function loadAll(text: string) {
    const c = loadCaptured(text)
    return { ...c, all: [...c.model, ...c.display] }
  }

  for (const [name, content] of badContents) {
    it(`tool_result branch, ${name}: no throw, the rest of the record restores`, () => {
      const text = [
        header,
        user,
        assistant([{ type: "tool_use", id: "tu_1", name: "T", input: {} }]),
        toolResult(content),
      ].join("\n")
      let c: ReturnType<typeof loadAll> | undefined
      expect(() => {
        c = loadAll(text)
      }).not.toThrow()
      expect(c?.all).toHaveLength(2)
      for (const b of c?.all ?? []) {
        expect(b.tool_use_id).toBe("tu_1")
        expect(b.content).toEqual(content as ToolResultBlock["content"])
        // A string content "x" with bodyEnd 1 is a valid record; bad content: no outcome.
        if (typeof content === "string")
          expect(b.outcome).toEqual(goodOutcome as PersistedToolOutcome)
        else expect("outcome" in b).toBe(false)
      }
    })

    it(`assistant record, ${name}: no throw, the next tool_result restores`, () => {
      const text = [header, user, assistant(content), toolResult("ok")].join("\n")
      let c: ReturnType<typeof loadAll> | undefined
      expect(() => {
        c = loadAll(text)
      }).not.toThrow()
      for (const b of c?.all ?? []) {
        expect(b.content).toBe("ok")
        expect(b.outcome).toEqual(goodOutcome as PersistedToolOutcome)
      }
    })

    it(`compact branch, ${name}: no throw, the other replacement messages restore`, () => {
      const text = [
        header,
        user,
        JSON.stringify({
          kind: "compact",
          ts: "t",
          reason: "manual",
          compactKind: "local",
          messagesBefore: 1,
          messagesAfter: 6,
          replacementMessages: [
            { role: "user", content: [{ type: "text", text: "checkpoint" }] },
            { role: "assistant", content },
            { role: "user", content: [{ type: "text", text: "next" }] },
            {
              role: "assistant",
              content: [
                null,
                { type: "tool_use", id: "tu_c", name: "Bash", input: {} },
                { type: "tool_use", id: "tu_d", name: "Bash", input: {} },
              ],
            },
            {
              role: "user",
              content: [
                null,
                {},
                { type: "tool_result", tool_use_id: "tu_c", content, outcome: goodOutcome },
                { type: "tool_result", tool_use_id: "tu_d", content: "ok", outcome: goodOutcome },
              ],
            },
          ],
        }),
      ].join("\n")
      let c: ReturnType<typeof loadAll> | undefined
      expect(() => {
        c = loadAll(text)
      }).not.toThrow()
      const bad = c?.model.find((b) => b.tool_use_id === "tu_c")
      expect(bad?.content).toEqual(content as ToolResultBlock["content"])
      if (typeof content === "string")
        expect(bad?.outcome).toEqual(goodOutcome as PersistedToolOutcome)
      else expect(bad !== undefined && "outcome" in bad).toBe(false)
      const good = c?.model.find((b) => b.tool_use_id === "tu_d")
      expect(good?.outcome).toEqual(goodOutcome as PersistedToolOutcome)
    })
  }
})

describe("tool_result outcome: one count rule, write path and restore (F17)", () => {
  it("8 plugin spans (two plugins): attach, persist and restore are deep-equal", () => {
    const o = pluginOutcome(8)
    const text = finalizeOutcome(o).text
    const live: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu_8",
      content: text,
      is_error: false,
    }
    const record = attachPersistedOutcome(live, o)
    expect(record?.annotations).toHaveLength(8)
    const store = open("oc-eight")
    writeTurn(store, live, record)
    expect(restoredBlock(store, "oc-eight")).toEqual(live)
  })

  it("10 plugin spans: dropped at attach with ONE diagnostic; nothing to restore", () => {
    const o = pluginOutcome(10)
    const text = finalizeOutcome(o).text
    const live: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: "tu_10",
      content: text,
      is_error: false,
    }
    const seen: { id: string; data: Record<string, unknown> }[] = []
    const record = attachPersistedOutcome(live, o, (id, data) => seen.push({ id, data }), "T")
    expect(record).toBeUndefined()
    expect("outcome" in live).toBe(false)
    expect(seen).toEqual([
      { id: "tool-outcome.record-dropped", data: { tool: "T", reason: "over-cap", cap: "count" } },
    ])
    const store = open("oc-ten")
    writeTurn(store, live, record)
    expect("outcome" in toolResultRecord(store.path)).toBe(false)
    const restored = restoredBlock(store, "oc-ten")
    expect(restored).toEqual(live)
    expect(restored !== undefined && "outcome" in restored).toBe(false)
  })
})

describe("tool_result outcome: data cap on restore (16000 bytes)", () => {
  it("a stored 5 MB data value is dropped; the rest stays; one data-dropped", () => {
    const outcome = { v: 1, bodyEnd: 2, annotations: [], data: "d".repeat(5 * 1024 * 1024) }
    const c = loadCaptured(oneResultSession("ok", outcome))
    for (const b of [...c.model, ...c.display]) {
      expect(b.outcome).toEqual({ v: 1, bodyEnd: 2, annotations: [] })
    }
    const dropped = c.events.filter((e) => e.source === "tool-outcome.data-dropped")
    expect(dropped).toHaveLength(1)
    expect(dropped[0]?.structuredData).toEqual({
      tool: "Bash",
      field: "data",
      bytes: 5 * 1024 * 1024 + 2,
      reason: "over-cap",
    })
  })
})

describe("tool_result outcome: core span cap on restore (F15b)", () => {
  it("a 10000-byte raw-output span: no outcome, same content, one record-dropped", () => {
    const content = `body\n\n${"r".repeat(10_000)}`
    const outcome = {
      v: 1,
      bodyEnd: 4,
      annotations: [{ kind: "raw-output", start: 6, end: content.length }],
    }
    const c = loadCaptured(oneResultSession(content, outcome))
    for (const b of [...c.model, ...c.display]) {
      expect(b.content).toBe(content)
      expect("outcome" in b).toBe(false)
    }
    expect(c.dropped).toHaveLength(1)
    expect(c.dropped[0]?.structuredData).toEqual({
      tool: "Bash",
      reason: "over-cap",
      cap: "core-span-text",
    })
  })
})

/**
 * The real core annotation texts, from the real producers in core and the
 * real text plugins (ma-core-tools-plugin and the other first-party text
 * plugins of the sibling repo). The worst real cases are below the core span
 * cap of 4096 UTF-8 bytes.
 */
describe.skipIf(!siblingPluginPresent("ma-core-tools-plugin"))(
  "core span cap: the real core annotation texts are below the cap (F15b)",
  () => {
    let text: SyntheticTextResolver
    beforeAll(async () => {
      const loader = await PluginLoader.load({
        roots: { embedded: [SIBLING_REPO_ROOT] },
        logger: () => {},
      })
      text = loader.syntheticText()
    })

    const bytes = (s: string) => new TextEncoder().encode(s).length
    // A blob path near PATH_MAX (1024 bytes on macOS): the worst real raw-output path.
    const longPath = `/Users/${"u".repeat(40)}/${"deep-directory-name/".repeat(45)}.minimal-agent/sessions/00000000-0000-4000-8000-9016b38983f1.blobs/toolu_01ABCDEFGHIJKLMNOPQRSTUV.raw`
    const toolNames = ["Bash", "Read", "Grep", "Glob", "Fetch", "WebSearch", "Other"]

    function realTexts(): [string, string][] {
      const out: [string, string][] = []
      // raw-output: the footer with a long path.
      out.push([
        "raw-output",
        formatRawOutputFooter({ path: longPath, bytes: 987_654_321, sha256: "ab12cd34ef567890" }),
      ])
      for (const tool of toolNames) {
        // output-preview: the tag with the long path (in the attribute and in the hint).
        out.push([
          "output-preview",
          previewTagText(text, { shown: 999_999, total: 9_999_999, tool, rawPath: longPath }),
        ])
        // output-truncated: the notice that the real clamp gives.
        const big = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(60)}`).join("\n")
        const t = truncateToolOutput(big, { tool, startLine: 123_456 }, text)
        const notice = truncatedNoticeText(text, {
          tool,
          shownBytes: t.info.shownBytes,
          totalBytes: t.info.totalBytes ?? 0,
          shownLines: t.info.shownLines,
          totalLines: t.info.totalLines ?? 0,
          cutLine: t.info.cutLine ?? 0,
          maxToolOutputBytes: MAX_TOOL_OUTPUT_BYTES,
        })
        expect(t.content.endsWith(`\n\n${notice}`)).toBe(true)
        out.push(["output-truncated", notice])
        // output-streak: the note after the threshold.
        const tracker = new ToolFeedbackTracker()
        let streak: string | null = null
        for (let i = 0; i < 3; i++) streak = tracker.observe(tool, true, text)
        out.push(["output-streak", streak ?? ""])
      }
      // mode-active: the mode stamp.
      out.push([
        "mode-active",
        modeActiveStampText(text, "a-long-custom-mode-id", new Date(0).toISOString()),
      ])
      // policy: the policy wrap with 10 notes. One line is the longest core
      // note: the policy rewrite note with 16 keys of 64 characters and more.
      const keys = Array.from(
        { length: 16 },
        (_, i) => `${"k".repeat(62)}${String(i).padStart(2, "0")}`,
      )
      const notes = [
        policyRewriteNoteText(text, keys.join(", "), 99),
        ...Array.from({ length: 9 }, (_, i) => `hook note ${i}: keep the change small.`),
      ]
      // One policy annotation for each note (SPEC D5 rule P): each line is one span.
      for (const line of wrapHookContext(notes).split("\n")) out.push(["policy", line])
      out.push(["policy (all 10 lines)", wrapHookContext(notes)])
      // diagnostics: the real core producer (`formatDiagnosticsAnnotation`)
      // with a real-size note set. The note lines have the shape of the
      // diagnostics plugin `formatNote` (`[line:col] severity [code] message`),
      // with its default cap of 8 notes (`maxInline: 8`), and real TypeScript
      // and Biome messages. The plugin has no cap on the length of one message.
      const diagNotes = [
        "12:7 error TS2345 Argument of type '{ id: string; name: string; input: Record<string, unknown>; }' is not assignable to parameter of type 'ToolUseBlock'. Property 'type' is missing in type '{ id: string; name: string; input: Record<string, unknown>; }' but required in type 'ToolUseBlock'.",
        "48:15 error TS2322 Type 'PersistedToolOutcome | undefined' is not assignable to type 'PersistedToolOutcome'. Type 'undefined' is not assignable to type 'PersistedToolOutcome'.",
        "103:3 error TS2339 Property 'outcome' does not exist on type 'ToolResultBlock | TextBlock | ImageBlock | ToolUseBlock | ThinkingBlock | RedactedThinkingBlock'. Property 'outcome' does not exist on type 'TextBlock'.",
        "131:22 error TS7006 Parameter 'record' implicitly has an 'any' type.",
        "164:9 error TS2554 Expected 2-4 arguments, but got 5.",
        "201:1 warning lint/suspicious/noExplicitAny Unexpected any. Specify a different type.",
        "233:5 warning lint/complexity/noForEach Prefer for...of instead of forEach.",
        "278:11 error TS18048 'loaded.messages[0].content' is possibly 'undefined'.",
      ]
      const diag = formatDiagnosticsAnnotation(diagNotes)
      expect(diag.startsWith('\n\n<ma::agent::diagnostics count="8">')).toBe(true)
      out.push(["diagnostics", diag.replace(/^\n+/, "")])
      return out
    }

    it("each real text is not empty and is at most CORE_SPAN_TEXT_MAX_BYTES", () => {
      const texts = realTexts()
      expect(texts.length).toBeGreaterThan(20)
      for (const [kind, t] of texts) {
        expect({ kind, empty: t.length === 0 }).toEqual({ kind, empty: false })
        expect({ kind, over: bytes(t) > CORE_SPAN_TEXT_MAX_BYTES }).toEqual({ kind, over: false })
      }
    })

    it("an outcome with the real texts as core spans restores (no core-span-text drop)", () => {
      const annotations = realTexts()
        .filter(([kind]) => !kind.includes(" "))
        .map(([kind, t]) => ({ kind, text: t, join: "\n", owner: "core" }))
      const o: ToolOutcome = { body: { text: "body" }, annotations, isError: false, aborted: false }
      const finalText = finalizeOutcome(o).text
      const seen: unknown[] = []
      const live: ToolResultBlock = { type: "tool_result", tool_use_id: "tu_r", content: finalText }
      const record = attachPersistedOutcome(live, o, (id, d) => seen.push({ id, d }))
      expect(seen).toEqual([])
      expect(record?.annotations).toHaveLength(annotations.length)
      expect(validatePersistedToolOutcome(record, finalText)).toEqual(
        record as PersistedToolOutcome,
      )
    })
  },
)
