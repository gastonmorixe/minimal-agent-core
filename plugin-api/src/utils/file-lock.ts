/**
 * file-lock.ts : Cooperative file locking for concurrent agents.
 *
 * When multiple cooperating agents share a worktree (the same directory tree
 * mounted into multiple sessions / processes / hosts), concurrent Edit/Write
 * to the same file produces lost-write races: agent A reads C0, agent B reads
 * C0, both compute new content, both write : last writer wins, the first
 * edit is silently lost.
 *
 * This module provides a sibling-lock-file mechanism that gives every cooperating
 * Edit/Write a brief exclusive section around its read-modify-write. The lock
 * is a sibling file `<filePath>.locked` containing JSON metadata about the
 * holder; concurrent acquirers wait with backoff up to a deadline.
 *
 * **Design properties:**
 *
 * - **Atomic creation** via `O_CREAT | O_EXCL` (`openSync(path, "wx")`). POSIX
 *   primitive that succeeds on exactly one of N concurrent creators.
 * - **Held briefly.** The lock spans the body of `execEdit` / `execWrite` only
 *   : typically under 100ms. There is no notion of "lock for the whole turn".
 * - **Self-healing.** Stale locks (holder PID dead OR holder lock older than
 *   `staleAfterMs`) are auto-broken on the next acquire attempt. Three crash
 *   safety layers: (a) `try/finally` always releases on tool exit, (b) a
 *   process exit hook unlinks any locks we still hold on graceful shutdown,
 *   (c) PID-based stale detection breaks locks left by SIGKILL'd processes.
 * - **Cooperative, not enforcing.** Agents that bypass Edit/Write (e.g. raw
 *   Bash `sed -i`) are not protected. The lock is a coordination token among
 *   peers who agree to honor it.
 * - **Test seams.** Time, PID-aliveness, hostname, and sleep are all
 *   injectable so unit tests can simulate contention, stale locks, and time
 *   passing without real wall-clock waits.
 *
 * **Lock file format** (single-line JSON, atomic-ish read; partial-write parses
 * to null and is treated as stale):
 *
 * ```json
 * {"v":1,"harness":"minimal-agent","sessionId":"d07a1090-...",
 *  "pid":12345,"host":"MacBook-Pro.local","tool":"Edit",
 *  "callId":"toolu_01abc","filePath":"/abs/foo.ts",
 *  "acquiredAt":"2026-05-10T05:45:30-04:00","acquiredAtMs":1715332530123}
 * ```
 *
 * **Companion plugin**: `plugins/file-lock/` ships a `LockStatus` tool and
 * CLI for human-and-model inspection, plus opt-out via
 * `plugins["file-lock"].enabled = false` in `~/.minimal-agent/config.jsonc`.
 *
 * @module file-lock
 */

import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { hostname } from "node:os"
import { dirname, join } from "node:path"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Lock file format version. Bump on any incompatible change to the holder shape. */
export const LOCK_FORMAT_VERSION = 1

/** Suffix appended to the locked file's path. `<file>.locked`. */
export const LOCK_SUFFIX = ".locked"

/** Default acquire deadline (30 s). */
export const DEFAULT_TIMEOUT_MS = 30_000

/** Default age beyond which a lock is treated as stale (5 min). */
export const DEFAULT_STALE_AFTER_MS = 5 * 60_000

/** Default backoff schedule for retrying contended acquires. Last entry repeats. */
export const DEFAULT_BACKOFF_MS: readonly number[] = [50, 100, 200, 400, 800, 1000]

/** Identifies us in the holder's `harness` field. */
export const HARNESS_NAME = "minimal-agent"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Metadata serialized into the lock file. Single-line JSON keeps the read
 * side reasonably atomic on local filesystems (one inode, one buffer).
 */
