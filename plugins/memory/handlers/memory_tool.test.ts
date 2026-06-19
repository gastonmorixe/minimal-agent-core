/**
 * Tests for `MemoryTool`: the model-facing CRUD tool for saved memories.
 *
 * Each test gets a temp `$HOME` so we never touch the real
 * `~/.minimal-agent/`. The tool handler is exercised directly (not
 * through the `PluginLoader`); end-to-end loader integration is covered
 * in `memory.test.ts` already.
 *
 * Coverage:
 *   - Input validation: action / scope / per-action required fields,
 *     unused-field rejection, format enum.
 *   - list: empty store, populated store, query filter, limit slice.
 *   - read: hit / miss / by-legacy-id.
 *   - add: returns id, persists to disk, populates `display`.
 *   - edit: hit / miss, updates body, returns updated bullet.
 *   - remove: hit / miss, drops from disk.
 *   - clear: short-term success, persistent refusal.
 *   - format=json: structured content for every action.
 *   - Short-term refused without sid; tool returns is_error.
 *   - packageDir refusal.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { TUIContext } from "@minimal-agent/plugin-api/types/plugin"

import {
  globalMemoryPath,
  MemoryStore,
  projectMemoryPath,
  SHORT_TERM_CAP,
  shortTermMemoryPath,
} from "../lib/store.ts"

import memoryToolHandler, {
  DEFAULT_LIST_LIMIT,
  LIST_PREVIEW_MAX,
  MAX_LIST_LIMIT,
  paginateNewestFirst,
} from "./memory_tool.ts"

const PLUGIN_DIR = resolve(__dirname, "..")

let tmpHome: string
let savedHome: string | undefined

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "memory-tool-test-"))
  savedHome = process.env.HOME
  process.env.HOME = tmpHome
})

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(tmpHome, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolCtx(opts: {
  input: Record<string, unknown>
  cwd?: string
  env?: Record<string, string>
}): TUIContext {
  return {
    trigger: {
      type: "tool",
      name: "MemoryTool",
      input: opts.input,
      tool_use_id: "test-call",
    },
    packageDir: PLUGIN_DIR,
    cwd: opts.cwd ?? "/p",
    env: opts.env ?? {},
    abort: new AbortController().signal,
    stdout: process.stdout as NodeJS.WriteStream,
    stdin: process.stdin as NodeJS.ReadStream,
    stderr: process.stderr as NodeJS.WriteStream,
    log: (() => {
      const noop = () => {}
      return {
        emergency: noop,
        alert: noop,
        critical: noop,
        error: noop,
        warn: noop,
        notice: noop,
        info: noop,
        debug: noop,
      }
    })(),
  }
}

/** Strip ANSI for content comparisons. */
function stripAnsi(s: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip is intentional
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe("MemoryTool: input validation", () => {
  it("rejects missing action", async () => {
    const r = await memoryToolHandler(makeToolCtx({ input: { scope: "project" } }))
    expect(r.kind).toBe("tool_result")
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("`action` must be one of")
  })

  it("rejects unknown action", async () => {
    const r = await memoryToolHandler(
      makeToolCtx({ input: { action: "destroy", scope: "project" } }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
  })

  it("rejects missing scope", async () => {
    const r = await memoryToolHandler(makeToolCtx({ input: { action: "list" } }))
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("`scope` must be one of")
  })

  it("rejects unknown scope", async () => {
    const r = await memoryToolHandler(makeToolCtx({ input: { action: "list", scope: "user" } }))
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
  })

  it("rejects read without id", async () => {
    const r = await memoryToolHandler(makeToolCtx({ input: { action: "read", scope: "project" } }))
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("`id` is required")
  })

  it("rejects edit without id or body", async () => {
    const noId = await memoryToolHandler(
      makeToolCtx({ input: { action: "edit", scope: "project", body: "x" } }),
    )
    if (noId.kind !== "tool_result") return
    expect(noId.is_error).toBe(true)
    const noBody = await memoryToolHandler(
      makeToolCtx({ input: { action: "edit", scope: "project", id: "x" } }),
    )
    if (noBody.kind !== "tool_result") return
    expect(noBody.is_error).toBe(true)
  })

  it("rejects add without body", async () => {
    const r = await memoryToolHandler(makeToolCtx({ input: { action: "add", scope: "project" } }))
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("`body` is required")
  })

  it("rejects remove without id", async () => {
    const r = await memoryToolHandler(
      makeToolCtx({ input: { action: "remove", scope: "project" } }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
  })

  it("silently ignores extra id on list", async () => {
    // Models sometimes pass `id: ""` (or any unused value) because the JSON
    // Schema declares `id` as always-optional. The tool now ignores extras
    // rather than erroring, avoiding infinite retry loops.
    const r = await memoryToolHandler(
      makeToolCtx({ input: { action: "list", scope: "project", id: "stray" } }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("project (no entries)")
  })

  it("silently ignores extra body on remove", async () => {
    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "remove", scope: "project", id: "x", body: "stray" },
      }),
    )
    if (r.kind !== "tool_result") return
    // The id lookup fails first (no "x" exists), not the body check.
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('no bullet with id="x"')
  })

  it("rejects query/limit outside list", async () => {
    const r1 = await memoryToolHandler(
      makeToolCtx({
        input: { action: "read", scope: "project", id: "x", query: "y" },
      }),
    )
    if (r1.kind !== "tool_result") return
    expect(r1.is_error).toBe(true)

    const r2 = await memoryToolHandler(
      makeToolCtx({
        input: { action: "add", scope: "project", body: "x", limit: 5 },
      }),
    )
    if (r2.kind !== "tool_result") return
    expect(r2.is_error).toBe(true)
  })

  it("rejects bad limit (zero / negative / non-integer)", async () => {
    const cases = [0, -1, "5", 1.5]
    for (const lim of cases) {
      const r = await memoryToolHandler(
        makeToolCtx({ input: { action: "list", scope: "project", limit: lim } }),
      )
      if (r.kind !== "tool_result") continue
      expect(r.is_error).toBe(true)
    }
  })

  it("rejects unknown format", async () => {
    const r = await memoryToolHandler(
      makeToolCtx({ input: { action: "list", scope: "project", format: "xml" } }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("MemoryTool.list", () => {
  it("returns empty header when store is empty", async () => {
    const r = await memoryToolHandler(makeToolCtx({ input: { action: "list", scope: "project" } }))
    expect(r.kind).toBe("tool_result")
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBeFalsy()
    expect(stripAnsi(r.content)).toContain("project (no entries)")
  })

  it("renders all bullets sorted by file order", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    s.add("alpha")
    s.add("beta")
    s.add("gamma")

    const r = await memoryToolHandler(
      makeToolCtx({ input: { action: "list", scope: "project" }, cwd: "/p" }),
    )
    if (r.kind !== "tool_result") return
    const content = stripAnsi(r.content)
    expect(content).toContain("project (3 entries)")
    expect(content.indexOf("alpha")).toBeLessThan(content.indexOf("beta"))
    expect(content.indexOf("beta")).toBeLessThan(content.indexOf("gamma"))
  })

  it("filters by query (case-insensitive substring)", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    s.add("Active hypothesis: width 80")
    s.add("Active hypothesis: TLS handshake")
    s.add("noise about something else")

    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "list", scope: "project", query: "ACTIVE" },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    const content = stripAnsi(r.content)
    // shown===total → un-paginated form; "matching" suffix reflects the query.
    expect(content).toContain(`project (2 entries matching "ACTIVE")`)
    expect(content).toContain("width 80")
    expect(content).toContain("TLS handshake")
    expect(content).not.toContain("noise about")
  })

  it("limit slices the most recent N", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    for (let i = 1; i <= 5; i++) s.add(`entry ${i}`)

    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "list", scope: "project", limit: 2 },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    const content = stripAnsi(r.content)
    expect(content).toContain("showing 2 of 5 entries")
    expect(content).toContain("offset 0")
    expect(content).toContain("entry 4")
    expect(content).toContain("entry 5")
    expect(content).not.toContain("entry 1")
  })

  it("populates `display` with ANSI", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    s.add("hello")

    const r = await memoryToolHandler(
      makeToolCtx({ input: { action: "list", scope: "project" }, cwd: "/p" }),
    )
    if (r.kind !== "tool_result") return
    expect(r.display).toBeDefined()
    // ANSI escapes present in display, absent in content.
    expect(r.display).toContain("\x1b[")
    expect(r.content).not.toContain("\x1b[")
  })
})

// ---------------------------------------------------------------------------
// list: pagination + truncation contract
// ---------------------------------------------------------------------------

describe("MemoryTool.list: pagination", () => {
  it("default limit is DEFAULT_LIST_LIMIT (regression guard)", () => {
    // Pinning the constant rather than the magic number makes the test
    // fail loudly if someone bumps the default without updating PROMPT.md.
    expect(DEFAULT_LIST_LIMIT).toBe(20)
  })

  it("returns at most DEFAULT_LIST_LIMIT entries when limit is unset", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    for (let i = 1; i <= 25; i++) s.add(`entry ${i}`)

    const r = await memoryToolHandler(
      makeToolCtx({ input: { action: "list", scope: "project" }, cwd: "/p" }),
    )
    if (r.kind !== "tool_result") return
    const content = stripAnsi(r.content)
    expect(content).toContain(`showing ${DEFAULT_LIST_LIMIT} of 25 entries`)
    expect(content).toContain("offset 0")
    // First few oldest entries from the source are NOT in the most-recent page.
    expect(content).not.toContain("entry 1\n")
    expect(content).toContain("entry 25")
  })

  it("returns a next-page hint when there are more entries", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    for (let i = 1; i <= 25; i++) s.add(`entry ${i}`)

    const r = await memoryToolHandler(
      makeToolCtx({ input: { action: "list", scope: "project" }, cwd: "/p" }),
    )
    if (r.kind !== "tool_result") return
    expect(stripAnsi(r.content)).toContain(
      `next: MemoryTool({action: "list", scope: "project", offset: ${DEFAULT_LIST_LIMIT}, limit: ${DEFAULT_LIST_LIMIT}})`,
    )
  })

  it("offset walks BACKWARD in time (toward older entries)", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    for (let i = 1; i <= 25; i++) s.add(`entry ${i}`)

    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "list", scope: "project", limit: 5, offset: 5 },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    const content = stripAnsi(r.content)
    expect(content).toContain("showing 5 of 25 entries")
    expect(content).toContain("offset 5")
    // The page should be entries 16..20 (5 from end is 21..25 most recent;
    // offset=5 skips those, gives us 16..20).
    expect(content).toContain("entry 16")
    expect(content).toContain("entry 20")
    expect(content).not.toContain("entry 21")
    expect(content).not.toContain("entry 15")
  })

  it("last page omits the next-page hint", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    for (let i = 1; i <= 22; i++) s.add(`entry ${i}`)

    // offset=20, limit=20 leaves only entries 1..2: last page, no more.
    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "list", scope: "project", limit: 20, offset: 20 },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    const content = stripAnsi(r.content)
    expect(content).toContain("showing 2 of 22 entries")
    expect(content).not.toContain("next:")
  })

  it("offset >= total returns an empty page (no rows, no hint)", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    for (let i = 1; i <= 5; i++) s.add(`entry ${i}`)

    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "list", scope: "project", limit: 10, offset: 100 },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    const content = stripAnsi(r.content)
    expect(content).toContain("showing 0 of 5 entries")
    expect(content).toContain("offset 100")
    expect(content).not.toContain("next:")
  })

  it("clamps a runaway limit and notes the clamp in the result", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    for (let i = 1; i <= 5; i++) s.add(`entry ${i}`)

    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "list", scope: "project", limit: 5000 },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBeFalsy()
    const content = stripAnsi(r.content)
    expect(content).toContain(`limit clamped to ${MAX_LIST_LIMIT}`)
  })

  it("rejects negative offset", async () => {
    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "list", scope: "project", offset: -1 },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("`offset` must be a non-negative integer")
  })

  it("rejects offset outside list", async () => {
    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "read", scope: "project", id: "x", offset: 0 },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('`offset` is only valid for action="list"')
  })

  it("query + pagination compose: filter first, then page", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    for (let i = 1; i <= 30; i++) {
      s.add(i % 2 === 0 ? `even ${i}` : `odd ${i}`)
    }
    // 15 odds; first page of 5 should be odds 21, 23, 25, 27, 29.
    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "list", scope: "project", query: "odd", limit: 5 },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    const content = stripAnsi(r.content)
    expect(content).toContain('matching "odd"')
    expect(content).toContain("showing 5 of 15 entries")
    expect(content).toContain("odd 21")
    expect(content).toContain("odd 29")
    expect(content).not.toContain("even ")
  })

  it("clips body previews to LIST_PREVIEW_MAX characters", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    const longBody = "x".repeat(LIST_PREVIEW_MAX + 50)
    s.add(longBody)

    const r = await memoryToolHandler(
      makeToolCtx({ input: { action: "list", scope: "project" }, cwd: "/p" }),
    )
    if (r.kind !== "tool_result") return
    const content = stripAnsi(r.content)
    // Ellipsis indicates truncation.
    expect(content).toContain("…")
    // No row should contain a continuous run of x's longer than the cap.
    const xs = content.match(/x+/g) ?? []
    for (const run of xs) {
      expect(run.length).toBeLessThan(LIST_PREVIEW_MAX)
    }
  })

  it("read still returns the FULL body (truncation is only in list)", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    const longBody = "x".repeat(LIST_PREVIEW_MAX * 3)
    const { bullet } = s.add(longBody)

    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "read", scope: "project", id: bullet.id },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBeFalsy()
    // The full body must be present; read is the escape hatch.
    expect(stripAnsi(r.content)).toContain(longBody)
  })
})

