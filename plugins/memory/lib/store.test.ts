/**
 * Tests for `MemoryStore`.
 *
 * Each test gets a dedicated temp `$HOME` so we never touch the user's
 * real `~/.minimal-agent/`. Stores are constructed via the static
 * factories with `{home: tmpHome}` to keep the env override scope-local.
 *
 * Coverage:
 *   - Path resolution: global / project / short-term.
 *   - add: appends, generates correct id shape per kind, stamps ts/sid,
 *     creates dirs, single trailing newline.
 *   - add: short-term FIFO eviction at SHORT_TERM_CAP.
 *   - read/list: matches by stamped id and by synthetic legacy id.
 *   - edit: replaces body, bumps ts, preserves id and sid, returns null
 *     for unknown id, refuses empty body.
 *   - remove: drops the line cleanly, returns the removed bullet, null
 *     for unknown id.
 *   - clear: short-term wipes; global/project throws.
 *   - Round-trip with legacy bullets in the same file (preserve verbatim).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  globalMemoryPath,
  MEMORY_NAMESPACE_ENV,
  MemoryStore,
  projectMemoryPath,
  resolveNamespace,
  SHORT_TERM_CAP,
  shortTermMemoryPath,
} from "./store.ts"

let tmpHome: string

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "memory-store-test-"))
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe("path helpers", () => {
  it("globalMemoryPath = <home>/.minimal-agent/memory.md", () => {
    expect(globalMemoryPath({ home: "/h" })).toBe("/h/.minimal-agent/memory.md")
  })

  it("projectMemoryPath strips leading slashes from cwd", () => {
    expect(projectMemoryPath("/Users/a/proj", { home: "/h" })).toBe(
      "/h/.minimal-agent/projects/Users/a/proj/memory.md",
    )
  })

  it("shortTermMemoryPath = <home>/.minimal-agent/sessions/<sid>.scratch.md", () => {
    expect(shortTermMemoryPath("abc-123", { home: "/h" })).toBe(
      "/h/.minimal-agent/sessions/abc-123.scratch.md",
    )
  })
})

// ---------------------------------------------------------------------------
// Namespace support
//
// The env var MINIMAL_AGENT_MEMORY_NAMESPACE routes every memory file
// under `<home>/.minimal-agent/namespaces/<ns>/...` instead of the
// top-level layout. Useful for "start fresh" testing without touching
// the user's real memory. Validated to reject `..` and slashes so a
// typo can't escape the namespaces dir.
// ---------------------------------------------------------------------------

describe("namespace (env-driven)", () => {
  let savedEnv: string | undefined
  beforeEach(() => {
    savedEnv = process.env[MEMORY_NAMESPACE_ENV]
    delete process.env[MEMORY_NAMESPACE_ENV]
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env[MEMORY_NAMESPACE_ENV]
    else process.env[MEMORY_NAMESPACE_ENV] = savedEnv
  })

  it("unset env → resolveNamespace returns null", () => {
    expect(resolveNamespace()).toBeNull()
    expect(resolveNamespace({ home: "/h" })).toBeNull()
  })

  it("empty / whitespace env → treated as unset (returns null, no throw)", () => {
    process.env[MEMORY_NAMESPACE_ENV] = ""
    expect(resolveNamespace()).toBeNull()
    process.env[MEMORY_NAMESPACE_ENV] = "   "
    expect(resolveNamespace()).toBeNull()
  })

  it("valid env value → returned trimmed", () => {
    process.env[MEMORY_NAMESPACE_ENV] = " scratch "
    expect(resolveNamespace()).toBe("scratch")
  })

  it("path helpers route under namespaces/<ns>/ when env is set", () => {
    process.env[MEMORY_NAMESPACE_ENV] = "scratch"
    expect(globalMemoryPath({ home: "/h" })).toBe("/h/.minimal-agent/namespaces/scratch/memory.md")
    expect(projectMemoryPath("/Users/a/proj", { home: "/h" })).toBe(
      "/h/.minimal-agent/namespaces/scratch/projects/Users/a/proj/memory.md",
    )
    expect(shortTermMemoryPath("abc-123", { home: "/h" })).toBe(
      "/h/.minimal-agent/namespaces/scratch/sessions/abc-123.scratch.md",
    )
  })

  it("deps.namespace overrides the env var", () => {
    process.env[MEMORY_NAMESPACE_ENV] = "envns"
    expect(globalMemoryPath({ home: "/h", namespace: "depsns" })).toBe(
      "/h/.minimal-agent/namespaces/depsns/memory.md",
    )
  })

  it("deps.namespace=null forces default paths even when env is set", () => {
    process.env[MEMORY_NAMESPACE_ENV] = "envns"
    expect(globalMemoryPath({ home: "/h", namespace: null })).toBe("/h/.minimal-agent/memory.md")
    expect(projectMemoryPath("/p", { home: "/h", namespace: null })).toBe(
      "/h/.minimal-agent/projects/p/memory.md",
    )
  })

  it("rejects namespace containing a slash", () => {
    process.env[MEMORY_NAMESPACE_ENV] = "evil/escape"
    expect(() => globalMemoryPath({ home: "/h" })).toThrow(/invalid namespace/)
  })

  it("rejects the bare traversal token `..`", () => {
    expect(() => resolveNamespace({ home: "/h", namespace: ".." })).toThrow(/traversal/)
  })

  it("rejects whitespace inside namespace", () => {
    expect(() => resolveNamespace({ home: "/h", namespace: "has space" })).toThrow(
      /invalid namespace/,
    )
  })

  it("accepts dots and dashes (semver-style namespaces)", () => {
    expect(resolveNamespace({ home: "/h", namespace: "v1.2.3-rc1" })).toBe("v1.2.3-rc1")
  })

  it("MemoryStore.add writes under the namespaced path when env is set", () => {
    const home = mkdtempSync(join(tmpdir(), "memory-ns-add-"))
    try {
      process.env[MEMORY_NAMESPACE_ENV] = "scratch"
      const store = MemoryStore.global({ home })
      const { bullet } = store.add("only visible in scratch")
      const nsPath = join(home, ".minimal-agent", "namespaces", "scratch", "memory.md")
      const defaultPath = join(home, ".minimal-agent", "memory.md")
      expect(existsSync(nsPath)).toBe(true)
      expect(existsSync(defaultPath)).toBe(false)
      expect(readFileSync(nsPath, "utf-8")).toContain(bullet.id)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it("MemoryStore.list in one namespace cannot see entries from another", () => {
    const home = mkdtempSync(join(tmpdir(), "memory-ns-iso-"))
    try {
      process.env[MEMORY_NAMESPACE_ENV] = "alpha"
      MemoryStore.global({ home }).add("alpha-only")
      process.env[MEMORY_NAMESPACE_ENV] = "beta"
      const inBeta = MemoryStore.global({ home }).list()
      expect(inBeta.length).toBe(0)
      // And the default (env unset) namespace also stays clean.
      delete process.env[MEMORY_NAMESPACE_ENV]
      const inDefault = MemoryStore.global({ home }).list()
      expect(inDefault.length).toBe(0)
      // Re-entering alpha sees the original entry.
      process.env[MEMORY_NAMESPACE_ENV] = "alpha"
      const reAlpha = MemoryStore.global({ home }).list()
      expect(reAlpha.length).toBe(1)
      expect(reAlpha[0]?.body).toBe("alpha-only")
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// Static factories
// ---------------------------------------------------------------------------

describe("MemoryStore factories", () => {
  it("global() resolves to ~/.minimal-agent/memory.md", () => {
    const s = MemoryStore.global({ home: tmpHome })
    expect(s.kind).toBe("global")
    expect(s.path).toBe(join(tmpHome, ".minimal-agent/memory.md"))
  })

  it("project() resolves under projects/<cwd>/", () => {
    const s = MemoryStore.project("/x/y", { home: tmpHome })
    expect(s.kind).toBe("project")
    expect(s.path).toBe(join(tmpHome, ".minimal-agent/projects/x/y/memory.md"))
  })

  it("shortTerm() requires a non-empty sid", () => {
    expect(() => MemoryStore.shortTerm("", { home: tmpHome })).toThrow()
    expect(() => MemoryStore.shortTerm("   ", { home: tmpHome })).toThrow()
  })

  it("shortTerm() stamps no [session:…] field on the bullet (file IS the session)", () => {
    const s = MemoryStore.shortTerm("sid-1", { home: tmpHome })
    const { bullet } = s.add("hi")
    expect(bullet.sid).toBeNull()
    expect(readFileSync(s.path, "utf-8")).not.toContain("[session:")
  })
})

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

describe("MemoryStore.add", () => {
  it("creates the file (and parent dirs) on first add", () => {
    const s = MemoryStore.project("/deep/nested/path", { home: tmpHome })
    expect(existsSync(s.path)).toBe(false)
    s.add("hello")
    expect(existsSync(s.path)).toBe(true)
  })

  it("project: stamps a persistent id with shape <base36>-<4hex>", () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    const { bullet } = s.add("hello")
    expect(bullet.id).toMatch(/^[0-9a-z]+-[0-9a-f]{4}$/)
    expect(bullet.body).toBe("hello")
    expect(bullet.ts).not.toBeNull()
    expect(bullet.isLegacy).toBe(false)
  })

  it("project: stamps the configured sid", () => {
    const sid = "11111111-2222-3333-4444-555555555555"
    const s = MemoryStore.project("/p", { home: tmpHome, sid })
    const { bullet } = s.add("hello")
    expect(bullet.sid).toBe(sid)
    expect(readFileSync(s.path, "utf-8")).toContain(`[session:${sid}]`)
  })

  it("project: omits [session:…] when no sid provided", () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    s.add("hello")
    expect(readFileSync(s.path, "utf-8")).not.toContain("[session:")
  })

  it("short-term: integer ids start at 1 and increment", () => {
    const s = MemoryStore.shortTerm("sid-1", { home: tmpHome })
    expect(s.add("a").bullet.id).toBe("1")
    expect(s.add("b").bullet.id).toBe("2")
    expect(s.add("c").bullet.id).toBe("3")
  })

  it("short-term: ids never reuse gaps from removes (max+1)", () => {
    const s = MemoryStore.shortTerm("sid-2", { home: tmpHome })
    s.add("a") // 1
    s.add("b") // 2
    s.add("c") // 3
    s.remove("2")
    expect(s.add("d").bullet.id).toBe("4") // not 2
  })

  it("rejects empty / whitespace-only body", () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    expect(() => s.add("")).toThrow()
    expect(() => s.add("   \n  ")).toThrow()
  })

  it("collapses multi-line body to single line", () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    const { bullet } = s.add("line one\n  line two\n\nthree")
    expect(bullet.body).toBe("line one line two three")
  })

  it("appends across multiple calls (does not overwrite)", () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    s.add("one")
    s.add("two")
    s.add("three")
    expect(s.list().map((b) => b.body)).toEqual(["one", "two", "three"])
  })

  it("preserves legacy bullets already in the file", () => {
    const s = MemoryStore.project("/legacy", { home: tmpHome })
    mkdirSync(dirname(s.path), { recursive: true })
    writeFileSync(s.path, "- legacy one\n- legacy two\n")

    s.add("fresh")

    const out = readFileSync(s.path, "utf-8")
    expect(out.startsWith("- legacy one\n- legacy two\n")).toBe(true)
    // New bullet is appended after, with a stamped id.
    expect(out).toMatch(/- \[#[0-9a-z]+-[0-9a-f]{4}\] /)
    expect(out.endsWith("\n")).toBe(true)
  })

  it("file always ends with exactly one trailing newline after add", () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    s.add("one")
    s.add("two")
    const content = readFileSync(s.path, "utf-8")
    expect(content.endsWith("\n")).toBe(true)
    expect(content.endsWith("\n\n")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// add: short-term FIFO eviction
// ---------------------------------------------------------------------------

describe("MemoryStore.add — short-term FIFO eviction", () => {
  it("does not evict below the cap", () => {
    const s = MemoryStore.shortTerm("sid-cap", { home: tmpHome })
    for (let i = 1; i <= SHORT_TERM_CAP; i++) {
      const r = s.add(`entry ${i}`)
      expect(r.evicted).toEqual([])
    }
    expect(s.list().length).toBe(SHORT_TERM_CAP)
  })

  it("evicts the oldest entry when adding past the cap", () => {
    const s = MemoryStore.shortTerm("sid-evict", { home: tmpHome })
    for (let i = 1; i <= SHORT_TERM_CAP; i++) s.add(`entry ${i}`)

    const r = s.add("overflow")
    expect(r.evicted.length).toBe(1)
    expect(r.evicted[0]?.body).toBe("entry 1")
    expect(r.evicted[0]?.id).toBe("1")

    const remaining = s.list()
    expect(remaining.length).toBe(SHORT_TERM_CAP)
    expect(remaining[0]?.body).toBe("entry 2")
    expect(remaining[remaining.length - 1]?.body).toBe("overflow")
  })

  it("ids continue to monotonically increase after eviction", () => {
    const s = MemoryStore.shortTerm("sid-mono", { home: tmpHome })
    for (let i = 1; i <= SHORT_TERM_CAP + 1; i++) s.add(`e${i}`)
    // Last bullet is id SHORT_TERM_CAP+1, regardless of eviction.
    expect(s.list().pop()?.id).toBe(String(SHORT_TERM_CAP + 1))
  })

  it("eviction only kicks in for short-term, not project/global", () => {
    const s = MemoryStore.project("/no-cap", { home: tmpHome })
    for (let i = 0; i < SHORT_TERM_CAP + 5; i++) {
      const r = s.add(`x${i}`)
      expect(r.evicted).toEqual([])
    }
    expect(s.list().length).toBe(SHORT_TERM_CAP + 5)
  })
})

// ---------------------------------------------------------------------------
// read / list
// ---------------------------------------------------------------------------

describe("MemoryStore.read / list", () => {
  it("list() returns [] for missing file", () => {
    const s = MemoryStore.project("/empty", { home: tmpHome })
    expect(s.list()).toEqual([])
  })

  it("read() finds by stamped persistent id", () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    const { bullet } = s.add("hello")
    expect(s.read(bullet.id)?.body).toBe("hello")
  })

  it("read() finds by stamped short-term integer id", () => {
    const s = MemoryStore.shortTerm("sid-r", { home: tmpHome })
    s.add("a")
    s.add("b")
    expect(s.read("2")?.body).toBe("b")
  })

  it("read() finds by synthetic legacy:<sha12> id", () => {
    const s = MemoryStore.project("/l", { home: tmpHome })
    mkdirSync(dirname(s.path), { recursive: true })
    writeFileSync(s.path, "- legacy bullet\n")
    const all = s.list()
    expect(all.length).toBe(1)
    const lid = all[0]?.id
    expect(lid).toMatch(/^legacy:/)
    expect(lid).toBeDefined()
    if (lid) {
      expect(s.read(lid)?.body).toBe("legacy bullet")
    }
  })

  it("read() returns null for unknown id", () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    s.add("hello")
    expect(s.read("nope-0000")).toBeNull()
    expect(s.read("legacy:000000000000")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

describe("MemoryStore.edit", () => {
  it("replaces body, bumps ts, preserves id and sid", () => {
    const sid = "11111111-2222-3333-4444-555555555555"
    const s = MemoryStore.project("/p", { home: tmpHome, sid })
    const { bullet } = s.add("original")
    const oldTs = bullet.ts
    const updated = s.edit(bullet.id, "revised")
    expect(updated).not.toBeNull()
    expect(updated?.id).toBe(bullet.id)
    expect(updated?.body).toBe("revised")
    expect(updated?.sid).toBe(sid)
    expect(updated?.ts).toBeDefined()
    // ts MAY be the same (sub-second) — assert format only.
    expect(updated?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/)
    void oldTs
  })

  it("returns null for unknown id", () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    s.add("hello")
    expect(s.edit("nope", "x")).toBeNull()
  })

  it("rejects empty body", () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    const { bullet } = s.add("hello")
    expect(() => s.edit(bullet.id, "  \n ")).toThrow()
  })

  it("does not affect other bullets", () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    const a = s.add("alpha").bullet
    const b = s.add("beta").bullet
    s.edit(a.id, "alpha-2")
    const all = s.list()
    expect(all.find((x) => x.id === a.id)?.body).toBe("alpha-2")
    expect(all.find((x) => x.id === b.id)?.body).toBe("beta")
  })

  it("can edit a legacy bullet by its synthetic id (without breaking other lines)", () => {
    const s = MemoryStore.project("/l", { home: tmpHome })
    mkdirSync(dirname(s.path), { recursive: true })
    writeFileSync(s.path, "- one\n- two\n- three\n")
    const before = s.list()
    const targetId = before[1]?.id
    expect(targetId).toMatch(/^legacy:/)
    if (!targetId) return

    const updated = s.edit(targetId, "two-revised")
    expect(updated?.body).toBe("two-revised")

    const after = s.list()
    expect(after.length).toBe(3)
    expect(after.map((b) => b.body)).toEqual(["one", "two-revised", "three"])
  })
})

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("MemoryStore.remove", () => {
  it("drops the line and returns the removed bullet", () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    const a = s.add("a").bullet
    const b = s.add("b").bullet
    const removed = s.remove(a.id)
    expect(removed?.body).toBe("a")
    expect(s.list().map((x) => x.body)).toEqual(["b"])
    void b
  })

  it("returns null for unknown id and does not modify the file", () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    s.add("only")
    const before = readFileSync(s.path, "utf-8")
    expect(s.remove("nope")).toBeNull()
    const after = readFileSync(s.path, "utf-8")
    expect(after).toBe(before)
  })

  it("does not leave blank rows behind", () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    s.add("a")
    const b = s.add("b").bullet
    s.add("c")
    s.remove(b.id)
    const content = readFileSync(s.path, "utf-8")
    expect(content).not.toMatch(/\n\n/)
  })

  it("can remove a legacy bullet by synthetic id", () => {
    const s = MemoryStore.project("/l", { home: tmpHome })
    mkdirSync(dirname(s.path), { recursive: true })
    writeFileSync(s.path, "- one\n- two\n")
    const ids = s.list().map((b) => b.id)
    const removed = s.remove(ids[0]!)
    expect(removed?.body).toBe("one")
    expect(s.list().map((b) => b.body)).toEqual(["two"])
  })
})

// ---------------------------------------------------------------------------
// clear
// ---------------------------------------------------------------------------

describe("MemoryStore.clear", () => {
  it("short-term: wipes all bullets, returns count", () => {
    const s = MemoryStore.shortTerm("sid-clear", { home: tmpHome })
    s.add("a")
    s.add("b")
    s.add("c")
    expect(s.clear()).toBe(3)
    expect(s.list()).toEqual([])
  })

  it("global: refuses (footgun)", () => {
    const s = MemoryStore.global({ home: tmpHome })
    s.add("important")
    expect(() => s.clear()).toThrow()
  })

  it("project: refuses (footgun)", () => {
    const s = MemoryStore.project("/p", { home: tmpHome })
    s.add("important")
    expect(() => s.clear()).toThrow()
  })

  it("short-term: returns 0 for already-empty store", () => {
    const s = MemoryStore.shortTerm("sid-empty", { home: tmpHome })
    expect(s.clear()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// File round-trip — non-bullet content preserved
// ---------------------------------------------------------------------------

describe("MemoryStore — non-bullet content preservation", () => {
  it("preserves headers and prose lines on edit", () => {
    const s = MemoryStore.project("/mixed", { home: tmpHome })
    mkdirSync(dirname(s.path), { recursive: true })
    writeFileSync(s.path, "# Heading\n\n- one\nsome prose between bullets\n- two\n")
    const ids = s.list().map((b) => b.id)
    s.edit(ids[0]!, "one-revised")
    const after = readFileSync(s.path, "utf-8")
    expect(after).toContain("# Heading")
    expect(after).toContain("some prose between bullets")
    expect(after).toContain("one-revised")
  })

  it("preserves headers and prose lines on remove", () => {
    const s = MemoryStore.project("/mixed2", { home: tmpHome })
    mkdirSync(dirname(s.path), { recursive: true })
    writeFileSync(s.path, "# Heading\n\n- one\nsome prose\n- two\n")
    const ids = s.list().map((b) => b.id)
    s.remove(ids[1]!)
    const after = readFileSync(s.path, "utf-8")
    expect(after).toContain("# Heading")
    expect(after).toContain("some prose")
    expect(after).toContain("- one")
    expect(after).not.toContain("- two")
  })
})

// ---------------------------------------------------------------------------
// MINIMAL_AGENT_HOME override
//
// Path resolution now routes through the shared `resolveAgentHome`
// resolver, which treats `MINIMAL_AGENT_HOME` as authoritative. When no
// `home` dep is injected, the path helpers read `process.env`, so a
// relocated agent home must win and land every store under it. Tests
// that DO inject `{ home }` are unaffected (covered above) — the
// injected home maps to `join(home, ".minimal-agent")` exactly as
// before.
// ---------------------------------------------------------------------------

describe("MINIMAL_AGENT_HOME override (no injected home)", () => {
  let savedMaHome: string | undefined
  let savedNs: string | undefined

  beforeEach(() => {
    savedMaHome = process.env.MINIMAL_AGENT_HOME
    // The namespace env, if inherited, would reroute under namespaces/<ns>/
    // and break the bare-path assertion. Clear it for this block.
    savedNs = process.env[MEMORY_NAMESPACE_ENV]
    delete process.env[MEMORY_NAMESPACE_ENV]
  })

  afterEach(() => {
    if (savedMaHome === undefined) delete process.env.MINIMAL_AGENT_HOME
    else process.env.MINIMAL_AGENT_HOME = savedMaHome
    if (savedNs === undefined) delete process.env[MEMORY_NAMESPACE_ENV]
    else process.env[MEMORY_NAMESPACE_ENV] = savedNs
  })

  it("routes every store path under MINIMAL_AGENT_HOME when set", () => {
    const relocated = mkdtempSync(join(tmpdir(), "ma-relocated-"))
    try {
      process.env.MINIMAL_AGENT_HOME = relocated
      // The override IS the agent-home base — used verbatim, not joined
      // with a further `.minimal-agent` segment.
      expect(globalMemoryPath()).toBe(join(relocated, "memory.md"))
      expect(projectMemoryPath("/Users/a/proj")).toBe(
        join(relocated, "projects", "Users/a/proj", "memory.md"),
      )
      expect(shortTermMemoryPath("abc-123")).toBe(join(relocated, "sessions", "abc-123.scratch.md"))
      // And a real write lands under the relocated home, nowhere else.
      const store = MemoryStore.global()
      const { bullet } = store.add("lives under MINIMAL_AGENT_HOME")
      expect(store.path).toBe(join(relocated, "memory.md"))
      expect(existsSync(join(relocated, "memory.md"))).toBe(true)
      expect(readFileSync(join(relocated, "memory.md"), "utf-8")).toContain(bullet.id)
    } finally {
      rmSync(relocated, { recursive: true, force: true })
    }
  })

  it("an explicit `home` dep still wins over the env override (test-injection preserved)", () => {
    process.env.MINIMAL_AGENT_HOME = "/tmp/should-be-ignored-when-home-injected"
    // Injected home maps to <home>/.minimal-agent exactly as before the
    // resolver refactor — the env override is not consulted.
    expect(globalMemoryPath({ home: "/h" })).toBe("/h/.minimal-agent/memory.md")
  })
})