export interface LockHolder {
  /** Format version. Currently 1. */
  v: number
  /** Source harness, e.g. `"minimal-agent"`. Lets cross-harness peers identify us. */
  harness: string
  /** The agent's session id (UUID). Same as `getSessionId()`. */
  sessionId: string
  /** OS process id of the holder. Combined with `host` it uniquely identifies a process. */
  pid: number
  /** The holder's hostname. Lets stale-detection skip PID probes across hosts. */
  host: string
  /** Tool that acquired the lock, e.g. `"Edit"` or `"Write"`. */
  tool: string
  /** Optional API tool_use id; surfaces in error messages and "stolen lock" diagnostics. */
  callId?: string
  /** Absolute path of the locked file (the lock file itself is `<filePath>.locked`). */
  filePath: string
  /** ISO timestamp at acquire time. Human-readable diagnostic. */
  acquiredAt: string
  /** Milliseconds since epoch at acquire time. Authoritative for age math. */
  acquiredAtMs: number
}

/** Tunables for {@link acquireLock}. Most callers use the defaults. */
export interface LockOpts {
  /** Total wait deadline before giving up. Default {@link DEFAULT_TIMEOUT_MS}. */
  timeoutMs?: number
  /** Locks older than this are stale by time. Default {@link DEFAULT_STALE_AFTER_MS}. */
  staleAfterMs?: number
  /** Backoff schedule for retries. Last value repeats. Default {@link DEFAULT_BACKOFF_MS}. */
  backoffMs?: readonly number[]
  /** Aborts a pending acquire. Throws {@link LockAbortedError}. */
  signal?: AbortSignal
  /** Test seam: time provider. Default `Date.now`. */
  now?: () => number
  /** Test seam: PID liveness probe. Default uses `process.kill(pid, 0)`. */
  pidAlive?: (pid: number) => boolean
  /** Test seam: hostname source. Default `os.hostname()`. */
  hostname?: () => string
  /** Test seam: sleep with abort. Default `setTimeout` + AbortSignal. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** Returned from a successful {@link acquireLock}. `release()` is idempotent. */
export interface LockHandle {
  /** The protected file. */
  filePath: string
  /** The lock sibling (`<filePath>.locked`). */
  lockPath: string
  /** Holder metadata that was written to disk. */
  holder: LockHolder
  /**
   * Release the lock. Idempotent and best-effort: no-op when the lock file
   * is already gone, refuses to unlink when the file's holder no longer
   * matches us (someone broke the lock and now owns it).
   */
  release: () => void
  /**
   * Disposable support for `using` syntax.
   */
  [Symbol.dispose]: () => void
}

/**
 * Thrown by {@link acquireLock} when the deadline is reached without a
 * successful create. The error message is human-readable and lists the
 * holder's session/pid/host so the model or user can decide to retry,
 * inspect, or break the lock.
 */
export class LockTimeoutError extends Error {
  constructor(
    public filePath: string,
    public lockPath: string,
    public holder: LockHolder | null,
    public waitedMs: number,
    public ourNow: () => number,
  ) {
    super(formatTimeoutMessage(filePath, holder, waitedMs, ourNow))
    this.name = "LockTimeoutError"
  }
}

/** Thrown by {@link acquireLock} when its `signal` aborts during a wait. */
export class LockAbortedError extends Error {
  constructor(public filePath: string) {
    super(`Lock acquire aborted for ${filePath}`)
    this.name = "LockAbortedError"
  }
}

// ---------------------------------------------------------------------------
// Lock path / serialization
// ---------------------------------------------------------------------------

/** Compute the sibling lock path for a given file path. */
export function lockPathFor(filePath: string): string {
  return filePath + LOCK_SUFFIX
}

/** Serialize a holder for the lock file. Single-line JSON + trailing newline. */
export function serializeHolder(h: LockHolder): string {
  return JSON.stringify(h) + "\n"
}

/**
 * Parse a holder file's text. Returns `null` for any malformed input :
 * empty, non-JSON, missing required fields, wrong types. The caller treats
 * `null` as "lock is corrupt → stale → break it".
 */
export function parseHolder(text: string): LockHolder | null {
  try {
    const trimmed = text.trim()
    if (!trimmed) return null
    const obj = JSON.parse(trimmed)
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null
    const o = obj as Record<string, unknown>
    if (typeof o.pid !== "number") return null
    if (typeof o.acquiredAtMs !== "number") return null
    if (typeof o.sessionId !== "string") return null
    if (typeof o.host !== "string") return null
    if (typeof o.harness !== "string") return null
    if (typeof o.filePath !== "string") return null
    if (typeof o.acquiredAt !== "string") return null
    if (typeof o.tool !== "string") return null
    return o as unknown as LockHolder
  } catch {
    return null
  }
}

/**
 * Build a fresh holder for the calling process. Caller supplies the
 * session id (from `metadata.getSessionId()` in production) and the tool
 * name; the rest is read from `process` + `os`.
 */
export function buildHolder(args: {
  sessionId: string
  tool: string
  filePath: string
  callId?: string
  harness?: string
  host?: string
  now?: () => number
}): LockHolder {
  const nowMs = (args.now ?? Date.now)()
  return {
    v: LOCK_FORMAT_VERSION,
    harness: args.harness ?? HARNESS_NAME,
    sessionId: args.sessionId,
    pid: process.pid,
    host: args.host ?? hostname(),
    tool: args.tool,
    callId: args.callId,
    filePath: args.filePath,
    acquiredAt: new Date(nowMs).toISOString(),
    acquiredAtMs: nowMs,
  }
}

// ---------------------------------------------------------------------------
// Stale detection
// ---------------------------------------------------------------------------

/** Inputs to {@link isStaleLock}. Time, PID probe, and our hostname are injectable for tests. */
export interface IsStaleArgs {
  staleAfterMs: number
  ourHost: string
  pidAlive: (pid: number) => boolean
  now: () => number
}

/**
 * Decide whether an existing holder is stale and may be unlinked by the
 * caller before retry. Two independent signals:
 *
 * 1. **Same-host PID probe.** If the holder claims to be on our host and
 *    the PID isn't alive (`process.kill(pid, 0)` → ESRCH), the holder
 *    process died without releasing.
 * 2. **Time threshold.** If the holder is older than `staleAfterMs`,
 *    treat as stale regardless of PID. Catches alive-but-wedged holders
 *    AND cross-host holders we can't probe.
 */
export function isStaleLock(
  holder: LockHolder,
  args: IsStaleArgs,
): { stale: boolean; reason?: string } {
  if (holder.host === args.ourHost) {
    if (!args.pidAlive(holder.pid)) {
      return { stale: true, reason: `holder pid ${holder.pid} not alive on this host` }
    }
  }
  const age = args.now() - holder.acquiredAtMs
  if (age > args.staleAfterMs) {
    return {
      stale: true,
      reason: `holder is ${Math.round(age / 1000)}s old (>${Math.round(args.staleAfterMs / 1000)}s threshold)`,
    }
  }
  return { stale: false }
}

/** Default same-host PID probe. ESRCH → not alive; EPERM → alive but unsignalable. */
export function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    // EPERM: process exists but we can't signal it. Treat as alive.
    return true
  }
}