// ---------------------------------------------------------------------------
// paginateNewestFirst: pure helper
// ---------------------------------------------------------------------------

describe("paginateNewestFirst", () => {
  it("returns last N items in source order (page 0)", () => {
    const items = [1, 2, 3, 4, 5]
    const { slice, nextOffset } = paginateNewestFirst(items, 0, 2)
    expect(slice).toEqual([4, 5])
    expect(nextOffset).toBe(2)
  })

  it("walks backward as offset grows", () => {
    const items = [1, 2, 3, 4, 5]
    const { slice, nextOffset } = paginateNewestFirst(items, 2, 2)
    expect(slice).toEqual([2, 3])
    expect(nextOffset).toBe(4)
  })

  it("returns the remainder on the last page", () => {
    const items = [1, 2, 3, 4, 5]
    const { slice, nextOffset } = paginateNewestFirst(items, 4, 2)
    expect(slice).toEqual([1])
    expect(nextOffset).toBe(null)
  })

  it("returns [] when offset >= total", () => {
    const items = [1, 2, 3]
    const { slice, nextOffset } = paginateNewestFirst(items, 10, 5)
    expect(slice).toEqual([])
    expect(nextOffset).toBe(null)
  })

  it("returns [] for an empty source", () => {
    const { slice, nextOffset } = paginateNewestFirst<number>([], 0, 5)
    expect(slice).toEqual([])
    expect(nextOffset).toBe(null)
  })

  it("clamps non-finite or sub-one limit/offset values", () => {
    // The handler validates these at the boundary, but the pure helper
    // should be defensive enough that direct callers (CLI, tests) don't
    // segfault on bad inputs.
    const items = [1, 2, 3, 4, 5]
    const a = paginateNewestFirst(items, -5, -1)
    expect(a.slice).toEqual([5]) // limit floored to 1, offset floored to 0
    expect(a.nextOffset).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

describe("MemoryTool.read", () => {
  it("returns the bullet by stamped id", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    const { bullet } = s.add("readable thing")

    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "read", scope: "project", id: bullet.id },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBeFalsy()
    expect(stripAnsi(r.content)).toContain("readable thing")
    expect(stripAnsi(r.content)).toContain(`#${bullet.id}`)
  })

  it("returns is_error when id is unknown", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    s.add("hello")

    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "read", scope: "project", id: "nope-0000" },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('no bullet with id="nope-0000"')
  })

  it("can read a legacy bullet by synthetic id", async () => {
    const path = projectMemoryPath("/legacy", { home: tmpHome })
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "- legacy line\n")
    const s = MemoryStore.project("/legacy", { home: tmpHome })
    const lid = s.list()[0]?.id
    expect(lid).toMatch(/^legacy:/)

    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "read", scope: "project", id: lid! },
        cwd: "/legacy",
      }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBeFalsy()
    expect(stripAnsi(r.content)).toContain("legacy line")
  })
})

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe("MemoryTool.add", () => {
  it("appends a bullet and returns the new id", async () => {
    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "add", scope: "project", body: "added via tool" },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBeFalsy()
    expect(stripAnsi(r.content)).toContain("saved [project#")

    // Verify it's persisted.
    const s = MemoryStore.project("/p", { home: tmpHome })
    const all = s.list()
    expect(all.length).toBe(1)
    expect(all[0]?.body).toBe("added via tool")
  })

  it("works for short-term scope when sid is provided", async () => {
    const sid = "11111111-2222-3333-4444-555555555555"
    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "add", scope: "short-term", body: "scratch" },
        env: { MINIMAL_AGENT_SESSION_ID: sid },
      }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBeFalsy()
    expect(stripAnsi(r.content)).toContain("saved [short-term#1]")

    // Verify persisted.
    expect(existsSync(shortTermMemoryPath(sid, { home: tmpHome }))).toBe(true)
  })

  it("refuses short-term add when no sid is plumbed through", async () => {
    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "add", scope: "short-term", body: "scratch" },
        // no env
      }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("session id")
  })

  it("includes evicted count when short-term overflows", async () => {
    const sid = "sid-evict"
    const env = { MINIMAL_AGENT_SESSION_ID: sid }
    // Fill to cap
    for (let i = 1; i <= SHORT_TERM_CAP; i++) {
      await memoryToolHandler(
        makeToolCtx({
          input: { action: "add", scope: "short-term", body: `e${i}` },
          env,
        }),
      )
    }
    // Overflow
    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "add", scope: "short-term", body: "overflow" },
        env,
      }),
    )
    if (r.kind !== "tool_result") return
    expect(stripAnsi(r.content)).toContain("(evicted 1 oldest)")
  })
})

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

