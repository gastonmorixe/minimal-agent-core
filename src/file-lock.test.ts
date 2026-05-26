/**
 * Tests for `src/file-lock.ts`.
 *
 * Each `describe` block targets one piece of the public API. Time, PID
 * liveness, hostname, and sleep are all injected via `LockOpts` so tests
 * never wait on the real wall clock and can simulate live/dead PIDs at
 * will.
 *
 * Tmp directory model: each test creates its own `mkdtempSync` dir and
 * removes it in `afterEach`. The lock library's exit hook is reset via
 * `_resetForTests()` so we don't accumulate `process.on("exit", ...)`
 * registrations across the test file.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  _heldLocksSnapshot,
  _resetForTests,
  acquireLock,
  buildHolder,
  DEFAULT_BACKOFF_MS,
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_TIMEOUT_MS,
  HARNESS_NAME,
  isStaleLock,
  LOCK_FORMAT_VERSION,
  LOCK_SUFFIX,
  LockAbortedError,
  type LockHolder,
  type LockOpts,
  LockTimeoutError,
  listLocksUnder,
  lockPathFor,
  parseHolder,
  readLockFile,
  serializeHolder,
  tryAcquireOnce,
} from "./file-lock.ts"

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "file-lock-test-"))
  _resetForTests()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("lockPathFor", () => {
  it("appends .locked to the file path", () => {
    expect(lockPathFor("/tmp/foo.ts")).toBe("/tmp/foo.ts.locked")
  })
  it("idempotent under repeated suffix only by accident : caller is responsible", () => {
    // Documents that we don't dedupe; lockPathFor("x.locked") -> "x.locked.locked"
    expect(lockPathFor("/tmp/foo.locked")).toBe("/tmp/foo.locked.locked")
  })
})

describe("parseHolder", () => {
  const valid: LockHolder = {
    v: 1,
    harness: "minimal-agent",
    sessionId: "sid-1",
    pid: 999,
    host: "h1",
    tool: "Edit",
    filePath: "/x",
    acquiredAt: "2026-05-10T00:00:00Z",
    acquiredAtMs: 1715299200000,
  }
  it("parses a well-formed serialized holder", () => {
    const text = serializeHolder(valid)
    expect(parseHolder(text)).toEqual(valid)
  })
  it("returns null for empty input", () => {
    expect(parseHolder("")).toBeNull()
    expect(parseHolder("   \n  ")).toBeNull()
  })
  it("returns null for non-JSON garbage", () => {
    expect(parseHolder("not json at all")).toBeNull()
  })
  it("returns null when JSON is an array", () => {
    expect(parseHolder("[1,2,3]")).toBeNull()
  })
  it("returns null when required field is missing", () => {
    const { pid: _pid, ...missing } = valid
    expect(parseHolder(JSON.stringify(missing))).toBeNull()
  })
  it("returns null when a required field has wrong type", () => {
    expect(parseHolder(JSON.stringify({ ...valid, pid: "999" }))).toBeNull()
    expect(parseHolder(JSON.stringify({ ...valid, acquiredAtMs: "x" }))).toBeNull()
  })
  it("tolerates unknown extra fields", () => {
    const out = parseHolder(JSON.stringify({ ...valid, extra: "ok" }))
    expect(out).toBeTruthy()
    expect((out as unknown as Record<string, unknown>).extra).toBe("ok")
  })
})

describe("buildHolder", () => {
  it("populates v=1, harness=minimal-agent, pid=process.pid by default", () => {
    const h = buildHolder({ sessionId: "s", tool: "Edit", filePath: "/x" })
    expect(h.v).toBe(LOCK_FORMAT_VERSION)
    expect(h.harness).toBe(HARNESS_NAME)
    expect(h.pid).toBe(process.pid)
    expect(h.tool).toBe("Edit")
    expect(h.sessionId).toBe("s")
    expect(h.filePath).toBe("/x")
    expect(typeof h.host).toBe("string")
    expect(typeof h.acquiredAt).toBe("string")
    expect(typeof h.acquiredAtMs).toBe("number")
  })
  it("uses injected now()", () => {
    const h = buildHolder({
      sessionId: "s",
      tool: "Edit",
      filePath: "/x",
      now: () => 0,
    })
    expect(h.acquiredAtMs).toBe(0)
    expect(h.acquiredAt).toBe(new Date(0).toISOString())
  })
  it("respects host override (cross-host simulation)", () => {
    const h = buildHolder({ sessionId: "s", tool: "Edit", filePath: "/x", host: "elsewhere" })
    expect(h.host).toBe("elsewhere")
  })
})

// ---------------------------------------------------------------------------
// Stale detection
// ---------------------------------------------------------------------------

describe("isStaleLock", () => {
  const fresh: LockHolder = buildHolder({
    sessionId: "s",
    tool: "Edit",
    filePath: "/x",
    host: "ourhost",
    now: () => 1_000_000,
  })

  it("not stale when same-host PID is alive and recent", () => {
    const r = isStaleLock(fresh, {
      staleAfterMs: 60_000,
      ourHost: "ourhost",
      pidAlive: () => true,
      now: () => 1_010_000, // 10s after acquire
    })
    expect(r.stale).toBe(false)
  })

  it("stale when same-host PID is dead", () => {
    const r = isStaleLock(fresh, {
      staleAfterMs: 60_000,
      ourHost: "ourhost",
      pidAlive: () => false,
      now: () => 1_010_000,
    })
    expect(r.stale).toBe(true)
    expect(r.reason).toMatch(/pid.*not alive/)
  })

  it("stale by time threshold even when PID is alive", () => {
    const r = isStaleLock(fresh, {
      staleAfterMs: 5_000,
      ourHost: "ourhost",
      pidAlive: () => true,
      now: () => 1_000_000 + 6_000,
    })
    expect(r.stale).toBe(true)
    expect(r.reason).toMatch(/old/)
  })

  it("does not probe PID across hosts (different host => skip kill probe)", () => {
    let probed = false
    const r = isStaleLock(fresh, {
      staleAfterMs: 60_000,
      ourHost: "differenthost",
      pidAlive: () => {
        probed = true
        return false
      },
      now: () => 1_010_000,
    })
    expect(r.stale).toBe(false)
    expect(probed).toBe(false)
  })

  it("cross-host stale only by time", () => {
    const r = isStaleLock(fresh, {
      staleAfterMs: 5_000,
      ourHost: "differenthost",
      pidAlive: () => true,
      now: () => 1_010_000,
    })
    expect(r.stale).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// tryAcquireOnce
// ---------------------------------------------------------------------------

describe("tryAcquireOnce", () => {
  it("creates the lock file with serialized holder", () => {
    const file = join(dir, "a.txt")
    const holder = buildHolder({ sessionId: "s1", tool: "Edit", filePath: file })
    const r = tryAcquireOnce(file, holder)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const text = readFileSync(r.handle.lockPath, "utf-8")
    expect(parseHolder(text)).toEqual(holder)
    expect(r.handle.lockPath).toBe(file + LOCK_SUFFIX)
    r.handle.release()
  })

  it("creates parent directory if missing (Write target under new subdir)", () => {
    const file = join(dir, "fresh-subdir", "b.txt")
    const holder = buildHolder({ sessionId: "s1", tool: "Write", filePath: file })
    const r = tryAcquireOnce(file, holder)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(existsSync(r.handle.lockPath)).toBe(true)
    r.handle.release()
  })

  it("returns reason='exists' on EEXIST with parsed holder", () => {
    const file = join(dir, "c.txt")
    const h1 = buildHolder({ sessionId: "s1", tool: "Edit", filePath: file })
    const r1 = tryAcquireOnce(file, h1)
    expect(r1.ok).toBe(true)
    const h2 = buildHolder({ sessionId: "s2", tool: "Edit", filePath: file })
    const r2 = tryAcquireOnce(file, h2)
    expect(r2.ok).toBe(false)
    if (r2.ok) return
    expect(r2.reason).toBe("exists")
    if (r2.reason !== "exists") return
    expect(r2.existing).toEqual(h1)
    if (r1.ok) r1.handle.release()
  })

  it("returns existing=null on EEXIST when the file is corrupt", () => {
    const file = join(dir, "d.txt")
    writeFileSync(file + LOCK_SUFFIX, "not json")
    const r = tryAcquireOnce(file, buildHolder({ sessionId: "s1", tool: "Edit", filePath: file }))
    expect(r.ok).toBe(false)
    if (r.ok) return
    if (r.reason !== "exists") {
      throw new Error(`expected reason=exists, got ${r.reason}`)
    }
    expect(r.existing).toBeNull()
  })

  it("release deletes the lock file", () => {
    const file = join(dir, "e.txt")
    const r = tryAcquireOnce(file, buildHolder({ sessionId: "s1", tool: "Edit", filePath: file }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(existsSync(r.handle.lockPath)).toBe(true)
    r.handle.release()
    expect(existsSync(r.handle.lockPath)).toBe(false)
  })

  it("release is idempotent", () => {
    const file = join(dir, "f.txt")
    const r = tryAcquireOnce(file, buildHolder({ sessionId: "s1", tool: "Edit", filePath: file }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    r.handle.release()
    // Second call must not throw and must not unlink any file that
    // may have re-appeared in the meantime.
    expect(() => r.handle.release()).not.toThrow()
  })

  it("release refuses to unlink a lock that was stolen", () => {
    const file = join(dir, "g.txt")
    const r = tryAcquireOnce(file, buildHolder({ sessionId: "s1", tool: "Edit", filePath: file }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Simulate someone breaking and replacing our lock.
    const stolen = buildHolder({
      sessionId: "thief",
      tool: "Edit",
      filePath: file,
      now: () => Date.now() + 1,
    })
    writeFileSync(r.handle.lockPath, serializeHolder(stolen))
    r.handle.release()
    // The thief's lock must still be there.
    expect(existsSync(r.handle.lockPath)).toBe(true)
    const cur = readLockFile(r.handle.lockPath)
    expect(cur?.sessionId).toBe("thief")
  })
})

// ---------------------------------------------------------------------------
// acquireLock : the public path
// ---------------------------------------------------------------------------

/**
 * Build a controllable LockOpts:
 *   - `now()` reads from a mutable cell so tests can step time forward.
 *   - `sleep()` advances time by the requested ms (so the next backoff
 *     attempt sees a later `now`) and returns immediately : no real wall
 *     clock waits.
 *   - `pidAlive` defaults to "alive" but is replaceable.
 */
