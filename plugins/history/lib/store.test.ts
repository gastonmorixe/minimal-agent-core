/**
 * Tests for the history store.
 *
 * Uses an isolated namespace via `MINIMAL_AGENT_HISTORY_NAMESPACE` so
 * we never touch the user's real history files. Each test clears
 * before/after to keep cases independent.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"

import { AGENT_HOME_ENV } from "@minimal-agent/plugin-api/utils/agent-paths"

import {
  _clearAll,
  appendBoth,
  appendOne,
  buildEntry,
  globalHistoryPath,
  HISTORY_DISABLE_ENV,
  HISTORY_NAMESPACE_ENV,
  isDisabled,
  loadEntries,
  MAX_FILE_BYTES,
  newEntryId,
  projectHistoryPath,
} from "./store.ts"

const NS = `history-store-test-${process.pid}`
const TEST_HOME = join(tmpdir(), `minimal-agent-history-tests-${process.pid}`)

// Use a fake $HOME so namespace paths resolve under a sandbox dir.
// homedir() reads from $HOME on POSIX (the underlying npm/Bun semantics
// match `os.homedir()`). We point it at a tmp dir and clean up at end.
const ORIGINAL_HOME = process.env.HOME
const ORIGINAL_MA_HOME = process.env.MINIMAL_AGENT_HOME

function envWithNs(extra: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: TEST_HOME,
    [HISTORY_NAMESPACE_ENV]: NS,
    ...extra,
  }
  // Strip undefined values — `delete` semantics for opt-out.
  for (const [k, v] of Object.entries(e)) {
    if (v === undefined) delete e[k]
  }
  return e
}

beforeAll(() => {
  process.env.HOME = TEST_HOME
  process.env[HISTORY_NAMESPACE_ENV] = NS
  // Clear an inherited MINIMAL_AGENT_HOME so the store's home resolver
  // falls back to the sandbox `$HOME` we just set. The harness exports
  // a real MINIMAL_AGENT_HOME, which would otherwise win over HOME and
  // route history paths at the user's real ~/.minimal-agent. Because
  // `envWithNs` spreads `process.env`, clearing it here also cleans the
  // env objects those opt-out tests build.
  delete process.env[AGENT_HOME_ENV]
})
afterAll(() => {
  if (ORIGINAL_HOME !== undefined) process.env.HOME = ORIGINAL_HOME
  if (ORIGINAL_MA_HOME === undefined) delete process.env[AGENT_HOME_ENV]
  else process.env[AGENT_HOME_ENV] = ORIGINAL_MA_HOME
  delete process.env[HISTORY_NAMESPACE_ENV]
  delete process.env[HISTORY_DISABLE_ENV]
  // Tear down the sandbox dir.
  try {
    rmSync(TEST_HOME, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})
beforeEach(() => {
  _clearAll(process.env, "/test/cwd-A")
  _clearAll(process.env, "/test/cwd-B")
  delete process.env[HISTORY_DISABLE_ENV]
})

describe("history store / paths", () => {
  it("globalHistoryPath sits under ~/.minimal-agent/namespaces/<ns>/", () => {
    const p = globalHistoryPath()
    expect(p).toBe(join(TEST_HOME, ".minimal-agent", "namespaces", NS, "history.jsonl"))
  })

  it("projectHistoryPath mirrors the absolute cwd under projects/", () => {
    const p = projectHistoryPath("/Users/gaston/Projects/foo")
    expect(p).toBe(
      join(
        TEST_HOME,
        ".minimal-agent",
        "namespaces",
        NS,
        "projects",
        "Users/gaston/Projects/foo",
        "history.jsonl",
      ),
    )
  })

  it("global and project paths differ for the same project (mirror pattern)", () => {
    expect(globalHistoryPath()).not.toBe(projectHistoryPath("/x"))
  })
})

describe("history store / newEntryId", () => {
  it("returns <base36-millis>-<hex4> shape", () => {
    // 6844 in base 36 = "5a4" (NOT a hex-looking string — the prefix is
    // base36 of the millisecond timestamp, the tail is hex of randomness).
    const id = newEntryId(
      () => 6844,
      () => Buffer.from([0xde, 0xad]),
    )
    expect(id).toBe("5a4-dead")
    expect(id).toMatch(/^[0-9a-z]+-[0-9a-f]{4}$/)
  })

  it("sortable when emitted in monotonic ms order", () => {
    const a = newEntryId(
      () => 1000,
      () => Buffer.from([0, 0]),
    )
    const b = newEntryId(
      () => 1001,
      () => Buffer.from([0, 0]),
    )
    expect(a.localeCompare(b)).toBeLessThan(0)
  })
})

describe("history store / buildEntry", () => {
  it("stamps `ts` from the injected clock and uses defaults for exit", () => {
    const e = buildEntry(
      { text: "hello", cwd: "/x", sid: "abc" },
      {
        now: () => new Date("2026-05-20T00:00:00Z"),
        rand: () => Buffer.from([0x12, 0x34]),
      },
    )
    expect(e.ts).toBe("2026-05-20T00:00:00.000Z")
    expect(e.text).toBe("hello")
    expect(e.cwd).toBe("/x")
    expect(e.sid).toBe("abc")
    expect(e.exit).toBe("submitted")
    expect(e.id).toMatch(/^[0-9a-z]+-1234$/)
  })

  it('accepts exit="canceled"', () => {
    const e = buildEntry({ text: "x", cwd: "/x", sid: null, exit: "canceled" })
    expect(e.exit).toBe("canceled")
    expect(e.sid).toBeNull()
  })
})

describe("history store / append + load round-trip", () => {
  it("appendOne writes one JSON line; loadEntries parses it back", () => {
    const p = projectHistoryPath("/test/cwd-A")
    const e = buildEntry({ text: "first prompt", cwd: "/test/cwd-A", sid: "sid-1" })
    appendOne(p, e)
    expect(existsSync(p)).toBe(true)
    const loaded = loadEntries(p)
    expect(loaded.length).toBe(1)
    expect(loaded[0]).toEqual(e)
  })

  it("appendBoth writes to BOTH project and global files", () => {
    const e = buildEntry({ text: "x", cwd: "/test/cwd-A", sid: "sid-1" })
    appendBoth(e)
    expect(loadEntries(projectHistoryPath("/test/cwd-A")).length).toBe(1)
    expect(loadEntries(globalHistoryPath()).length).toBe(1)
  })

  it("preserves order across multiple appends (oldest-first)", () => {
    const p = projectHistoryPath("/test/cwd-A")
    for (let i = 0; i < 5; i++) {
      appendOne(p, buildEntry({ text: `entry-${i}`, cwd: "/test/cwd-A", sid: null }))
    }
    const loaded = loadEntries(p)
    expect(loaded.map((e) => e.text)).toEqual([
      "entry-0",
      "entry-1",
      "entry-2",
      "entry-3",
      "entry-4",
    ])
  })

  it("survives newlines embedded in `text` (JSON encoding)", () => {
    const p = projectHistoryPath("/test/cwd-A")
    const e = buildEntry({ text: "line1\nline2\nline3", cwd: "/test/cwd-A", sid: null })
    appendOne(p, e)
    const loaded = loadEntries(p)
    expect(loaded[0].text).toBe("line1\nline2\nline3")
  })

  it("loadEntries skips malformed lines without poisoning the rest", () => {
    const p = projectHistoryPath("/test/cwd-A")
    appendOne(p, buildEntry({ text: "good-1", cwd: "/test/cwd-A", sid: null }))
    // Inject a corrupted line manually
    writeFileSync(p, `${readFileSync(p, "utf-8")}not-json\n`)
    appendOne(p, buildEntry({ text: "good-2", cwd: "/test/cwd-A", sid: null }))
    const loaded = loadEntries(p)
    expect(loaded.map((e) => e.text)).toEqual(["good-1", "good-2"])
  })

  it("loadEntries returns [] for a missing file", () => {
    expect(loadEntries(projectHistoryPath("/never-existed"))).toEqual([])
  })
})

describe("history store / opt-out", () => {
  it("isDisabled is true exactly when MINIMAL_AGENT_NO_HISTORY=1", () => {
    expect(isDisabled(envWithNs({ [HISTORY_DISABLE_ENV]: undefined }))).toBe(false)
    expect(isDisabled(envWithNs({ [HISTORY_DISABLE_ENV]: "1" }))).toBe(true)
    expect(isDisabled(envWithNs({ [HISTORY_DISABLE_ENV]: "0" }))).toBe(false)
    expect(isDisabled(envWithNs({ [HISTORY_DISABLE_ENV]: "true" }))).toBe(false) // strict "1"
  })

  it("appendBoth is a no-op when disabled", () => {
    process.env[HISTORY_DISABLE_ENV] = "1"
    appendBoth(buildEntry({ text: "should-not-save", cwd: "/test/cwd-A", sid: null }))
    expect(existsSync(globalHistoryPath())).toBe(false)
    expect(existsSync(projectHistoryPath("/test/cwd-A"))).toBe(false)
  })
})

describe("history store / cap rotation", () => {
  it("does NOT rotate while under the cap", () => {
    const p = projectHistoryPath("/test/cwd-A")
    for (let i = 0; i < 3; i++) {
      appendOne(p, buildEntry({ text: `entry-${i}`, cwd: "/test/cwd-A", sid: null }), {
        maxBytes: 1024,
        rotateFraction: 0.25,
      })
    }
    expect(loadEntries(p).length).toBe(3)
  })

  it("drops the head when the cap is exceeded; tail survives intact", () => {
    const p = projectHistoryPath("/test/cwd-A")
    // 200 entries of ~120 bytes each = ~24 KB total. Cap at 12 KB
    // forces a rotation right around entry 100.
    for (let i = 0; i < 200; i++) {
      appendOne(
        p,
        buildEntry({ text: `entry-${String(i).padStart(3, "0")}`, cwd: "/test/cwd-A", sid: null }),
        { maxBytes: 12 * 1024, rotateFraction: 0.25 },
      )
    }
    const loaded = loadEntries(p)
    // Tail must include the most recent entries — they're never dropped.
    const texts = loaded.map((e) => e.text)
    expect(texts).toContain("entry-199")
    expect(texts).toContain("entry-198")
    expect(texts).toContain("entry-150")
    // Some early entries must have been dropped.
    expect(loaded.length).toBeLessThan(200)
    // Append order preserved: every entry's index in `texts` matches
    // its numeric suffix's order in the loaded slice. (We can't sort
    // by `id` because many entries land within the same millisecond
    // and the rand tail makes ids non-monotonic; the FILE order
    // is monotonic because appendOne is synchronous.)
    const nums = texts.map((t) => Number(t.slice("entry-".length)))
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBeGreaterThan(nums[i - 1])
    }
  })

  it("rotation leaves valid JSONL (every surviving line parses)", () => {
    const p = projectHistoryPath("/test/cwd-A")
    for (let i = 0; i < 100; i++) {
      appendOne(p, buildEntry({ text: `entry-${i}`, cwd: "/test/cwd-A", sid: null }), {
        maxBytes: 2 * 1024,
        rotateFraction: 0.5,
      })
    }
    // Raw file scan — every non-empty line must JSON-parse.
    const raw = readFileSync(p, "utf-8")
    for (const line of raw.split("\n")) {
      if (line.length === 0) continue
      expect(() => JSON.parse(line)).not.toThrow()
    }
  })
})

describe("history store / MAX_FILE_BYTES default sanity", () => {
  it("default cap is 10 MB (regression guard against accidental tightening)", () => {
    expect(MAX_FILE_BYTES).toBe(10 * 1024 * 1024)
  })
})

// ---------------------------------------------------------------------------
// MINIMAL_AGENT_HOME override
//
// `maHome` now routes the `.minimal-agent` base through the shared
// `resolveAgentHome` resolver, which treats `MINIMAL_AGENT_HOME` as
// authoritative (it wins over `$HOME`). A relocated agent home must
// therefore become the base of every history path; the namespace suffix
// is still composed on top. The surrounding `beforeAll` cleared any
// inherited override, so this block sets one explicitly and restores it.
// ---------------------------------------------------------------------------

describe("history store / MINIMAL_AGENT_HOME override", () => {
  let savedMaHome: string | undefined
  let savedNs: string | undefined

  beforeEach(() => {
    savedMaHome = process.env[AGENT_HOME_ENV]
    // Drop the test namespace so the override base is asserted bare.
    savedNs = process.env[HISTORY_NAMESPACE_ENV]
    delete process.env[HISTORY_NAMESPACE_ENV]
  })

  afterEach(() => {
    if (savedMaHome === undefined) delete process.env[AGENT_HOME_ENV]
    else process.env[AGENT_HOME_ENV] = savedMaHome
    if (savedNs === undefined) delete process.env[HISTORY_NAMESPACE_ENV]
    else process.env[HISTORY_NAMESPACE_ENV] = savedNs
  })

  it("history paths land under MINIMAL_AGENT_HOME when set (wins over $HOME)", () => {
    const relocated = join(tmpdir(), `ma-history-relocated-${process.pid}`)
    process.env[AGENT_HOME_ENV] = relocated
    // The override IS the agent-home base — used verbatim, not joined
    // with a further `.minimal-agent` segment, and it beats the
    // `HOME=TEST_HOME` set in beforeAll.
    expect(globalHistoryPath()).toBe(join(relocated, "history.jsonl"))
    expect(projectHistoryPath("/Users/gaston/Projects/foo")).toBe(
      join(relocated, "projects", "Users/gaston/Projects/foo", "history.jsonl"),
    )
    // A real append lands under the relocated home and reads back.
    const p = globalHistoryPath()
    try {
      const e = buildEntry({ text: "under relocated home", cwd: "/x", sid: null })
      appendOne(p, e)
      expect(existsSync(p)).toBe(true)
      expect(loadEntries(p).map((x) => x.text)).toContain("under relocated home")
    } finally {
      rmSync(relocated, { recursive: true, force: true })
    }
  })
})