// ---------------------------------------------------------------------------
// Single-attempt acquire (no waiting)
// ---------------------------------------------------------------------------

/** One attempt to create the lock file atomically. */
export type TryResult =
  | { ok: true; handle: LockHandle }
  | { ok: false; reason: "exists"; existing: LockHolder | null }
  | { ok: false; reason: "io"; err: Error }

/**
 * Attempt to atomically create the lock file with the given holder content.
 *
 * - Returns `{ok: true, handle}` if we won the create.
 * - Returns `{ok: false, reason: "exists", existing}` on EEXIST. `existing`
 *   is the parsed holder (or `null` when the file is corrupt : caller treats
 *   that as stale).
 * - Returns `{ok: false, reason: "io", err}` for any other filesystem error.
 *
 * The handle's `release` is conservative: it re-reads the lock and refuses
 * to unlink when the holder no longer matches (someone broke ours and now
 * owns it). Release is idempotent.
 */
export function tryAcquireOnce(
  filePath: string,
  holder: LockHolder,
  opts: { onRelease?: (lockPath: string) => void } = {},
): TryResult {
  const lockPath = lockPathFor(filePath)
  // Ensure the parent dir exists. `Write` may target a file under a not-yet-
  // -created directory; without this the lock create would race ahead of the
  // executor's own `mkdirSync`.
  try {
    mkdirSync(dirname(lockPath), { recursive: true })
  } catch (e) {
    // ENOENT/EACCES on mkdir → bubble as IO; openSync below will likely
    // fail too with the same root cause.
    return { ok: false, reason: "io", err: e as Error }
  }
  let fd: number | null = null
  try {
    fd = openSync(lockPath, "wx")
    writeFileSync(fd, serializeHolder(holder))
    closeSync(fd)
    fd = null
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      try {
        const cur = readLockFile(lockPath)
        if (
          cur === null ||
          (cur.sessionId === holder.sessionId &&
            cur.pid === holder.pid &&
            cur.acquiredAtMs === holder.acquiredAtMs)
        ) {
          // Ours (or corrupt remnant of ours). Safe to unlink.
          unlinkSync(lockPath)
        }
        // else: someone broke our lock and reacquired. Don't smash theirs.
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === "ENOENT") {
          // Already gone. That's the desired post-state.
        }
        // Other errors are swallowed : release is best-effort, the next
        // acquirer's stale-detection will heal anything we leave behind.
      }
      opts.onRelease?.(lockPath)
    }
    return {
      ok: true,
      handle: {
        filePath,
        lockPath,
        holder,
        release,
        [Symbol.dispose]() {
          release()
        },
      },
    }
  } catch (e) {
    if (fd !== null) {
      try {
        closeSync(fd)
      } catch {
        // ignore
      }
    }
    const err = e as NodeJS.ErrnoException
    if (err.code === "EEXIST") {
      const existing = readLockFile(lockPath)
      return { ok: false, reason: "exists", existing }
    }
    return { ok: false, reason: "io", err }
  }
}