function fakeClock(start = 1_000_000): {
  now: () => number
  advance: (ms: number) => void
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
} {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
    sleep: (ms, signal) => {
      if (signal?.aborted) return Promise.reject(new LockAbortedError(""))
      t += ms
      return Promise.resolve()
    },
  }
}

describe("acquireLock : happy path", () => {
  it("acquires immediately when no contention", async () => {
    const file = join(dir, "h.txt")
    const handle = await acquireLock(file, { sessionId: "s1", tool: "Edit" })
    expect(existsSync(handle.lockPath)).toBe(true)
    expect(handle.holder.tool).toBe("Edit")
    expect(handle.holder.sessionId).toBe("s1")
    handle.release()
    expect(existsSync(handle.lockPath)).toBe(false)
  })

  it("registers the lock in heldLocks while held", async () => {
    const file = join(dir, "i.txt")
    expect(_heldLocksSnapshot()).toHaveLength(0)
    const handle = await acquireLock(file, { sessionId: "s1", tool: "Edit" })
    expect(_heldLocksSnapshot()).toContain(handle.lockPath)
    handle.release()
    expect(_heldLocksSnapshot()).not.toContain(handle.lockPath)
  })
})

describe("acquireLock : same-session reentrancy", () => {
  it("returns a no-op handle when our own session+pid already holds the lock", async () => {
    const file = join(dir, "j.txt")
    const first = await acquireLock(file, { sessionId: "s1", tool: "Edit" })
    expect(existsSync(first.lockPath)).toBe(true)
    // Reentrant acquire: same sessionId and pid (default).
    const second = await acquireLock(file, { sessionId: "s1", tool: "Edit" })
    // The lock file must still be there (we didn't break+rewrite it).
    expect(existsSync(second.lockPath)).toBe(true)
    // Second.release MUST be a no-op so the first holder still owns it.
    second.release()
    expect(existsSync(first.lockPath)).toBe(true)
    first.release()
    expect(existsSync(first.lockPath)).toBe(false)
  })
})

