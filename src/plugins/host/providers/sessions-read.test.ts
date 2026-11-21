import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { SessionStore, sessionFilePath } from "../../../session/session-store.ts"
import {
  fixtureSidebandOrNone,
  sidebandFixturePresent,
} from "../../../test-utils/sideband-fixture.ts"

import {
  buildWindow,
  createSessionsReadApi,
  recordBodyParts,
  toRecordView,
} from "./sessions-read.ts"

const SB = fixtureSidebandOrNone()

// ---------------------------------------------------------------------------
// Fixture: a temp sessions dir with two sessions
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "sessions-read-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

function seedSession(sid: string, turns: number): void {
  const store = SessionStore.open({
    sid,
    model: "test-model",
    cwd: "/proj/alpha",
    systemHash: "s",
    toolsHash: "t",
    agentVersion: "0.0.0",
    dir,
  })
  for (let i = 0; i < turns; i++) {
    store.appendUser(`prompt number ${i} with searchable-needle-${sid}`)
    store.appendAssistant(
      [
        { type: "text", text: `answer ${i}` },
        {
          type: "tool_use",
          id: `toolu_${sid}_${i}`,
          name: i % 2 === 0 ? "Bash" : "Read",
          input: { n: i },
        },
      ],
      "tool_use",
    )
    store.appendToolResult({
      type: "tool_result",
      tool_use_id: `toolu_${sid}_${i}`,
      content: `result ${i}`,
      is_error: false,
    })
  }
}

seedSession("sid-aaa", 3)
seedSession("sid-bbb", 2)

const api = createSessionsReadApi({ dir })