/** Read+parse the lock file. Returns null on missing OR malformed. */
export function readLockFile(lockPath: string): LockHolder | null {
  try {
    const text = readFileSync(lockPath, "utf-8")
    return parseHolder(text)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Process-wide cleanup
// ---------------------------------------------------------------------------

/**
 * Set of lock paths the current process currently holds. Populated on
 * acquire, cleared on release. The exit hook walks this set on
 * `exit`/SIGINT/SIGTERM and unlinks anything left behind, so a tidy
 * shutdown doesn't leave PID-stale locks for the next acquirer to break.
 *
 * NOTE: `process.on("exit", ...)` only runs on graceful exit. SIGKILL,
 * OOM, and kernel panics bypass it : those are handled by the next
 * acquirer's PID-based stale detection (layer 3).
 */
const heldLocks = new Set<string>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const cleanup = (): void => {
    for (const lockPath of heldLocks) {
      try {
        unlinkSync(lockPath)
      } catch {
        // ignore : best-effort
      }
    }
    heldLocks.clear()
  }
  process.on("exit", cleanup)
  // SIGINT/SIGTERM: cleanup, then re-raise (exit hook also fires).
  // We don't override behavior : just add cleanup. If anyone else has
  // a handler, theirs runs too. We use exit codes 130/143 (POSIX
  // convention for SIGINT/SIGTERM) when no other handler exits first.
  process.on("SIGINT", () => {
    cleanup()
    process.exit(130)
  })
  process.on("SIGTERM", () => {
    cleanup()
    process.exit(143)
  })
}

/** Test seam: forget the exit hook. NOT safe in production. */
export function _resetForTests(): void {
  heldLocks.clear()
  exitHookInstalled = false
}

/** Test seam: peek at held-locks set. */
export function _heldLocksSnapshot(): string[] {
  return [...heldLocks]
}

// ---------------------------------------------------------------------------
// Sleep
// ---------------------------------------------------------------------------

/** Default sleep: setTimeout + abort listener. Resolves on time, rejects on abort. */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LockAbortedError(""))
      return
    }
    const t = setTimeout(() => {
      if (onAbort) signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new LockAbortedError(""))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

// ---------------------------------------------------------------------------
// Wait + retry acquire (the public path)
// ---------------------------------------------------------------------------

/**
 * Acquire an exclusive lock on `filePath`, waiting with backoff until
 * success or deadline.
 *
 * Algorithm:
 *
 * 1. Try to atomically create `<filePath>.locked` (`O_CREAT | O_EXCL`).
 * 2. On EEXIST: read the existing holder.
 *    - If the file is corrupt → break it, retry.
 *    - If our own session+pid → reentrant, return a no-op handle.
 *    - If holder is stale (PID dead OR age exceeds `staleAfterMs`) → break
 *      it, retry.
 *    - Otherwise → backoff sleep, retry. After the deadline, throw
 *      {@link LockTimeoutError}.
 * 3. On other IO error: bubble.
 *
 * The returned handle's `release()` is idempotent and refuses to unlink a
 * lock that someone else broke and now owns (defense against silently
 * smashing a peer's lock during a race).
 *
 * The `args` record carries the holder identity (`sessionId`, `tool`, and
 * optional `callId` / `harness`) written into the lock file; `opts` carries
 * tunables and test seams.
 *
 * @param filePath - absolute path of the file to be edited / written
 */
export async function acquireLock(
  filePath: string,
  args: { sessionId: string; tool: string; callId?: string; harness?: string },
  opts: LockOpts = {},
): Promise<LockHandle> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const staleAfterMs = opts.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  const backoff = opts.backoffMs ?? DEFAULT_BACKOFF_MS
  const now = opts.now ?? Date.now
  const pidAlive = opts.pidAlive ?? defaultPidAlive
  const hostFn = opts.hostname ?? ((): string => hostname())
  const sleep = opts.sleep ?? defaultSleep
  const ourHost = hostFn()
  const startMs = now()
  const deadline = startMs + timeoutMs

  installExitHook()

  let attempt = 0
  let lastExisting: LockHolder | null = null
  while (true) {
    if (opts.signal?.aborted) throw new LockAbortedError(filePath)
    const holder = buildHolder({
      sessionId: args.sessionId,
      tool: args.tool,
      filePath,
      callId: args.callId,
      harness: args.harness,
      host: ourHost,
      now,
    })
    const result = tryAcquireOnce(filePath, holder, {
      onRelease: (lp) => heldLocks.delete(lp),
    })
    if (result.ok) {
      heldLocks.add(result.handle.lockPath)
      return result.handle
    }
    if (result.reason === "io") {
      throw result.err
    }
    // reason === "exists"
    lastExisting = result.existing
    if (lastExisting === null) {
      // EEXIST + corrupt content → break and retry. Don't sleep; this is
      // not contention, just garbage we need to clear.
      //
      // TOCTOU guard: only unlink if the lock file on disk is STILL
      // corrupt/missing (matches the `null` we observed). A peer may have
      // already broken this corrupt lock and reacquired it with a valid
      // holder between our read and now; unlinking unconditionally would
      // clobber their fresh lock. If the re-read parses to a real holder,
      // skip the unlink and just retry the wx-create (which will EEXIST
      // against the new holder and fall through to normal contention).
      if (readLockFile(lockPathFor(filePath)) === null) {
        try {
          unlinkSync(lockPathFor(filePath))
        } catch {
          // ignore : next attempt will still see it; we'll retry
        }
      }
      continue
    }
    // Same-session + same-pid reentrancy. Should be vanishingly rare in
    // this agent (single-threaded tool dispatch), but guard against the
    // self-deadlock that would otherwise occur.
    if (
      lastExisting.sessionId === args.sessionId &&
      lastExisting.pid === process.pid &&
      lastExisting.host === ourHost
    ) {
      return {
        filePath,
        lockPath: lockPathFor(filePath),
        holder: lastExisting,
        release: () => {
          // No-op: we're piggy-backing on a pre-existing lock owned by us;
          // the original holder's `release` will clean it up. Calling
          // unlink here would yank the lock out from under the original
          // holder.
        },
        [Symbol.dispose]() {
          // No-op
        },
      }
    }
    const stale = isStaleLock(lastExisting, { staleAfterMs, ourHost, pidAlive, now })
    if (stale.stale) {
      // TOCTOU guard: only break the lock if the file on disk STILL matches
      // the exact stale holder we observed (identity tuple: pid +
      // acquiredAtMs + host + sessionId). Race: two peers can both read the
      // same stale holder C and both decide "stale". If peer B unlinks C and
      // wins the wx-create first (B now legitimately holds a FRESH lock), an
      // unconditional unlink here would smash B's live lock and let both A
      // and B believe they hold it : exactly the lost-write race the lock
      // exists to prevent. Re-read immediately before unlinking; if the
      // holder no longer matches (someone already broke + reacquired), do NOT
      // unlink : just retry the wx-create, which will EEXIST against the new
      // holder and fall through to normal contention/backoff.
      const reread = readLockFile(lockPathFor(filePath))
      if (
        reread !== null &&
        reread.pid === lastExisting.pid &&
        reread.acquiredAtMs === lastExisting.acquiredAtMs &&
        reread.host === lastExisting.host &&
        reread.sessionId === lastExisting.sessionId
      ) {
        try {
          unlinkSync(lockPathFor(filePath))
        } catch {
          // ignore
        }
      }
      continue
    }
    // Genuine contention.
    const remaining = deadline - now()
    if (remaining <= 0) {
      throw new LockTimeoutError(
        filePath,
        lockPathFor(filePath),
        lastExisting,
        now() - startMs,
        now,
      )
    }
    const baseSleep = backoff[Math.min(attempt, backoff.length - 1)] ?? 1000
    attempt++
    const sleepMs = Math.min(baseSleep, remaining)
    try {
      await sleep(sleepMs, opts.signal)
    } catch (e) {
      if (e instanceof LockAbortedError) throw new LockAbortedError(filePath)
      throw e
    }
  }
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function formatTimeoutMessage(
  filePath: string,
  holder: LockHolder | null,
  waitedMs: number,
  now: () => number,
): string {
  const waited = (waitedMs / 1000).toFixed(1)
  if (!holder) {
    return `File ${filePath} is locked (waited ${waited}s); current holder unknown (lock file unreadable).`
  }
  const ageS = Math.round((now() - holder.acquiredAtMs) / 1000)
  return [
    `File ${filePath} is locked (waited ${waited}s).`,
    `Holder: ${holder.harness} session=${holder.sessionId} pid=${holder.pid} host=${holder.host}`,
    `Tool: ${holder.tool}. Held since ${holder.acquiredAt} (${ageS}s ago).`,
    `Inspect with the LockStatus tool, or wait and retry.`,
  ].join("\n")
}

// ---------------------------------------------------------------------------
// Inventory: list locks under a directory
// ---------------------------------------------------------------------------

/** A located lock file plus its parsed holder (or null if corrupt). */
export interface ListedLock {
  /** Absolute path to the .locked file. */
  lockPath: string
  /** Absolute path to the protected file (lockPath without `.locked`). */
  filePath: string
  /** Parsed holder, or `null` if the lock file is corrupt / unreadable. */
  holder: LockHolder | null
}

/**
 * Recursively walk `rootDir` and return every `*.locked` file found.
 *
 * Skips common heavy directories (`node_modules`, `.git`, `dist`, `build`,
 * `.cache`) so a worktree-wide list stays fast. The skip list is
 * conservative : locks under those dirs would still be honored by acquire,
 * we just don't surface them in inventory walks.
 */
export function listLocksUnder(rootDir: string): ListedLock[] {
  const SKIP = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".cache",
    ".net-dbg",
    ".node-net-dbg",
  ])
  const out: ListedLock[] = []
  const walk = (dir: string): void => {
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue
        walk(full)
      } else if (e.isFile() && e.name.endsWith(LOCK_SUFFIX)) {
        const filePath = full.slice(0, -LOCK_SUFFIX.length)
        const holder = readLockFile(full)
        out.push({ lockPath: full, filePath, holder })
      }
    }
  }
  walk(rootDir)
  return out
}
