import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { SessionStore } from "../../../session/session-store.ts"

import {
  buildWindow,
  createSessionsReadApi,
  recordBodyText,
  summarizeRecord,
} from "./sessions-read.ts"

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
    expect(m.firstPrompt).toContain("prompt number 0")
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

  it("clips previews and reports fullChars", async () => {
    const w = await api.window("sid-aaa", { anchor: "start", limit: 10, previewChars: 80 })
    if (!w) throw new Error("expected window")
    const user = w.items.find((i) => i.kind === "user")
    if (!user) throw new Error("expected a user record")
    expect(user.fullChars).toBeGreaterThan(0)
    expect(user.preview.length).toBeLessThanOrEqual(80)
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
  it("searches one session with context snippets", async () => {
    const r = await api.search({ sid: "sid-aaa", query: "searchable-needle-sid-aaa" })
    expect(r.total).toBe(3)
    expect(r.scannedSessions).toBe(1)
    expect(r.hits[0].preview).toContain("searchable-needle-sid-aaa")
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

describe("sessions:read dump", () => {
  it("formats markdown and xml, null for unknown sid", async () => {
    const md = await api.dump("sid-aaa")
    expect(md).not.toBeNull()
    if (!md) return
    expect(md.text).toContain("# Session: sid-aaa")
    expect(md.bytes).toBeGreaterThan(0)

    const xml = await api.dump("sid-aaa", { format: "xml" })
    if (!xml) throw new Error("expected xml dump")
    expect(xml.text).toContain('<session id="sid-aaa"')

    expect(await api.dump("nope")).toBeNull()
  })
})

describe("pure helpers", () => {
  it("summarizeRecord names assistant tools", () => {
    const s = summarizeRecord({
      kind: "assistant",
      ts: "2026-01-01T00:00:00Z",
      content: [
        { type: "text", text: "hi" },
        { type: "tool_use", id: "t1", name: "Bash", input: {} },
      ],
      stopReason: "tool_use",
    })
    expect(s).toContain("1 tool_use (Bash)")
    expect(s).toContain("stop=tool_use")
  })

  it("recordBodyText flattens tool_result blocks", () => {
    const t = recordBodyText({
      kind: "tool_result",
      ts: "2026-01-01T00:00:00Z",
      tool_use_id: "t1",
      content: [{ type: "text", text: "inner text" }],
      isError: false,
    })
    expect(t).toBe("inner text")
  })

  it("recordBodyText strips every runtime attachment category from user content", () => {
    // Regression: blocksToText was passing runtime attachment blocks
    // through verbatim, leaking XML into SessionHistory previews and the
    // TUI scrollback.  session-replay.ts already filters these via
    // isRuntimeAttachmentBlock from the shared runtime-attachments.ts
    // module; blocksToText imports isRuntimeAttachmentText (same regex
    // list) and must match.
    //
    // Every attachment the agent prepends to a user message is tested
    // here.  When agent.ts gains a new attachment type and its opener
    // regex is added to runtime-attachments.ts, this test will fail if
    // blocksToText isn't aware of it — the shared module ensures the two
    // code paths stay in sync.
    const t = recordBodyText({
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
        {
          type: "text",
          text: '<ma::agent::reflection-checkpoint round="50" cooldown-applied-seconds="60" />',
        },
        { type: "text", text: '<ma::agent::emergency-cap-triggered round="200" />' },
        { type: "text", text: "<ma::agent::turn-aborted />\nThe previous turn was interrupted..." },
        {
          type: "text",
          text: "<ma::agent::output-truncated />\nThe response was truncated due to token limits...",
        },
        // --- <ma::plugin::*> ---
        { type: "text", text: '<ma::plugin::diagnostics count="3">...</ma::plugin::diagnostics>' },
        { type: "text", text: '<ma::plugins>\n  <skill name="finder">...</skill>\n</ma::plugins>' },
        // --- Legacy bare forms (migration window compat) ---
        { type: "text", text: '<mode-change from="default" to="ask" />' },
        { type: "text", text: '<ma::mode-active id="plan" since="..." />' },
        { type: "text", text: "<short-term-memory>\n[#1] old-form\n</short-term-memory>" },
        { type: "text", text: '<memory-saved scope="global" id="g">old form</memory-saved>' },
        { type: "text", text: '<ma::reflection-ack silence-for="2" reason="batch" />' },
        // --- Edge cases ---
        { type: "text", text: '  <ma::agent::tasks foo="bar">  ' }, // leading whitespace
        { type: "text", text: '<MA::AGENT::TASKS total="1">...</MA::AGENT::TASKS>' }, // case-insensitive
        { type: "text", text: "" }, // empty block — not an attachment
        { type: "text", text: "real user question here" }, // kept verbatim
        { type: "text", text: "  trimmed but not an attachment" }, // whitespace only, no tag
      ],
    })
    // No runtime attachment text should leak through.
    expect(t).not.toContain("<ma::agent::")
    expect(t).not.toContain("<ma::plugin::")
    expect(t).not.toContain("<ma::plugins>")
    expect(t).not.toContain("<mode-change")
    expect(t).not.toContain("<ma::mode-active")
    expect(t).not.toContain("<short-term-memory")
    expect(t).not.toContain("<memory-saved")
    expect(t).not.toContain("<ma::reflection-ack")
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