describe("MemoryTool.edit", () => {
  it("replaces the body for a known id", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    const { bullet } = s.add("original")

    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "edit", scope: "project", id: bullet.id, body: "revised" },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBeFalsy()
    expect(stripAnsi(r.content)).toContain(`edited [project#${bullet.id}]`)
    expect(stripAnsi(r.content)).toContain("revised")

    // Verified on disk.
    expect(s.read(bullet.id)?.body).toBe("revised")
  })

  it("returns is_error on unknown id", async () => {
    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "edit", scope: "project", id: "nope", body: "x" },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("MemoryTool.remove", () => {
  it("drops the bullet by id", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    const a = s.add("keep").bullet
    const b = s.add("drop me").bullet

    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "remove", scope: "project", id: b.id },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBeFalsy()
    expect(stripAnsi(r.content)).toContain(`removed [project#${b.id}]`)
    expect(stripAnsi(r.content)).toContain("drop me")

    // Verified on disk.
    expect(s.list().map((x) => x.id)).toEqual([a.id])
  })

  it("returns is_error on unknown id", async () => {
    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "remove", scope: "project", id: "nope" },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe("MemoryTool.clear", () => {
  it("wipes a short-term store", async () => {
    const sid = "sid-clear"
    const env = { MINIMAL_AGENT_SESSION_ID: sid }
    for (let i = 1; i <= 3; i++) {
      await memoryToolHandler(
        makeToolCtx({
          input: { action: "add", scope: "short-term", body: `e${i}` },
          env,
        }),
      )
    }

    const r = await memoryToolHandler(
      makeToolCtx({ input: { action: "clear", scope: "short-term" }, env }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBeFalsy()
    expect(stripAnsi(r.content)).toContain("cleared 3 short-term entries")

    expect(MemoryStore.shortTerm(sid, { home: tmpHome }).list()).toEqual([])
  })

  it("refuses to clear a project store (footgun guard)", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    s.add("important note")

    const r = await memoryToolHandler(
      makeToolCtx({ input: { action: "clear", scope: "project" }, cwd: "/p" }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
    expect(r.content).toContain('only allowed for scope="short-term"')

    // Project store is intact.
    expect(MemoryStore.project("/p", { home: tmpHome }).list().length).toBe(1)
  })

  it("refuses to clear a global store", async () => {
    const r = await memoryToolHandler(makeToolCtx({ input: { action: "clear", scope: "global" } }))
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// format=json
// ---------------------------------------------------------------------------

describe("MemoryTool: format='json'", () => {
  it("list returns parseable JSON", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    s.add("alpha")
    s.add("beta")

    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "list", scope: "project", format: "json" },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    const parsed = JSON.parse(r.content)
    expect(parsed.scope).toBe("project")
    expect(parsed.total).toBe(2)
    expect(parsed.shown).toBe(2)
    expect(parsed.bullets.length).toBe(2)
    expect(parsed.bullets[0].body).toBe("alpha")
    expect(parsed.bullets[0].id).toMatch(/^[0-9a-z]+-[0-9a-f]{4}$/)
    // display is still ANSI text.
    expect(r.display).toContain("\x1b[")
  })

  it("read returns parseable JSON", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    const { bullet } = s.add("readable")

    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "read", scope: "project", id: bullet.id, format: "json" },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    const parsed = JSON.parse(r.content)
    expect(parsed.bullet.id).toBe(bullet.id)
    expect(parsed.bullet.body).toBe("readable")
  })

  it("add returns parseable JSON with id", async () => {
    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "add", scope: "project", body: "x", format: "json" },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    const parsed = JSON.parse(r.content)
    expect(parsed.scope).toBe("project")
    expect(parsed.id).toMatch(/^[0-9a-z]+-[0-9a-f]{4}$/)
    expect(parsed.evicted).toBe(0)
  })

  it("edit returns parseable JSON with updated bullet", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    const { bullet } = s.add("orig")

    const r = await memoryToolHandler(
      makeToolCtx({
        input: {
          action: "edit",
          scope: "project",
          id: bullet.id,
          body: "new",
          format: "json",
        },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    const parsed = JSON.parse(r.content)
    expect(parsed.bullet.body).toBe("new")
  })

  it("remove returns parseable JSON with the dropped bullet", async () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    const { bullet } = s.add("doomed")

    const r = await memoryToolHandler(
      makeToolCtx({
        input: {
          action: "remove",
          scope: "project",
          id: bullet.id,
          format: "json",
        },
        cwd: "/p",
      }),
    )
    if (r.kind !== "tool_result") return
    const parsed = JSON.parse(r.content)
    expect(parsed.removed.body).toBe("doomed")
  })

  it("clear returns parseable JSON with cleared count", async () => {
    const sid = "sid-json-clear"
    const env = { MINIMAL_AGENT_SESSION_ID: sid }
    await memoryToolHandler(
      makeToolCtx({ input: { action: "add", scope: "short-term", body: "x" }, env }),
    )
    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "clear", scope: "short-term", format: "json" },
        env,
      }),
    )
    if (r.kind !== "tool_result") return
    const parsed = JSON.parse(r.content)
    expect(parsed.cleared).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Defensive paths
// ---------------------------------------------------------------------------

describe("MemoryTool: defensive paths", () => {
  it("non-tool trigger returns is_error", async () => {
    const ctx: TUIContext = {
      ...makeToolCtx({ input: { action: "list", scope: "project" } }),
      trigger: {
        type: "inline_tag",
        name: "memory",
        attrs: {},
        body: "",
        self_closing: false,
      },
    }
    const r = await memoryToolHandler(ctx)
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
  })

  it("refuses to write under packageDir (defensive)", async () => {
    process.env.HOME = PLUGIN_DIR
    const r = await memoryToolHandler(
      makeToolCtx({
        input: { action: "add", scope: "global", body: "would-mutate-shipped-tree" },
      }),
    )
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
    expect(r.content).toContain("packageDir")
    process.env.HOME = tmpHome

    // Confirm nothing got written under PLUGIN_DIR.
    expect(existsSync(globalMemoryPath({ home: PLUGIN_DIR }))).toBe(false)
  })
})
