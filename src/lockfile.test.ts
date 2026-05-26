/**
 * Tests for {@link ./lockfile.ts}.
 *
 * The lockfile module's contract is small but load-bearing. Three things
 * must hold:
 *
 *   1. Mutual exclusion: only one acquirer holds the lock at a time.
 *   2. Stale recovery: if the holder dies without releasing, the next
 *      acquirer detects this (via PID liveness) and reclaims the slot.
 *   3. Bounded wait: acquireLock returns null after timeoutMs; never
 *      blocks indefinitely.
 *
 * All three are tested here. We use a temp directory so concurrent
 * test runs don't collide on the same lockfile path.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { _resetLocksForTest, acquireLock, isProcessAlive, withLock } from "./lockfile.ts"

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "minimal-agent-lockfile-test-"))
})

afterEach(() => {
  _resetLocksForTest()
  try {
    rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // best-effort
  }
})

describe("isProcessAlive", () => {
  it("returns true for our own PID", () => {
    expect(isProcessAlive(process.pid)).toBe(true)
  })

  it("returns false for an obviously dead PID", () => {
    // PID 999999 is exceedingly unlikely to be allocated. The OS will
    // either return ESRCH (dead → false) or the PID happens to belong to
    // another process the test user can't signal (EPERM → still alive,
    // we'd skip). We pick a value above PID_MAX on macOS (99998 default)
    // so even in pathological cases it can't be alive.
    expect(isProcessAlive(2_147_483_640)).toBe(false)
  })

  it("returns false for non-positive integers", () => {
    expect(isProcessAlive(0)).toBe(false)
    expect(isProcessAlive(-1)).toBe(false)
    expect(isProcessAlive(Number.NaN)).toBe(false)
  })
})

describe("acquireLock — mutual exclusion", () => {
  it("two acquirers cannot both hold the lock", async () => {
    const path = join(tmpDir, "a.lock")
    const lock1 = await acquireLock(path, { timeoutMs: 100 })
    expect(lock1).not.toBeNull()
    const lock2 = await acquireLock(path, { timeoutMs: 50 })
    expect(lock2).toBeNull() // timed out — first holder still has it
    lock1!.release()
    const lock3 = await acquireLock(path, { timeoutMs: 100 })
    expect(lock3).not.toBeNull()
    lock3!.release()
  })

  it("release is idempotent and safe to call after exit cleanup", async () => {
    const path = join(tmpDir, "b.lock")
    const lock = await acquireLock(path, { timeoutMs: 100 })
    expect(lock).not.toBeNull()
    lock!.release()
    // Calling again must not throw.
    expect(() => lock!.release()).not.toThrow()
  })

  it("acquireLock writes our PID into the lock file", async () => {
    const path = join(tmpDir, "c.lock")
    const lock = await acquireLock(path, { timeoutMs: 100 })
    expect(lock).not.toBeNull()
    const contents = readFileSync(path, "utf-8")
    expect(Number.parseInt(contents, 10)).toBe(process.pid)
    lock!.release()
  })

  it("creates the parent directory if missing", async () => {
    const path = join(tmpDir, "nested", "deep", "lock")
    const lock = await acquireLock(path, { timeoutMs: 100 })
    expect(lock).not.toBeNull()
    expect(existsSync(path)).toBe(true)
    lock!.release()
  })
})

describe("acquireLock — stale-lock recovery", () => {
  it("reclaims a lockfile whose holder PID is dead", async () => {
    const path = join(tmpDir, "stale.lock")
    // Plant a stale lockfile owned by an obviously-dead PID. This
    // simulates: previous holder crashed without unlinking.
    writeFileSync(path, "2147483640")

    const lock = await acquireLock(path, { timeoutMs: 200 })
    expect(lock).not.toBeNull()
    // Lockfile now holds OUR PID, not the stale one.
    const contents = readFileSync(path, "utf-8")
    expect(Number.parseInt(contents, 10)).toBe(process.pid)
    lock!.release()
  })

  it("does NOT reclaim a lockfile whose holder is alive", async () => {
    const path = join(tmpDir, "live.lock")
    // Plant a lockfile owned by us — process.pid IS alive.
    writeFileSync(path, String(process.pid))

    const lock = await acquireLock(path, { timeoutMs: 100 })
    expect(lock).toBeNull() // timed out — we don't steal an alive holder's lock
  })

  it("reclaims a malformed PID file (treated as stale)", async () => {
    const path = join(tmpDir, "garbage.lock")
    writeFileSync(path, "not-a-number")

    // The atomic-link acquire pattern ensures any well-formed lockfile
    // contains a real PID written BEFORE the link. So a malformed PID
    // implies external corruption (someone wrote garbage, or an old
    // lockfile from a non-link-using version). Reclaiming is correct —
    // refusing to steal would deadlock on stale corruption forever.
    const lock = await acquireLock(path, { timeoutMs: 200 })
    expect(lock).not.toBeNull()
    // Lockfile now holds OUR PID, not the garbage.
    const contents = readFileSync(path, "utf-8")
    expect(Number.parseInt(contents, 10)).toBe(process.pid)
    lock!.release()
  })

  it("isAlive injection lets tests force the dead/alive verdict", async () => {
    const path = join(tmpDir, "injected.lock")
    writeFileSync(path, "12345")

    // Force "dead": stale-lock path triggers, we get the lock.
    const lock = await acquireLock(path, { timeoutMs: 200 }, { isAlive: () => false })
    expect(lock).not.toBeNull()
    lock!.release()

    // Plant another stale lock and force "alive": acquire should time out.
    writeFileSync(path, "67890")
    const lock2 = await acquireLock(path, { timeoutMs: 100 }, { isAlive: () => true })
    expect(lock2).toBeNull()
  })
})

describe("acquireLock — bounded wait", () => {
  it("returns null after timeoutMs elapses without acquiring", async () => {
    const path = join(tmpDir, "blocked.lock")
    const lock1 = await acquireLock(path, { timeoutMs: 50 })
    expect(lock1).not.toBeNull()

    const start = Date.now()
    const lock2 = await acquireLock(path, { timeoutMs: 60, pollMs: 10 })
    const elapsed = Date.now() - start
    expect(lock2).toBeNull()
    // Should respect timeout within a few poll intervals' slack.
    expect(elapsed).toBeGreaterThanOrEqual(55)
    expect(elapsed).toBeLessThan(500)

    lock1!.release()
  })

  it("returns immediately if the lock is free", async () => {
    const path = join(tmpDir, "free.lock")
    const start = Date.now()
    const lock = await acquireLock(path, { timeoutMs: 5000 })
    const elapsed = Date.now() - start
    expect(lock).not.toBeNull()
    expect(elapsed).toBeLessThan(50) // well under the 5s timeout
    lock!.release()
  })
})

describe("withLock", () => {
  it("acquires, runs fn, releases on success", async () => {
    const path = join(tmpDir, "wl.lock")
    const result = await withLock(path, { timeoutMs: 100 }, () => "value")
    expect(result).toEqual({ ok: true, value: "value" })
    // Lock released — next acquire is immediate.
    const next = await acquireLock(path, { timeoutMs: 100 })
    expect(next).not.toBeNull()
    next!.release()
  })

  it("releases even if fn throws", async () => {
    const path = join(tmpDir, "wl-throw.lock")
    await expect(
      withLock(path, { timeoutMs: 100 }, () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow(/boom/)
    // Lock released despite the throw.
    const next = await acquireLock(path, { timeoutMs: 100 })
    expect(next).not.toBeNull()
    next!.release()
  })

  it("returns timeout outcome when lock can't be acquired", async () => {
    const path = join(tmpDir, "wl-timeout.lock")
    const blocker = await acquireLock(path, { timeoutMs: 100 })
    expect(blocker).not.toBeNull()

    let fnRan = false
    const result = await withLock(path, { timeoutMs: 50, pollMs: 10 }, () => {
      fnRan = true
      return "should not run"
    })
    expect(result).toEqual({ ok: false, reason: "timeout" })
    expect(fnRan).toBe(false)

    blocker!.release()
  })

  it("supports awaiting an async fn", async () => {
    const path = join(tmpDir, "wl-async.lock")
    const result = await withLock(path, { timeoutMs: 100 }, async () => {
      await new Promise((r) => setTimeout(r, 5))
      return 42
    })
    expect(result).toEqual({ ok: true, value: 42 })
  })
})

describe("acquireLock — cross-process simulation", () => {
  it("sequential acquire-release-acquire works across multiple cycles", async () => {
    const path = join(tmpDir, "seq.lock")
    for (let i = 0; i < 5; i++) {
      const lock = await acquireLock(path, { timeoutMs: 100 })
      expect(lock).not.toBeNull()
      lock!.release()
    }
  })

  it("concurrent acquirers serialize: only one progresses at a time", async () => {
    const path = join(tmpDir, "ser.lock")
    const events: string[] = []
    const work = async (label: string): Promise<void> => {
      const lock = await acquireLock(path, { timeoutMs: 1000, pollMs: 5 })
      if (!lock) {
        events.push(`${label}-TIMEOUT`)
        return
      }
      events.push(`${label}-acquired`)
      await new Promise((r) => setTimeout(r, 20))
      events.push(`${label}-released`)
      lock.release()
    }

    await Promise.all([work("A"), work("B"), work("C")])

    // Each label's "acquired" must be immediately followed by its
    // "released" (no other label's acquire interleaves) — proving
    // exclusive access.
    for (let i = 0; i < events.length; i += 2) {
      const acq = events[i]
      const rel = events[i + 1]
      expect(acq.endsWith("-acquired")).toBe(true)
      expect(rel.endsWith("-released")).toBe(true)
      expect(acq.split("-")[0]).toBe(rel.split("-")[0])
    }
  })
})