describe("sessions:read list", () => {
  it("lists newest first with totals", async () => {
    const { items, total } = await api.list()
    expect(total).toBe(2)
    expect(items[0].sid).toBe("sid-bbb")
    expect(items[1].sid).toBe("sid-aaa")
  })

  it("filters by query and paginates", async () => {
    const { items, total } = await api.list({ query: "aaa" })
    expect(total).toBe(1)
    expect(items[0].sid).toBe("sid-aaa")

    const page = await api.list({ limit: 1, offset: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.items[0].sid).toBe("sid-aaa")
  })
})

describe("sessions:read meta", () => {
  it("returns counts, first prompt, liveness, and null for unknown sid", async () => {
    const m = await api.meta("sid-aaa")
    expect(m).not.toBeNull()
    if (!m) return
    expect(m.recordCount).toBe(1 + 3 * 3) // meta + 3×(user, assistant, tool_result)
    expect(m.counts.user).toBe(3)
    expect(m.counts.assistant).toBe(3)
    expect(m.firstPromptParts?.[0]).toContain("prompt number 0")
    expect(m.liveness.status).toBe("dead") // no attach record was written
    expect(m.model).toBe("test-model")

    expect(await api.meta("nope")).toBeNull()
  })
})

describe("sessions:read window", () => {
  it("anchors at the end by default semantics (newest last, stable indexes)", async () => {
    const w = await api.window("sid-aaa", { anchor: "end", limit: 3 })
    expect(w).not.toBeNull()
    if (!w) return
    expect(w.total).toBe(10)
    expect(w.items).toHaveLength(3)
    expect(w.lastIndex).toBe(9)
    expect(w.items[0].index).toBe(7)
  })

  it("anchors at the start with offset", async () => {
    const w = await api.window("sid-aaa", { anchor: "start", offset: 1, limit: 2 })
    if (!w) throw new Error("expected window")
    expect(w.firstIndex).toBe(1)
    expect(w.items.map((i) => i.index)).toEqual([1, 2])
    expect(w.items[0].kind).toBe("user")
  })

  it("carries the preview budget and no host text", async () => {
    const w = await api.window("sid-aaa", { anchor: "start", limit: 10, previewChars: 80 })
    if (!w) throw new Error("expected window")
    const user = w.items.find((i) => i.kind === "user")
    if (!user) throw new Error("expected a user record")
    expect(user.previewChars).toBe(80)
    expect(user.parts.length).toBeGreaterThan(0)
    expect(user.userId).toBeString()
  })

  it("returns null for an unknown sid", async () => {
    expect(await api.window("nope", { anchor: "end" })).toBeNull()
  })
})

describe("sessions:read toolCalls", () => {
  it("filters by tool name, newest first", async () => {
    const r = await api.toolCalls("sid-aaa", { tool: "Bash" })
    expect(r).not.toBeNull()
    if (!r) return
    expect(r.total).toBe(2) // i=0 and i=2 are Bash
    expect(r.hits[0].index).toBeGreaterThan(r.hits[1].index)
    expect(r.hits.every((h) => h.tool === "Bash")).toBe(true)
  })

  it("lists all tools without a filter, oldest first when asked", async () => {
    const r = await api.toolCalls("sid-aaa", { newestFirst: false })
    if (!r) throw new Error("expected hits")
    expect(r.total).toBe(3)
    expect(r.hits[0].index).toBeLessThan(r.hits[2].index)
  })
})

describe("sessions:read search", () => {
  it("searches one session and returns match offsets", async () => {
    const r = await api.search({ sid: "sid-aaa", query: "searchable-needle-sid-aaa" })
    expect(r.total).toBe(3)
    expect(r.scannedSessions).toBe(1)
    expect(r.hits[0].parts[0].text).toContain("searchable-needle-sid-aaa")
    expect(r.hits[0].matchLength).toBe("searchable-needle-sid-aaa".length)
  })

  it("searches across sessions when sid omitted", async () => {
    const r = await api.search({ query: "prompt number 0" })
    expect(r.scannedSessions).toBe(2)
    expect(r.total).toBe(2)
    const sids = new Set(r.hits.map((h) => h.sid))
    expect(sids.has("sid-aaa")).toBe(true)
    expect(sids.has("sid-bbb")).toBe(true)
  })

  it("empty query returns nothing", async () => {
    const r = await api.search({ query: "" })
    expect(r.total).toBe(0)
  })
})

describe("pure helpers", () => {
  it("recordBodyParts strips every runtime attachment category from user content", () => {
    // Regression: the body builder was passing runtime attachment blocks
    // through verbatim, leaking XML into SessionHistory previews and the
    // TUI scrollback.  session-replay.ts already filters these via
    // isRuntimeAttachmentBlock from the shared runtime-attachments.ts
    // module; recordBodyParts imports isRuntimeAttachmentText (same regex
    // list) and must match.
    //
    // Every attachment the agent prepends to a user message is tested
    // here.  When agent.ts gains a new attachment type and its opener
    // regex is added to runtime-attachments.ts, this test will fail if
    // recordBodyParts isn't aware of it — the shared module ensures the two
    // code paths stay in sync.
    const t = recordBodyParts(
      {
        kind: "user",
        ts: "2026-01-01T00:00:00Z",
        content: [
          // --- <ma::agent::*> canonical schema ---
          {
            type: "text",
            text: '<ma::agent::tasks total="3" done="2" doing="0" todo="1" canceled="0">\n1  #abc  done  step\n</ma::agent::tasks>',
          },
          {
            type: "text",
            text: "<ma::agent::short-term-memory>\n[#1] active hypothesis\n</ma::agent::short-term-memory>",
          },
          {
            type: "text",
            text: '<ma::agent::memory-saved scope="project" id="x-1234">pinned\n</ma::agent::memory-saved>',
          },
          { type: "text", text: "<ma::agent::subagents>live fleet digest</ma::agent::subagents>" },
          { type: "text", text: '<ma::agent::mode-change from="default" to="ask" at="..." />' },
          { type: "text", text: '<ma::agent::mode-active id="ask" since="..." />' },
          { type: "text", text: '<ma::agent::emergency-cap-triggered round="200" />' },
          {
            type: "text",
            text: "<ma::agent::turn-aborted />\nThe previous turn was interrupted...",
          },
          {
            type: "text",
            text: "<ma::agent::output-truncated />\nThe response was truncated due to token limits...",
          },
          // --- <ma::plugin::*> ---
          {
            type: "text",
            text: '<ma::plugin::diagnostics count="3">...</ma::plugin::diagnostics>',
          },
          {
            type: "text",
            text: '<ma::plugins>\n  <skill name="finder">...</skill>\n</ma::plugins>',
          },
          // --- Legacy bare forms (migration window compat) ---
          { type: "text", text: '<mode-change from="default" to="ask" />' },
          { type: "text", text: '<ma::mode-active id="plan" since="..." />' },
          { type: "text", text: "<short-term-memory>\n[#1] old-form\n</short-term-memory>" },
          { type: "text", text: '<memory-saved scope="global" id="g">old form</memory-saved>' },
          // --- Edge cases ---
          { type: "text", text: '  <ma::agent::tasks foo="bar">  ' }, // leading whitespace
          { type: "text", text: '<MA::AGENT::TASKS total="1">...</MA::AGENT::TASKS>' }, // case-insensitive
          { type: "text", text: "" }, // empty block — not an attachment
          { type: "text", text: "real user question here" }, // kept verbatim
          { type: "text", text: "  trimmed but not an attachment" }, // whitespace only, no tag
        ],
      },
      SB,
    )
      .map((p) => p.text)
      .join("\n")
    // No runtime attachment text should leak through.
    expect(t).not.toContain("<ma::agent::")
    expect(t).not.toContain("<ma::plugin::")
    expect(t).not.toContain("<ma::plugins>")
    expect(t).not.toContain("<mode-change")
    expect(t).not.toContain("<ma::mode-active")
    expect(t).not.toContain("<short-term-memory")
    expect(t).not.toContain("<memory-saved")
    // Real user content must survive.
    expect(t).toContain("real user question here")
    expect(t).toContain("trimmed but not an attachment")
    // Empty text blocks produce no separators — they're skipped by the
    // empty-string guard, not by attachment detection.  Verify there's
    // no trailing/leading whitespace artifact from the empty block.
    expect(t).not.toMatch(/\n\s*\n\s*$/)
  })

  it("buildWindow clamps limit and handles empty record lists", () => {
    const w = buildWindow("x", [], { anchor: "end" })
    expect(w.total).toBe(0)
    expect(w.firstIndex).toBeNull()
    expect(w.lastIndex).toBeNull()
  })
})

describe("malformed index lines", () => {
  it("list survives a corrupt index row", async () => {
    const idx = join(dir, "index.jsonl")
    writeFileSync(idx, `not-json\n`, { flag: "a" })
    const { total } = await api.list()
    expect(total).toBe(2)
  })

  it("list drops index rows whose jsonl is missing", async () => {
    const idx = join(dir, "index.jsonl")
    writeFileSync(
      idx,
      `${JSON.stringify({ sid: "ghost", createdAt: "2026-01-01T00:00:00Z", cwd: "/x", model: "m" })}\n`,
      { flag: "a" },
    )
    const { items } = await api.list()
    expect(items.some((i) => i.sid === "ghost")).toBe(false)
  })
})

describe("blob count in meta", () => {
  it("counts .raw files in the sid blob dir", async () => {
    mkdirSync(join(dir, "sid-aaa.blobs"), { recursive: true })
    writeFileSync(join(dir, "sid-aaa.blobs", "toolu_1.raw"), "x".repeat(10))
    writeFileSync(join(dir, "sid-aaa.blobs", "toolu_2.raw"), "y".repeat(10))
    const m = await api.meta("sid-aaa")
    expect(m?.blobCount).toBe(2)
  })
})

describe("structured data fields (S13.1)", () => {
  it("RecordView carries parts, facts, previewChars", async () => {
    const w = await api.window("sid-bbb", { anchor: "start", limit: 10, previewChars: 80 })
    if (!w) throw new Error("expected window")
    const user = w.items.find((i) => i.kind === "user")
    const asst = w.items.find((i) => i.kind === "assistant")
    const res = w.items.find((i) => i.kind === "tool_result")
    if (!user || !asst || !res) throw new Error("expected records")
    expect(user.previewChars).toBe(80)
    expect(user.parts).toEqual([
      { kind: "text", text: "prompt number 0 with searchable-needle-sid-bbb", toolName: null },
    ])
    expect(user.facts.contentIsString).toBe(true)
    expect(asst.parts).toEqual([
      { kind: "text", text: "answer 0", toolName: null },
      { kind: "tool_use", text: '{"n":0}', toolName: "Bash" },
    ])
    expect(asst.facts.toolNames).toEqual(["Bash"])
    expect(asst.facts.hasText).toBe(true)
    expect(asst.facts.stopReason).toBe("tool_use")
    expect(res.facts.isError).toBe(false)
    expect(res.facts.toolUseId).toBe("toolu_sid-bbb_0")
  })

  it("facts cover every record kind", () => {
    const ts = "2026-01-01T00:00:00Z"
    const meta = toRecordView(
      {
        kind: "meta",
        formatVersion: 1,
        sid: "s",
        createdAt: ts,
        model: "m1",
        cwd: "/c",
        systemHash: "a",
        toolsHash: "b",
        agentVersion: "0",
      },
      0,
      80,
    )
    expect(meta.facts.model).toBe("m1")
    expect(meta.facts.cwd).toBe("/c")
    const rw = toRecordView({ kind: "rewind", ts, to: "u3", droppedCount: 2 } as never, 1, 80)
    expect(rw.facts.rewindTo).toBe("u3")
    expect(rw.facts.droppedCount).toBe(2)
    const att = toRecordView({ kind: "attach", ts, pid: 7, hostname: "h1" } as never, 2, 80)
    expect(att.facts.pid).toBe(7)
    expect(att.facts.hostname).toBe("h1")
    const det = toRecordView({ kind: "detach", ts, pid: 7, reason: "r1" } as never, 3, 80)
    expect(det.facts.reason).toBe("r1")
    const rc = toRecordView({ kind: "round_checkpoint", ts, round: 4 } as never, 4, 80)
    expect(rc.facts.round).toBe(4)
    const cp = toRecordView(
      {
        kind: "compact",
        ts,
        compactKind: "k",
        reason: "r",
        messagesBefore: 9,
        messagesAfter: 2,
        replacementMessages: [{ role: "user", content: "hello" }],
      } as never,
      5,
      80,
    )
    expect(cp.facts.compactKind).toBe("k")
    expect(cp.facts.messagesBefore).toBe(9)
    expect(cp.facts.messagesAfter).toBe(2)
    expect(cp.parts).toEqual([{ kind: "message", text: "hello", toolName: null, role: "user" }])
    const he = toRecordView(
      { kind: "history_edit", ts, backupSid: "b1", droppedRecordCount: 5 } as never,
      6,
      80,
    )
    expect(he.facts.backupSid).toBe("b1")
    expect(he.facts.droppedRecordCount).toBe(5)
  })

  it("user block content counts results and texts, thinking parts keep raw text", () => {
    const ts = "2026-01-01T00:00:00Z"
    const u = toRecordView(
      {
        kind: "user",
        ts,
        content: [
          { type: "tool_result", tool_use_id: "t", content: "r" },
          { type: "text", text: "t1" },
        ],
      } as never,
      0,
      80,
    )
    expect(u.facts.contentIsString).toBe(false)
    expect(u.facts.toolResultCount).toBe(1)
    expect(u.facts.textBlockCount).toBe(1)
    expect(u.facts.blockCount).toBe(2)
    const a = toRecordView(
      {
        kind: "assistant",
        ts,
        content: [{ type: "thinking", thinking: "deep", signature: "s" }],
      } as never,
      1,
      80,
    )
    expect(a.parts).toEqual([{ kind: "thinking", text: "deep", toolName: null }])
    expect(a.facts.hasText).toBe(false)
  })

  it("SearchHit carries parts and match offsets", async () => {
    const r = await api.search({ sid: "sid-aaa", query: "NEEDLE-sid-aaa" })
    const h = r.hits[0]
    expect(h.matchLength).toBe("NEEDLE-sid-aaa".length)
    expect(h.previewChars).toBe(160)
    const body = h.parts.map((p) => p.text).join("\n")
    expect(body.slice(h.matchAt, h.matchAt + h.matchLength).toLowerCase()).toBe("needle-sid-aaa")
  })

  it("ToolCallHit carries raw input", async () => {
    const r = await api.toolCalls("sid-aaa", { tool: "Read" })
    if (!r) throw new Error("expected hits")
    expect(r.hits[0].input).toEqual({ n: 1 })
    expect(r.hits[0].inputJson).toBe('{"n":1}')
  })

  it("SessionMetaView carries first prompt parts", async () => {
    const m = await api.meta("sid-bbb")
    expect(m?.firstPromptParts).toEqual(["prompt number 0 with searchable-needle-sid-bbb"])
  })
})

describe("exact data contract (S13.1 fix)", () => {
  /** Test-side rebuild of the prefixed body, as a plugin must do it. */
  function rebuild(
    parts: readonly { kind: string; text: string; toolName: string | null; role?: string }[],
  ): string {
    return parts
      .map((p) => {
        if (p.kind === "thinking") return `[thinking] ${p.text}`
        if (p.kind === "tool_use") return `[tool_use ${p.toolName}] ${p.text}`
        if (p.kind === "message") return `${p.role}: ${p.text}`
        return p.text
      })
      .join("\n")
  }

  const mixDir = mkdtempSync(join(tmpdir(), "sessions-read-mix-"))
  afterAll(() => rmSync(mixDir, { recursive: true, force: true }))
  const mixApi = createSessionsReadApi({ dir: mixDir })
  function seedMixed(): void {
    const store = SessionStore.open({
      sid: "sid-mix",
      model: "test-model",
      cwd: "/proj/alpha",
      systemHash: "s",
      toolsHash: "t",
      agentVersion: "0.0.0",
      dir: mixDir,
    })
    store.appendUser("hello")
    store.appendAssistant(
      [
        { type: "thinking", thinking: "deep-think-zz", signature: "sig" },
        { type: "tool_use", id: "toolu_mix", name: "Bash", input: { q: "zq-input" } },
      ],
      "tool_use",
    )
    store.appendCompact({
      reason: "manual",
      compactKind: "local",
      messagesBefore: 3,
      messagesAfter: 1,
      replacementMessages: [{ role: "user", content: "compact-zz" }],
    })
  }
  seedMixed()

  it("renderBody builds the searched body and matchAt slices the query in it", async () => {
    for (const query of [
      "deep-think-zz",
      "tool_use Bash",
      "zq-input",
      "user: compact-zz",
      "[thinking]",
    ]) {
      const r = await mixApi.search({ sid: "sid-mix", query, renderBody: rebuild })
      expect(r.hits.length).toBeGreaterThan(0)
      for (const h of r.hits) {
        const body = rebuild(h.parts)
        expect(body.slice(h.matchAt, h.matchAt + h.matchLength).toLowerCase()).toBe(
          query.toLowerCase(),
        )
      }
    }
  })

  it("without renderBody the body is the raw texts joined by a newline", async () => {
    const r = await mixApi.search({ sid: "sid-mix", query: "deep-think-zz" })
    const h = r.hits[0]
    const body = h.parts.map((p) => p.text).join("\n")
    expect(body.slice(h.matchAt, h.matchAt + h.matchLength)).toBe("deep-think-zz")
  })

  it("facts.stopReason is raw (empty string kept)", () => {
    const a = toRecordView(
      {
        kind: "assistant",
        ts: "2026-01-01T00:00:00Z",
        content: [{ type: "text", text: "x" }],
        stopReason: "",
      } as never,
      0,
      80,
    )
    expect(a.facts.stopReason).toBe("")
    const b = toRecordView(
      { kind: "assistant", ts: "2026-01-01T00:00:00Z", content: [] } as never,
      0,
      80,
    )
    expect(b.facts.stopReason).toBeNull()
  })

  it("unknown kind: facts all null, raw JSON in parts[0]", () => {
    const u = toRecordView({ kind: "zzz", ts: "t" } as never, 0, 80)
    expect(u.parts).toEqual([{ kind: "raw", text: '{"kind":"zzz","ts":"t"}', toolName: null }])
    expect(u.facts.model).toBeNull()
    expect(u.facts.contentIsString).toBeNull()
  })

  it("ToolCallHit exposes inputPreviewChars and SessionMetaView firstPromptChars", async () => {
    const t = await api.toolCalls("sid-aaa", { tool: "Read" })
    expect(t?.hits[0].inputPreviewChars).toBe(200)
    const m = await api.meta("sid-bbb")
    expect(m?.firstPromptChars).toBe(100)
  })
})

describe("sessions:read records (S13.2)", () => {
  it("returns raw records, meta and model-facing messages", async () => {
    const r = await api.records("sid-aaa")
    if (!r) throw new Error("expected records")
    expect(r.sid).toBe("sid-aaa")
    expect(r.meta?.model).toBe("test-model")
    expect(r.meta?.cwd).toBe("/proj/alpha")
    expect(r.records[0].kind).toBe("meta")
    expect(r.records.length).toBeGreaterThan(r.messages.length)
    const tr = r.messages
      .flatMap((m) => (typeof m.content === "string" ? [] : m.content))
      .find((b) => b.type === "tool_result")
    expect(tr?.type === "tool_result" && tr.is_error).toBe(false)
  })

  it("returns null for unknown or unsafe sid", async () => {
    expect(await api.records("nope")).toBeNull()
    expect(await api.records("../x")).toBeNull()
  })

  // An old compact row has no `meta` and its checkpoint text has no block
  // mark: only the codec finds the `compaction` node (design step 8).
  it.skipIf(!sidebandFixturePresent())(
    "finds an old unmarked compaction checkpoint with the sideband",
    async () => {
      const sid = "sid-old-compact"
      const checkpoint = `${SB.render("compaction", { attrs: { kind: "remote" } })}\nold checkpoint`
      const rows = [
        {
          kind: "meta",
          formatVersion: 1,
          sid,
          createdAt: "t",
          model: "test-model",
          cwd: "/proj/alpha",
          systemHash: "s",
          toolsHash: "t",
          agentVersion: "0.0.0",
        },
        { kind: "user", ts: "t", content: "before compact" },
        {
          kind: "assistant",
          ts: "t",
          content: [{ type: "text", text: "a" }],
          stopReason: "end_turn",
        },
        {
          kind: "compact",
          ts: "t",
          reason: "manual",
          compactKind: "remote",
          messagesBefore: 2,
          messagesAfter: 1,
          replacementMessages: [{ role: "user", content: checkpoint }],
        },
        { kind: "user", ts: "t", content: "after compact" },
        {
          kind: "assistant",
          ts: "t",
          content: [{ type: "text", text: "b" }],
          stopReason: "end_turn",
        },
      ]
      writeFileSync(sessionFilePath(sid, dir), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`)
      const r = await createSessionsReadApi({ dir, sideband: SB }).records(sid)
      if (!r) throw new Error("expected records")
      const text = r.messages
        .map((m) =>
          typeof m.content === "string"
            ? m.content
            : m.content.map((b) => (b.type === "text" ? b.text : "")).join("\n"),
        )
        .join("\n")
      expect(text).toContain("old checkpoint")
      expect(text).toContain("after compact")
      expect(text).not.toContain("before compact")
    },
  )
})

describe("sessions:read meta title (C9 follow-up, SPEC §9.2)", () => {
  const titleDir = mkdtempSync(join(tmpdir(), "sessions-read-title-"))
  afterAll(() => rmSync(titleDir, { recursive: true, force: true }))
  const titled = createSessionsReadApi({ dir: titleDir })
  const line = (sid: string, source: string, title: string) =>
    `${JSON.stringify({ kind: "title", v: 1, sid, title, source, at: "2026-11-19T12:00:00.000Z" })}\n`

  it("no title line → no title keys", async () => {
    SessionStore.open({
      sid: "t-none",
      model: "m",
      cwd: "/p",
      systemHash: "s",
      toolsHash: "t",
      agentVersion: "0",
      dir: titleDir,
    })
    expect(titled.title("t-none")).toBeNull()
    expect(titled.title("no-such-session")).toBeNull()
    expect(titled.title("../unsafe")).toBeNull()
    const m = await titled.meta("t-none")
    expect(m).not.toBeNull()
    expect(m && "title" in m).toBe(false)
    expect(m && "titleSource" in m).toBe(false)
  })

  it("display order user > ai > derived; an empty user line is skipped", async () => {
    for (const sid of ["t-ai", "t-user", "t-clear"]) {
      SessionStore.open({
        sid,
        model: "m",
        cwd: "/p",
        systemHash: "s",
        toolsHash: "t",
        agentVersion: "0",
        dir: titleDir,
      })
    }
    const meta = join(titleDir, "index-meta.jsonl")
    writeFileSync(meta, line("t-ai", "derived", "Derived"), { flag: "a" })
    writeFileSync(meta, line("t-ai", "ai", "Model title"), { flag: "a" })
    writeFileSync(meta, line("t-user", "ai", "Model title"), { flag: "a" })
    writeFileSync(meta, line("t-user", "user", "Mine"), { flag: "a" })
    writeFileSync(meta, line("t-clear", "user", "Mine"), { flag: "a" })
    writeFileSync(meta, line("t-clear", "ai", "Model after clear"), { flag: "a" })
    expect(titled.title("t-clear")).toBe("Mine")
    writeFileSync(meta, line("t-clear", "user", ""), { flag: "a" })
    expect(titled.title("t-ai")).toBe("Model title")
    expect(titled.title("t-user")).toBe("Mine")
    expect(titled.title("t-clear")).toBe("Model after clear")
    expect(await titled.meta("t-ai")).toMatchObject({ title: "Model title", titleSource: "ai" })
    expect(await titled.meta("t-user")).toMatchObject({ title: "Mine", titleSource: "user" })
    expect(await titled.meta("t-clear")).toMatchObject({
      title: "Model after clear",
      titleSource: "ai",
    })
  })
})
