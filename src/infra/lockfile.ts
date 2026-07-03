/**
 * Cross-process advisory lock via atomic file create.
 *
 * The credential store provides no cross-process coordination of its own:
 * an individual read or write is atomic, but a "read → think → write"
 * sequence straddles the boundary and races against concurrent
 * readers/writers in other processes.
 *
 * For minimal-agent's OAuth refresh path this matters: with N agents
 * sharing one credential, refresh-token rotation makes every successful
 * refresh by ANY process invalidate the access tokens cached by the
 * OTHER N-1. Without coordination they all 401, all refresh in parallel,
 * and the storm never settles. See
 * `docs/changes/2026-05-10-fix-auth-refresh-storm.md` for the full diagnosis.
 *
 * This module is the coordination layer. We use the well-worn lockfile
 * pattern:
 *
 *   1. Acquire by `fs.openSync(path, "wx")` — the `wx` flag combines
 *      `O_CREAT|O_EXCL`, which is atomic at the kernel level. If the
 *      file already exists the call fails with `EEXIST`, otherwise we
 *      own the lock.
 *   2. Write the holder's PID into the file. On EEXIST in another
 *      process, the loser reads the PID and probes liveness via
 *      `process.kill(pid, 0)`. If `kill(2)` says the holder is gone
 *      (`ESRCH`) the lock is stale; we remove the file and retry.
 *      `EPERM` ("exists but we can't signal") still counts as alive.
 *   3. Release by `unlinkSync(path)`. The cleanup hook below also runs
 *      on `exit` / `SIGINT` / `SIGTERM` / `SIGHUP` so a Ctrl-C never
 *      leaves a stale lock for the next agent to clean up.
 *
 * Hard timeout: callers specify `timeoutMs` (default 5000). If we can't
 * acquire within that window — typical worst case: the lock holder is
 * spending 4+ seconds on a slow OAuth round-trip — the function returns
 * `null` so the caller can fall through to a "do the work without
 * coordination" path. Better to thrash than block forever.
 *
 * Caveats:
 *   - PID-reuse aliasing: if the original lock holder dies and the OS
 *     recycles its PID before we probe, we'll read the lockfile and
 *     conclude the (different) process is alive. In practice the
 *     window is small enough to ignore, but it's documented here so
 *     future readers don't think it's a bug.
 *   - NFS / network filesystems do not honor `O_EXCL` reliably across
 *     hosts. We assume a local filesystem (`~/.minimal-agent/`) which
 *     is always macOS APFS or Linux ext4 / btrfs in practice.
 *
 * @module lockfile
 */

import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { dirname } from "node:path"

// ---------------------------------------------------------------------------
// Cleanup tracking
// ---------------------------------------------------------------------------

/**
 * Lockfile paths we currently hold. Tracked so the process-wide signal
 * handlers can release everything on abnormal exit. We deliberately do
 * NOT use a `finalization registry` — the cleanup must run on signals,
 * which `WeakRef`-style finalizers don't catch.
 */
const HELD_LOCKS = new Set<string>()

let cleanupHooksInstalled = false

function installCleanupHooks(): void {
  if (cleanupHooksInstalled) return
  cleanupHooksInstalled = true

  const releaseAll = (): void => {
    for (const path of HELD_LOCKS) {
      try {
        unlinkSync(path)
      } catch {
        // best-effort
      }
    }
    HELD_LOCKS.clear()
  }

  // `exit` runs synchronously — no `await` allowed but `unlinkSync` is fine.
  process.on("exit", releaseAll)

  // Signals: release THEN exit with the conventional code so parent shells
  // see the right termination status. `process.kill(0, sig)` to ourselves
  // would also work but we prefer explicit `exit(128 + n)` for clarity.
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const) {
    process.on(signal, () => {
      releaseAll()
      process.exit(code)
    })
  }
}

// ---------------------------------------------------------------------------
// Liveness probe
// ---------------------------------------------------------------------------

