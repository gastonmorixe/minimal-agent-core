import { describe, expect, it } from "bun:test"

import type {
  BlobsReadApi,
  HandlerContextSlice,
  RecordView,
  SessionsReadApi,
} from "../lib/host-types.ts"

import handler from "./session_history.ts"

// ---------------------------------------------------------------------------
// Fake host (in-memory, deterministic)
// ---------------------------------------------------------------------------

function rec(index: number, kind: string, preview: string): RecordView {
  return {
    index,
    kind,
    ts: `2026-06-09T00:00:${String(index).padStart(2, "0")}Z`,
    summary: `${kind} · fixture`,
    preview,
    clipped: false,
    fullChars: preview.length,
  }
}

const TOTAL = 25

function fakeSessions(overrides: Partial<SessionsReadApi> = {}): SessionsReadApi {
  return {
    async list(opts = {}) {
      const all = [
        { sid: "sid-new", createdAt: "2026-06-09T10:00:00Z", cwd: "/proj", model: "m1" },
        { sid: "sid-old", createdAt: "2026-06-08T10:00:00Z", cwd: "/other", model: "m2" },
      ]
      const filtered = opts.cwd ? all.filter((e) => e.cwd === opts.cwd) : all
      return { items: filtered.slice(0, opts.limit ?? 25), total: filtered.length }
    },
    async meta(sid) {
      if (sid === "missing") return null
      return {
        sid,
        createdAt: "2026-06-09T10:00:00Z",
        cwd: "/proj",
        model: "m1",
        agentVersion: "0.1.0",
        parentSid: null,
        recordCount: TOTAL,
        counts: { user: 8, assistant: 8, tool_result: 8, meta: 1 },
        firstPrompt: "build the thing",
        lastActivity: "2026-06-09T11:00:00Z",
        liveness: { status: "dead", source: "pid", reason: "pid-gone" },
        hasTasks: true,
        hasScratch: false,
        blobCount: 3,
      }
    },
    async window(sid, opts) {
      if (sid === "missing") return null
      const limit = opts.limit ?? 50
      const offset = opts.offset ?? 0
      let start: number
      let end: number
      if (opts.anchor === "end") {
        end = TOTAL - offset
        start = Math.max(0, end - limit)
      } else {
        start = offset
        end = Math.min(TOTAL, start + limit)
      }
      const items: RecordView[] = []
      for (let i = start; i < end; i++)
        items.push(rec(i, i % 2 === 0 ? "user" : "assistant", `body ${i}`))
      return {
        sid,
        items,
        total: TOTAL,
        firstIndex: items.length ? items[0].index : null,
        lastIndex: items.length ? items[items.length - 1].index : null,
      }
    },
    async toolCalls(sid) {
      if (sid === "missing") return null
      return {
        hits: [
          { index: 9, ts: null, tool: "Bash", toolUseId: "t9", inputPreview: `{"command":"ls"}` },
          { index: 3, ts: null, tool: "Bash", toolUseId: "t3", inputPreview: `{"command":"pwd"}` },
        ],
        total: 2,
      }
    },
    async search(opts) {
      return {
        hits: [
          {
            sid: opts.sid ?? "sid-new",
            index: 4,
            ts: null,
            kind: "user",
            preview: `…found ${opts.query}…`,
          },
        ],
        total: 1,
        scannedSessions: opts.sid ? 1 : 2,
      }
    },
    async dump(sid, opts = {}) {
      if (sid === "missing") return null
      const text = opts.format === "xml" ? `<session id="${sid}"/>` : `# Session: ${sid}`
      return { text, bytes: text.length }
    },
    ...overrides,
  }
}

const fakeBlobs: BlobsReadApi = {
  async list() {
    return { items: [{ toolUseId: "t9", bytes: 5000, mtime: "2026-06-09T10:30:00Z" }], total: 1 }
  },
  async read(_sid, toolUseId, opts = {}) {
    if (toolUseId !== "t9") return null
    const full = "R".repeat(5000)
    const max = opts.maxBytes ?? 64 * 1024
    const clipped = full.length > max
    return { text: clipped ? full.slice(0, max) : full, bytes: 5000, clipped, path: "/x/t9.raw" }
  },
}

function ctx(
  input: Record<string, unknown>,
  host?: { sessions?: SessionsReadApi; blobs?: BlobsReadApi },
): HandlerContextSlice {
  return {
    trigger: { type: "tool", name: "SessionHistory", input, tool_use_id: "tu1" },
    cwd: "/proj",
    host: host ?? { sessions: fakeSessions(), blobs: fakeBlobs },
  }
}

async function call(
  input: Record<string, unknown>,
  host?: { sessions?: SessionsReadApi; blobs?: BlobsReadApi },
) {
  return handler(ctx(input, host))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionHistory: defaults", () => {
  it("no input = window of the LATEST 10 records of the last session", async () => {
    const r = await call({})
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("records 15..24 of 25")
    expect(r.content).toContain("[#24]")
    expect(r.content).not.toContain("[#14]")
  })

  it("reports the next-older page cursor", async () => {
    const r = await call({})
    expect(r.content).toContain(`{anchor:"end", offset:10}`)
  })

  it("'last' resolves to the newest session for the cwd", async () => {
    const r = await call({ action: "meta" })
    expect(r.content).toContain("Session: sid-new")
  })
})

