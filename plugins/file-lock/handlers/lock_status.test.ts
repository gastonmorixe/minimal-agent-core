/**
 * Tests for `LockStatus` handler.
 *
 * The status-inference logic (`annotate`) is exercised in isolation :
 * status verdict = what the live acquirer would also conclude : and the
 * action functions (`runList`, `runInspect`, `runClearStale`, `runClear`)
 * are exercised end-to-end with controlled disk state under a tmp dir.
 *
 * The default export adapter (`TUIContext` → action) is exercised via a
 * smoke test that builds a synthetic context and asserts the result kind
 * + content shape.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  buildHolder,
  lockPathFor,
  serializeHolder,
  type LockHolder,
} from "../../../src/file-lock.ts"
import type { TUIContext } from "../../../src/plugins/types.ts"

import lockStatusHandler, {
  annotate,
  runClear,
  runClearStale,
  runInspect,
  runList,
  type RunDeps,
} from "./lock_status.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lock-status-test-"))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// Shared deps factory : `pidAlive` returns true unless we override.
function deps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    cwd: dir,
    hostname: () => "ourhost",
    staleAfterMs: 60_000,
    pidAlive: () => true,
    now: () => 2_000_000,
    ...over,
  }
}

function writeLock(filePath: string, h: Partial<LockHolder> = {}): LockHolder {
  const holder: LockHolder = {
    ...buildHolder({
      sessionId: h.sessionId ?? "owner",
      tool: h.tool ?? "Edit",
      filePath,
      host: h.host ?? "ourhost",
      now: () => h.acquiredAtMs ?? 1_000_000,
    }),
    pid: h.pid ?? 11111,
    ...h,
  }
  writeFileSync(lockPathFor(filePath), serializeHolder(holder))
  return holder
}

// ---------------------------------------------------------------------------
// annotate
// ---------------------------------------------------------------------------

describe("annotate", () => {
  it("held: same-host alive PID, recent", () => {
    const h = buildHolder({
      sessionId: "x",
      tool: "Edit",
      filePath: "/x",
      host: "ourhost",
      now: () => 1_999_000,
    })
    const a = annotate(
      { lockPath: "/x.locked", filePath: "/x", holder: h },
      "ourhost",
      60_000,
      () => true,
      () => 2_000_000,
    )
    expect(a.status).toBe("held")
    expect(a.ageMs).toBe(1000)
  })

  it("stale-pid: same-host but pid gone", () => {
    const h = buildHolder({
      sessionId: "x",
      tool: "Edit",
      filePath: "/x",
      host: "ourhost",
      now: () => 1_999_000,
    })
    const a = annotate(
      { lockPath: "/x.locked", filePath: "/x", holder: h },
      "ourhost",
      60_000,
      () => false,
      () => 2_000_000,
    )
    expect(a.status).toBe("stale-pid")
    expect(a.reason).toMatch(/not alive/)
  })

  it("stale-time: same-host, alive PID, but old", () => {
    const h = buildHolder({
      sessionId: "x",
      tool: "Edit",
      filePath: "/x",
      host: "ourhost",
      now: () => 1,
    })
    const a = annotate(
      { lockPath: "/x.locked", filePath: "/x", holder: h },
      "ourhost",
      60_000,
      () => true,
      () => 2_000_000,
    )
    expect(a.status).toBe("stale-time")
    expect(a.reason).toMatch(/old/)
  })

  it("cross-host: different host, recent : held but unprobed", () => {
    const h = buildHolder({
      sessionId: "x",
      tool: "Edit",
      filePath: "/x",
      host: "elsewhere",
      now: () => 1_999_000,
    })
    const a = annotate(
      { lockPath: "/x.locked", filePath: "/x", holder: h },
      "ourhost",
      60_000,
      () => false, // even pidAlive=false: cross-host doesn't probe
      () => 2_000_000,
    )
    expect(a.status).toBe("cross-host")
  })

  it("cross-host stale-time: different host, old", () => {
    const h = buildHolder({
      sessionId: "x",
      tool: "Edit",
      filePath: "/x",
      host: "elsewhere",
      now: () => 1,
    })
    const a = annotate(
      { lockPath: "/x.locked", filePath: "/x", holder: h },
      "ourhost",
      60_000,
      () => true,
      () => 2_000_000,
    )
    expect(a.status).toBe("stale-time")
    expect(a.reason).toMatch(/elsewhere/)
  })

  it("corrupt: holder=null", () => {
    const a = annotate(
      { lockPath: "/x.locked", filePath: "/x", holder: null },
      "ourhost",
      60_000,
      () => true,
      () => 2_000_000,
    )
    expect(a.status).toBe("corrupt")
    expect(a.ageMs).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// runList
// ---------------------------------------------------------------------------

describe("runList", () => {
  it("empty dir → no locks", () => {
    const r = runList({ action: "list", format: "text" }, deps())
    expect(r.is_error).toBeFalsy()
    expect(r.content).toMatch(/No locks/)
  })

  it("returns text rendering with status badges by default", () => {
    const f = join(dir, "a.txt")
    writeLock(f, { sessionId: "owner", host: "ourhost" })
    const r = runList({ action: "list", format: "text" }, deps())
    expect(r.content).toContain(f)
    expect(r.content).toMatch(/held|stale|corrupt|cross-host/)
  })

  it("format=json returns parseable JSON in `content`", () => {
    const f = join(dir, "b.txt")
    writeLock(f, { sessionId: "owner", host: "ourhost" })
    const r = runList({ action: "list", format: "json" }, deps())
    const parsed = JSON.parse(r.content) as { count: number; locks: unknown[] }
    expect(parsed.count).toBe(1)
    expect(parsed.locks).toHaveLength(1)
    // display is still ANSI text : distinct from content.
    expect(r.display).not.toBe(r.content)
  })

  it("returns is_error when path doesn't exist", () => {
    const r = runList({ action: "list", path: "/no/such/path/xyz", format: "text" }, deps())
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/does not exist/)
  })

  it("classifies locks by status across the listing", () => {
    const aliveSameHost = join(dir, "alive.txt")
    const deadSameHost = join(dir, "dead.txt")
    const oldSameHost = join(dir, "old.txt")
    const elsewhere = join(dir, "elsewhere.txt")
    const corruptFile = join(dir, "corrupt.txt")
    writeLock(aliveSameHost, { pid: 1001, host: "ourhost", acquiredAtMs: 1_999_000 })
    writeLock(deadSameHost, { pid: 1002, host: "ourhost", acquiredAtMs: 1_999_000 })
    writeLock(oldSameHost, { pid: 1003, host: "ourhost", acquiredAtMs: 1 })
    writeLock(elsewhere, { pid: 1004, host: "elsewhere", acquiredAtMs: 1_999_000 })
    writeFileSync(lockPathFor(corruptFile), "garbage")

    const r = runList(
      { action: "list", format: "json" },
      deps({
        pidAlive: (pid) => pid !== 1002, // 1002 dead, 1001/1003/1004 alive
      }),
    )
    expect(r.is_error).toBeFalsy()
    const parsed = JSON.parse(r.content) as {
      locks: Array<{ filePath: string; status: string }>
    }
    const byPath = new Map(parsed.locks.map((l) => [l.filePath, l.status]))
    expect(byPath.get(aliveSameHost)).toBe("held")
    expect(byPath.get(deadSameHost)).toBe("stale-pid")
    expect(byPath.get(oldSameHost)).toBe("stale-time")
    expect(byPath.get(elsewhere)).toBe("cross-host")
    expect(byPath.get(corruptFile)).toBe("corrupt")
  })
})

// ---------------------------------------------------------------------------
// runInspect
// ---------------------------------------------------------------------------

describe("runInspect", () => {
  it("absent lock → benign 'No lock at ...' message (not is_error)", () => {
    const f = join(dir, "absent.txt")
    const r = runInspect({ action: "inspect", path: f, format: "text" }, deps())
    expect(r.is_error).toBeFalsy()
    expect(r.content).toMatch(/No lock at/)
  })

  it("text mode: pretty-prints holder", () => {
    const f = join(dir, "i1.txt")
    writeLock(f, { sessionId: "alpha", pid: 12345, host: "ourhost", acquiredAtMs: 1_999_000 })
    const r = runInspect({ action: "inspect", path: f, format: "text" }, deps())
    expect(r.content).toContain("alpha")
    expect(r.content).toContain("12345")
    expect(r.content).toContain("ourhost")
  })

  it("json mode: returns the full annotated holder", () => {
    const f = join(dir, "i2.txt")
    writeLock(f, { sessionId: "beta", pid: 999, host: "ourhost", acquiredAtMs: 1_999_000 })
    const r = runInspect({ action: "inspect", path: f, format: "json" }, deps())
    const parsed = JSON.parse(r.content) as { status: string; holder: LockHolder }
    expect(parsed.status).toBe("held")
    expect(parsed.holder.sessionId).toBe("beta")
  })
})

// ---------------------------------------------------------------------------
// runClearStale
// ---------------------------------------------------------------------------

describe("runClearStale", () => {
  it("removes only stale-pid / stale-time / corrupt; keeps held", () => {
    const aliveF = join(dir, "alive.txt")
    const deadF = join(dir, "dead.txt")
    const oldF = join(dir, "old.txt")
    const corruptF = join(dir, "corrupt.txt")
    writeLock(aliveF, { pid: 1, host: "ourhost", acquiredAtMs: 1_999_000 })
    writeLock(deadF, { pid: 2, host: "ourhost", acquiredAtMs: 1_999_000 })
    writeLock(oldF, { pid: 3, host: "ourhost", acquiredAtMs: 1 })
    writeFileSync(lockPathFor(corruptF), "x")

    const r = runClearStale(
      { action: "clear-stale", format: "json" },
      deps({ pidAlive: (pid) => pid === 1 }),
    )
    expect(r.is_error).toBeFalsy()
    const parsed = JSON.parse(r.content) as { removed: number; kept: number }
    expect(parsed.removed).toBe(3)
    expect(parsed.kept).toBe(1)
    expect(existsSync(lockPathFor(aliveF))).toBe(true)
    expect(existsSync(lockPathFor(deadF))).toBe(false)
    expect(existsSync(lockPathFor(oldF))).toBe(false)
    expect(existsSync(lockPathFor(corruptF))).toBe(false)
  })

  it("text mode summarizes counts and per-file results", () => {
    const a = join(dir, "a.txt")
    writeLock(a, { pid: 99999, host: "ourhost" })
    const r = runClearStale(
      { action: "clear-stale", format: "text" },
      deps({ pidAlive: () => false }),
    )
    expect(r.content).toContain("removed: 1")
    expect(r.content).toContain("kept:")
  })

  it("returns is_error when path doesn't exist", () => {
    const r = runClearStale(
      { action: "clear-stale", path: "/no/such/dir-xyz", format: "text" },
      deps(),
    )
    expect(r.is_error).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// runClear
// ---------------------------------------------------------------------------

describe("runClear", () => {
  it("removes the lock and reports verdict=OK for stale", () => {
    const f = join(dir, "x.txt")
    writeLock(f, { pid: 99999, host: "ourhost" })
    const r = runClear(
      { action: "clear", path: f, format: "json" },
      deps({ pidAlive: () => false }),
    )
    expect(r.is_error).toBeFalsy()
    expect(existsSync(lockPathFor(f))).toBe(false)
    const parsed = JSON.parse(r.content) as { removed: boolean; verdict: string }
    expect(parsed.removed).toBe(true)
    expect(parsed.verdict).toBe("OK")
  })

  it("clearing a HELD lock reports WARNING verdict (lock still removed)", () => {
    const f = join(dir, "y.txt")
    writeLock(f, { pid: 1, host: "ourhost", acquiredAtMs: 1_999_000 })
    const r = runClear(
      { action: "clear", path: f, format: "json" },
      deps({ pidAlive: () => true }),
    )
    expect(r.is_error).toBeFalsy()
    expect(existsSync(lockPathFor(f))).toBe(false)
    const parsed = JSON.parse(r.content) as { verdict: string }
    expect(parsed.verdict).toMatch(/WARNING/)
  })

  it("absent lock → benign message, not is_error", () => {
    const f = join(dir, "absent.txt")
    const r = runClear({ action: "clear", path: f, format: "text" }, deps())
    expect(r.is_error).toBeFalsy()
    expect(r.content).toMatch(/No lock to clear/)
  })
})

// ---------------------------------------------------------------------------
// Default-export adapter (TUIContext → run*)
// ---------------------------------------------------------------------------

describe("default export adapter", () => {
  function buildCtx(input: Record<string, unknown>): TUIContext {
    return {
      trigger: { type: "tool", name: "LockStatus", input, tool_use_id: "toolu_test" },
      packageDir: dir,
      cwd: dir,
      env: {},
      abort: new AbortController().signal,
      stdout: process.stdout,
      stdin: process.stdin,
      stderr: process.stderr,
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

  it("returns kind=tool_result with content+display", async () => {
    const r = await lockStatusHandler(buildCtx({ action: "list" }))
    expect(r.kind).toBe("tool_result")
    if (r.kind !== "tool_result") return
    expect(r.content).toBeDefined()
    expect(r.display).toBeDefined()
  })

  it("rejects unknown action with is_error", async () => {
    const r = await lockStatusHandler(buildCtx({ action: "frobnicate" }))
    expect(r.kind).toBe("tool_result")
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/action/)
  })

  it("rejects inspect without path", async () => {
    const r = await lockStatusHandler(buildCtx({ action: "inspect" }))
    if (r.kind !== "tool_result") throw new Error("wrong kind")
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/required/)
  })

  it("rejects inspect with relative path", async () => {
    const r = await lockStatusHandler(buildCtx({ action: "inspect", path: "rel/path.txt" }))
    if (r.kind !== "tool_result") throw new Error("wrong kind")
    expect(r.is_error).toBe(true)
    expect(r.content).toMatch(/absolute/)
  })

  it("rejects bad format value", async () => {
    const r = await lockStatusHandler(buildCtx({ action: "list", format: "yaml" }))
    if (r.kind !== "tool_result") throw new Error("wrong kind")
    expect(r.is_error).toBe(true)
  })

  it("non-tool trigger returns error", async () => {
    const ctx = buildCtx({ action: "list" })
    ;(ctx.trigger as unknown as { type: string }).type = "inline_tag"
    const r = await lockStatusHandler(ctx)
    if (r.kind !== "tool_result") throw new Error("wrong kind")
    expect(r.is_error).toBe(true)
  })
})

// Make sure the readdirSync-based listing has at least one matched file :
// a sanity check the test scaffolding writes lock files where we expect.
describe("test scaffolding sanity", () => {
  it("writeLock + listLocksUnder roundtrip", () => {
    const f = join(dir, "z.txt")
    writeLock(f)
    const listed = readdirSync(dir).filter((n) => n.endsWith(".locked"))
    expect(listed.length).toBe(1)
  })
})