/**
 * Return `true` if `pid` looks alive on this host.
 *
 * Implementation: `process.kill(pid, 0)` sends signal 0, which performs
 * the permission/existence check WITHOUT actually delivering a signal.
 * Three relevant outcomes:
 *
 *   - returns normally → process exists and we're allowed to signal it.
 *   - throws `ESRCH`   → no such process, dead.
 *   - throws `EPERM`   → exists but we lack signal permission (running
 *                        as a different user). Still counts as alive.
 *
 * Any other error (rare) we treat as alive too — refusing to clobber an
 * unfamiliar lock is the safer default.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH"
  }
}

// ---------------------------------------------------------------------------
// Acquire / release primitives
// ---------------------------------------------------------------------------

export interface LockOptions {
  /** Maximum time to wait before giving up. Default 5000ms. */
  timeoutMs?: number
  /** Mean poll interval between acquire attempts. Jitter ±50% applied. Default 30ms. */
  pollMs?: number
}

export interface LockHandle {
  /** Idempotent. Calling `release()` twice (or after exit cleanup) is fine. */
  release(): void
}

interface LockingDeps {
  /** Inject Date.now for tests that want to drive the timeout deterministically. */
  now?: () => number
  /** Inject a sleep fn (tests use a fake-clock awaitable). */
  sleep?: (ms: number) => Promise<void>
  /** Inject the alive-check (tests pretend a synthetic PID is dead). */
  isAlive?: (pid: number) => boolean
}

/**
 * Try once to acquire the lock at `path`. Returns `true` on success,
 * `false` if the lock is currently held (by us or anyone else).
 *
 * Acquisition uses the **temp-file + link** pattern, NOT a bare
 * `openSync(path, "wx")` write. The naive pattern has a real race:
 *
 *     1. P_A: openSync(path, "wx") succeeds   — path now exists, EMPTY
 *     2. P_B: openSync(path, "wx") fails EEXIST — readFileSync sees ""
 *     3. P_B: parseInt("") = NaN → "stale", unlinkSync(path)
 *     4. P_A: writeSync(pid) → goes to a now-deleted file
 *     5. P_C: openSync(path, "wx") succeeds AGAIN — both A and C "hold"
 *
 * The window between step 1 and step 4 is microseconds, but with 100s
 * of agents racing on every 401 it's hit reliably. The fix is to:
 *
 *     a. Write the PID to a unique temp file (no contention).
 *     b. `link(tmp, path)` — atomic: either creates `path` pointing to
 *        the same inode (with our PID already present), or fails EEXIST
 *        without ever showing readers a partial state.
 *     c. Unlink the temp file (the inode persists via `path`).
 *
 * On EEXIST we read the holder's PID; if dead, we remove the stale lock
 * (caller's next poll retries). An empty/malformed `path` means
 * something corrupted it on a non-link-using lockfile implementation —
 * we treat that as stale too (better to reclaim than block forever).
 */