describe("SessionHistory: window paging", () => {
  it("anchor start walks forward with stable indexes", async () => {
    const r = await call({ action: "window", anchor: "start", offset: 5, limit: 3 })
    expect(r.content).toContain("[#5]")
    expect(r.content).toContain("[#7]")
    expect(r.content).toContain(`{anchor:"start", offset:8}`)
  })

  it("no next-page hint at the boundary", async () => {
    const r = await call({ action: "window", anchor: "start", offset: 20, limit: 10 })
    expect(r.content).not.toContain("call again")
  })

  it("unknown sid is a clean error", async () => {
    const r = await call({ action: "window", sid: "missing" })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("Unknown session id")
  })
})

describe("SessionHistory: short-sid prefix resolution", () => {
  it("a unique prefix resolves to the full sid", async () => {
    const r = await call({ action: "meta", sid: "sid-n" })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("Session: sid-new")
  })

  it("an ambiguous prefix errors listing the candidates", async () => {
    const r = await call({ action: "meta", sid: "sid-" })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("Ambiguous")
    expect(r.content).toContain("sid-new")
    expect(r.content).toContain("sid-old")
  })

  it("an exact sid that is also a prefix of another resolves to itself", async () => {
    const sessions = fakeSessions({
      async list(opts = {}) {
        const all = [
          { sid: "abc", createdAt: "2026-06-09T10:00:00Z", cwd: "/proj", model: "m1" },
          { sid: "abcdef", createdAt: "2026-06-08T10:00:00Z", cwd: "/proj", model: "m1" },
        ]
        const filtered = opts.cwd ? all.filter((e) => e.cwd === opts.cwd) : all
        return { items: filtered.slice(0, opts.limit ?? 25), total: filtered.length }
      },
    })
    const r = await call({ action: "meta", sid: "abc" }, { sessions, blobs: fakeBlobs })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("Session: abc")
    expect(r.content).not.toContain("Session: abcdef")
  })

  it("a non-matching sid passes through unchanged to the action lookup", async () => {
    // "missing" matches no index entry as a prefix → passed through verbatim →
    // the fake's meta() returns null for it → clean unknown-sid error.
    const r = await call({ action: "meta", sid: "missing" })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("Unknown session id")
  })
})

describe("SessionHistory: meta / list / search / tool_calls", () => {
  it("meta renders counts, liveness, sidecars", async () => {
    const r = await call({ action: "meta", sid: "sid-new" })
    expect(r.content).toContain("Records: 25")
    expect(r.content).toContain("dead (pid-gone)")
    expect(r.content).toContain("blobs=3")
    expect(r.content).toContain("First prompt: build the thing")
  })

  it("list renders sessions newest-first", async () => {
    const r = await call({ action: "list" })
    expect(r.content).toContain("sid-new")
    expect(r.content).toContain("sid-old")
  })

  it("search requires a query", async () => {
    const r = await call({ action: "search" })
    expect(r.is_error).toBe(true)
  })

  it("search renders hits with session + index anchors", async () => {
    const r = await call({ action: "search", query: "needle" })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("[#4]")
    expect(r.content).toContain("needle")
  })

  it("tool_calls filters and renders input previews", async () => {
    const r = await call({ action: "tool_calls", tool: "Bash" })
    expect(r.content).toContain("'Bash' calls")
    expect(r.content).toContain(`{"command":"ls"}`)
  })
})

describe("SessionHistory: blob + dump", () => {
  it("blob reads raw output and reports clipping", async () => {
    const r = await call({ action: "blob", toolUseId: "t9", maxBytes: 100 })
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("CLIPPED")
    expect(r.content).toContain("5000 bytes")
  })

  it("blob requires toolUseId", async () => {
    const r = await call({ action: "blob" })
    expect(r.is_error).toBe(true)
  })

  it("missing blob is a clean error mentioning eviction", async () => {
    const r = await call({ action: "blob", toolUseId: "gone" })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("LRU-evicted")
  })

  it("dump defaults to markdown", async () => {
    const r = await call({ action: "dump", sid: "sid-new" })
    expect(r.content).toContain("# Session: sid-new")
  })

  it("dump xml", async () => {
    const r = await call({ action: "dump", sid: "sid-new", format: "xml" })
    expect(r.content).toContain(`<session id="sid-new"/>`)
  })
})

describe("SessionHistory: degraded environments", () => {
  it("no host at all → capability error, not a crash", async () => {
    const r = await handler({
      trigger: { type: "tool", name: "SessionHistory", input: {}, tool_use_id: "t" },
      cwd: "/proj",
    })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("sessions:read")
  })

  it("blob action without blobs:read grant → capability error", async () => {
    const r = await call({ action: "blob", toolUseId: "t9" }, { sessions: fakeSessions() })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("blobs:read")
  })

  it("unknown action → helpful error listing valid actions", async () => {
    const r = await call({ action: "explode" })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("window")
    expect(r.content).toContain("dump")
  })

  it("no sessions anywhere → clean 'no saved sessions' error", async () => {
    const empty = fakeSessions({
      async list() {
        return { items: [], total: 0 }
      },
    })
    const r = await call({ action: "meta" }, { sessions: empty })
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("No saved sessions")
  })
})