describe("acquireLock : stale detection breaks and continues", () => {
  it("breaks a lock whose holder PID is dead (same-host)", async () => {
    const file = join(dir, "k.txt")
    const dead = buildHolder({
      sessionId: "old",
      tool: "Edit",
      filePath: file,
      host: "ourhost",
    })
    writeFileSync(lockPathFor(file), serializeHolder(dead))
    const fc = fakeClock()
    const handle = await acquireLock(
      file,
      { sessionId: "s1", tool: "Edit" },
      {
        ...fc,
        pidAlive: () => false, // simulates ESRCH on the holder pid
        hostname: () => "ourhost",
      },
    )
    expect(handle.holder.sessionId).toBe("s1")
    expect(readLockFile(handle.lockPath)?.sessionId).toBe("s1")
    handle.release()
  })

  it("breaks a time-stale lock (alive PID but older than threshold)", async () => {
    const file = join(dir, "l.txt")
    const fc = fakeClock(10_000_000)
    const old = buildHolder({
      sessionId: "old",
      tool: "Edit",
      filePath: file,
      host: "ourhost",
      now: () => 1, // ancient
    })
    writeFileSync(lockPathFor(file), serializeHolder(old))
    const handle = await acquireLock(
      file,
      { sessionId: "s1", tool: "Edit" },
      {
        ...fc,
        staleAfterMs: 1000,
        pidAlive: () => true,
        hostname: () => "ourhost",
      },
    )
    expect(handle.holder.sessionId).toBe("s1")
    handle.release()
  })

  it("breaks a corrupt (unparsable) lock immediately", async () => {
    const file = join(dir, "m.txt")
    writeFileSync(lockPathFor(file), "garbage")
    const handle = await acquireLock(file, { sessionId: "s1", tool: "Edit" })
    expect(handle.holder.sessionId).toBe("s1")
    handle.release()
  })
})