function tryAcquire(path: string, deps: LockingDeps): boolean {
  // Step a: write our PID into a uniquely-named temp file. We pick a
  // name that's monotonic-ish (`Date.now()`) plus random suffix so
  // concurrent acquirers from the same process (rare in practice but
  // possible in tests) don't collide.
  const tmpSuffix = `.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}`
  const tmpPath = `${path}${tmpSuffix}`
  // Temp file collision is essentially impossible given the random suffix;
  // any ENOENT/EACCES surfaces to the caller (the parent dir was already
  // mkdir'd in acquireLock), which is the right error-handling behavior
  // (don't swallow real failures).
  const fd = openSync(tmpPath, "wx")
  try {
    writeSync(fd, String(process.pid))
  } finally {
    try {
      closeSync(fd)
    } catch {
      // already closed
    }
  }

  // Step b: atomic link. Success → path exists with our PID already in
  // place. Failure → someone else holds it.
  let linked = false
  try {
    linkSync(tmpPath, path)
    linked = true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      // Cleanup tmp before propagating the unexpected error.
      try {
        unlinkSync(tmpPath)
      } catch {
        // ignore
      }
      throw err
    }
  }

  // Step c: regardless of link outcome, the temp file is no longer
  // needed (linked → path holds the inode; not linked → tmp is just
  // garbage we should remove).
  try {
    unlinkSync(tmpPath)
  } catch {
    // ignore — another exit path may have unlinked it
  }

  if (linked) {
    HELD_LOCKS.add(path)
    return true
  }

  // EEXIST path: probe the holder's liveness.
  let holderPid = Number.NaN
  try {
    const raw = readFileSync(path, "utf-8").trim()
    holderPid = Number.parseInt(raw, 10)
  } catch {
    // The lock file disappeared between linkSync and readFileSync — the
    // holder must have just released. Treat as still-held; next poll
    // iteration will succeed on linkSync.
    return false
  }
  const alive = (deps.isAlive ?? isProcessAlive)(holderPid)
  if (!alive) {
    // Stale (PID dead OR malformed PID, both reachable here): remove
    // and let the next poll claim it. Best-effort unlink — another
    // process may already be cleaning up.
    try {
      unlinkSync(path)
    } catch {
      // ignore
    }
  }
  return false
}

/**
 * Wait up to `opts.timeoutMs` for the lock at `path`. Returns a
 * {@link LockHandle} on success or `null` on timeout.
 *
 * The directory containing `path` is created (recursively) on first
 * acquire so callers don't have to pre-create `~/.minimal-agent/` etc.
 */
export async function acquireLock(
  path: string,
  opts: LockOptions = {},
  deps: LockingDeps = {},
): Promise<LockHandle | null> {
  installCleanupHooks()

  // mkdir parent dir best-effort. EEXIST is fine; anything else surfaces
  // as the openSync error below, which is more informative anyway.
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch {
    // ignore
  }

  const timeoutMs = opts.timeoutMs ?? 5000
  const pollMs = opts.pollMs ?? 30
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  const deadline = now() + timeoutMs
  while (true) {
    if (tryAcquire(path, deps)) {
      return {
        release(): void {
          if (!HELD_LOCKS.has(path)) return
          try {
            unlinkSync(path)
          } catch {
            // already gone
          }
          HELD_LOCKS.delete(path)
        },
      }
    }
    if (now() >= deadline) return null
    // Jittered poll: 50%-150% of pollMs. Reduces thundering-herd when
    // many processes wake at the same tick.
    const jittered = pollMs * (0.5 + Math.random())
    const remaining = deadline - now()
    await sleep(Math.min(jittered, Math.max(0, remaining)))
  }
}

/**
 * Run `fn` with the lock held. Convenience wrapper around
 * {@link acquireLock} with guaranteed release on any exit path.
 *
 * Returns `{ ok: true, value }` on success, `{ ok: false, reason: "timeout" }`
 * if the lock couldn't be acquired within the timeout. The caller decides
 * what to do on timeout — typically fall through to an unlocked variant
 * of the same operation (fewer guarantees, but progress).
 */
export async function withLock<T>(
  path: string,
  opts: LockOptions | undefined,
  fn: () => Promise<T> | T,
  deps?: LockingDeps,
): Promise<{ ok: true; value: T } | { ok: false; reason: "timeout" }> {
  const handle = await acquireLock(path, opts, deps)
  if (!handle) return { ok: false, reason: "timeout" }
  try {
    const value = await fn()
    return { ok: true, value }
  } finally {
    handle.release()
  }
}

/**
 * Internal: clear the held-locks set. Used only by tests that want to
 * simulate a process restart (where the cleanup hooks haven't run yet).
 *
 * @internal
 */
export function _resetLocksForTest(): void {
  HELD_LOCKS.clear()
}