describe("acquireLock : contention with backoff", () => {
  it("waits, retries, succeeds when the holder releases", async () => {
    const file = join(dir, "n.txt")
    const fc = fakeClock()
    const otherHolder = buildHolder({
      sessionId: "other",
      tool: "Edit",
      filePath: file,
      host: "ourhost",
      now: fc.now,
    })
    writeFileSync(lockPathFor(file), serializeHolder(otherHolder))

    let attempts = 0
    const sleepMs: number[] = []
    const opts: LockOpts = {
      now: fc.now,
      pidAlive: () => true,
      hostname: () => "ourhost",
      timeoutMs: 60_000,
      staleAfterMs: 60_000_000,
      backoffMs: [10, 20, 40],
      sleep: async (ms, _signal) => {
        sleepMs.push(ms)
        attempts++
        // After the second sleep, the other holder "releases".
        if (attempts === 2) {
          try {
            // unlink to simulate release
            const fs = await import("node:fs")
            fs.unlinkSync(lockPathFor(file))
          } catch {
            // ignore
          }
        }
        fc.advance(ms)
      },
    }
    const handle = await acquireLock(file, { sessionId: "s1", tool: "Edit" }, opts)
    expect(handle.holder.sessionId).toBe("s1")
    expect(sleepMs.slice(0, 2)).toEqual([10, 20]) // backoff applied
    handle.release()
  })

  it("times out with LockTimeoutError carrying holder details", async () => {
    const file = join(dir, "o.txt")
    const fc = fakeClock()
    const other = buildHolder({
      sessionId: "stuckpeer",
      tool: "Edit",
      filePath: file,
      host: "ourhost",
      now: fc.now,
    })
    writeFileSync(lockPathFor(file), serializeHolder(other))

    let err: unknown = null
    try {
      await acquireLock(
        file,
        { sessionId: "s1", tool: "Edit" },
        {
          ...fc,
          pidAlive: () => true,
          hostname: () => "ourhost",
          timeoutMs: 100,
          staleAfterMs: 60_000_000,
          backoffMs: [50, 50, 50],
        },
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LockTimeoutError)
    const e = err as LockTimeoutError
    expect(e.filePath).toBe(file)
    expect(e.holder?.sessionId).toBe("stuckpeer")
    expect(e.message).toContain("locked")
    expect(e.message).toContain("stuckpeer")
    // Other peer's lock must still be there : we didn't smash it.
    expect(existsSync(e.lockPath)).toBe(true)
  })

  it("aborts on signal during the sleep phase", async () => {
    const file = join(dir, "p.txt")
    const fc = fakeClock()
    const other = buildHolder({
      sessionId: "otherp",
      tool: "Edit",
      filePath: file,
      host: "ourhost",
      now: fc.now,
    })
    writeFileSync(lockPathFor(file), serializeHolder(other))

    const ac = new AbortController()
    const sleepFn = async (ms: number, signal?: AbortSignal): Promise<void> => {
      // First call: abort then reject.
      ac.abort()
      if (signal?.aborted) throw new LockAbortedError("")
      fc.advance(ms)
    }

    let err: unknown = null
    try {
      await acquireLock(
        file,
        { sessionId: "s1", tool: "Edit" },
        {
          now: fc.now,
          pidAlive: () => true,
          hostname: () => "ourhost",
          timeoutMs: 60_000,
          staleAfterMs: 60_000_000,
          backoffMs: [10],
          sleep: sleepFn,
          signal: ac.signal,
        },
      )
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(LockAbortedError)
  })
})

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe("default constants", () => {
  it("DEFAULT_TIMEOUT_MS is 30 seconds", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000)
  })
  it("DEFAULT_STALE_AFTER_MS is 5 minutes", () => {
    expect(DEFAULT_STALE_AFTER_MS).toBe(300_000)
  })
  it("DEFAULT_BACKOFF_MS escalates and caps at 1000", () => {
    expect(DEFAULT_BACKOFF_MS[0]).toBeLessThanOrEqual(100)
    expect(DEFAULT_BACKOFF_MS.at(-1)).toBe(1000)
    for (let i = 1; i < DEFAULT_BACKOFF_MS.length; i++) {
      const prev = DEFAULT_BACKOFF_MS[i - 1]
      const cur = DEFAULT_BACKOFF_MS[i]
      expect(prev).toBeDefined()
      expect(cur).toBeDefined()
      expect((cur as number) >= (prev as number)).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// listLocksUnder
// ---------------------------------------------------------------------------

describe("listLocksUnder", () => {
  it("returns empty array for empty dir", () => {
    expect(listLocksUnder(dir)).toEqual([])
  })

  it("finds .locked files at any depth, parsing holders", async () => {
    const f1 = join(dir, "a.txt")
    const subdir = join(dir, "sub")
    const f2 = join(subdir, "b.txt")
    const h1 = await acquireLock(f1, { sessionId: "s1", tool: "Edit" })
    const h2 = await acquireLock(f2, { sessionId: "s2", tool: "Write" })
    const list = listLocksUnder(dir)
    expect(list).toHaveLength(2)
    const sids = list.map((l) => l.holder?.sessionId).sort()
    expect(sids).toEqual(["s1", "s2"])
    const fps = list.map((l) => l.filePath).sort()
    expect(fps).toEqual([f1, f2].sort())
    h1.release()
    h2.release()
  })

  it("surfaces corrupt locks with holder=null", () => {
    const f = join(dir, "c.txt")
    writeFileSync(lockPathFor(f), "garbage")
    const list = listLocksUnder(dir)
    expect(list).toHaveLength(1)
    expect(list[0]?.holder).toBeNull()
  })

  it("skips node_modules / .git / dist subtrees", async () => {
    const skipped = ["node_modules", ".git", "dist", "build", ".cache"]
    for (const s of skipped) {
      const sub = join(dir, s)
      const f = join(sub, "leaked.txt")
      const h = await acquireLock(f, { sessionId: "skip", tool: "Edit" })
      h.release()
      // Pre-write a bare lock file to be sure (release would have removed it).
      writeFileSync(
        lockPathFor(f),
        serializeHolder(buildHolder({ sessionId: "skip", tool: "Edit", filePath: f })),
      )
    }
    const list = listLocksUnder(dir)
    expect(list).toHaveLength(0)
  })
})
