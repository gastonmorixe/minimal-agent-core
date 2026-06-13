/**
 * Per-session submitted-but-undrained queue persistence.
 *
 * The REPL's submit queue (`runReplLiveArea` in `./agent/repl-live-area.ts`)
 * holds prompts the user pressed Enter on while a previous turn was still
 * in flight. The queue is plain in-memory state, so until each item gets
 * picked up by the agent loop (either at fresh-turn start or via the
 * `drainQueuedUserText` tool-boundary injection, both of which finally
 * call `SessionStore.appendUser`), it lives nowhere but RAM. A crash or
 * even a clean Ctrl+C drops every queued submit on the floor.
 *
 * `QueueStore` persists the queue to a sibling `<sid>.queue` JSON file on
 * every mutation so the items survive process exit and can be replayed at
 * the top of the next `--resume <sid>` (or whenever a process attaches to
 * the same sid). The mechanism is intentionally similar to
 * {@link DraftStore} so the two files cluster together under the same
 * session directory and clean up the same way (`rm <sid>*`).
 *
 * Why a full snapshot (not append-only JSONL)?
 *   - The queue is small (typically under 20 items). Rewriting the whole file
 *     on each push/shift is ~1 KiB, well under the cost of an append +
 *     periodic compaction.
 *   - Persisted state is "what's currently pending"; an append-only log
 *     would need consumed markers + replay logic to derive the same
 *     state, which is more code for no observable benefit.
 *   - Snapshot + atomic rename matches DraftStore byte-for-byte and reuses
 *     the same crash-safety argument.
 *
 * Race window:
 *   - On `queue.shift()` we persist the shorter queue BEFORE the agent's
 *     `appendUser` call lands in the JSONL log. A hard crash in that
 *     micro-window (typically a few microseconds; both calls run on the
 *     same synchronous tick) can lose the shifted item. Accepted: the
 *     pre-change behavior loses EVERY queued item on every exit, and a
 *     transaction-style fix would require coupling the queue file to the
 *     JSONL log atomically.
 *
 * On-disk format:
 *   - JSON-encoded array of `{text, commitLines}` items, UTF-8, no BOM,
 *     no trailing newline. An empty queue deletes the file (so a stale
 *     queue file from a prior session does not survive a clean drain).
 *
 * Errors:
 *   - All write failures are swallowed and reported via the optional
 *     `logger` dep. The REPL never blocks on the queue store.
 *
 * @module queue-store
 */

import { readFileSync } from "node:fs"
import { rename, rm } from "node:fs/promises"
import { join } from "node:path"

import { defaultSessionsDir } from "./session-store.ts"

/**
 * One persisted queue item. Mirrors the in-memory `QueueItem` shape used
 * by `runReplLiveArea` (`{text, commitLines}`) but with a shape-checked
 * loader that tolerates legacy/garbled files by filtering out malformed
 * entries instead of throwing.
 */
export type QueueItem = {
  /** User's submit text. Never empty in practice; loader filters out empties. */
  text: string
  /** Pre-rendered scrollback lines to commit at drain time. May be empty. */
  commitLines: string[]
}

/**
 * Returns the on-disk path for a session's queue file.
 *
 * @param sid - Session id (UUID, same as the `<sid>.jsonl` log)
 * @param dir - Sessions directory (defaults to `~/.minimal-agent/sessions/`)
 */
export function queueFilePath(sid: string, dir: string = defaultSessionsDir()): string {
  return join(dir, `${sid}.queue`)
}

/**
 * Synchronously load a session's persisted queue from disk.
 *
 * Returns `[]` when no queue file exists (the common case: clean exit, or
 * a session that never queued anything mid-turn). Returns `[]` on any read
 * or parse error — the queue is best-effort, never blocks startup, and a
 * corrupted file is equivalent to no file from the user's perspective.
 *
 * Filters entries to the shape `{text: string, commitLines: string[]}` and
 * drops items with empty text (synthetic zero-text items pushed by the
 * Alt+M mode-only path are not meaningful on restore, since the pending
 * mode state from the prior session no longer exists).
 *
 * Used at REPL startup to seed the in-memory queue with leftover submits
 * from the previous session.
 *
 * @param sid - Session id
 * @param dir - Sessions directory (defaults to `~/.minimal-agent/sessions/`)
 */
export function loadQueue(sid: string, dir?: string): QueueItem[] {
  let raw: string
  try {
    raw = readFileSync(queueFilePath(sid, dir), "utf-8")
  } catch {
    return []
  }
  if (raw.length === 0) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const out: QueueItem[] = []
  for (const e of parsed) {
    if (e == null || typeof e !== "object") continue
    const obj = e as Record<string, unknown>
    if (typeof obj.text !== "string") continue
    if (obj.text.length === 0) continue
    const lines = obj.commitLines
    if (!Array.isArray(lines)) continue
    if (!lines.every((l) => typeof l === "string")) continue
    out.push({ text: obj.text, commitLines: lines.slice() })
  }
  return out
}

/**
 * Per-session queue snapshot writer.
 *
 * Construct once per process, alongside the {@link SessionStore} for the
 * same sid. Call {@link save} with each new queue snapshot from the REPL
 * (after `push`, `shift`, and `splice` mutations); the store handles
 * in-flight coalescing and atomic on-disk replacement. Call {@link clear}
 * after a clean exit (no items left in the queue and no resume needed).
 *
 * Errors from individual writes are reported via the optional `logger`
 * dep (defaults to silent) — they NEVER throw out of save/clear.
 */
export class QueueStore {
  readonly path: string
  /**
   * Per-process tmp path. The pid suffix prevents collision when two
   * agents are attached to the same session (`--resume <sid>` in two
   * terminals); a dropped tmp file from one would otherwise overwrite
   * the other's in-flight write. The final `rename` is still racy across
   * processes, but each process's write is internally consistent.
   */
  private readonly tmpPath: string
  private inFlight = false
  /**
   * Latest snapshot the caller wants on disk. `null` means "nothing
   * pending". An empty array means "an explicit clear is queued" — the
   * flush loop unlinks the file rather than writing `[]`. The flush
   * loop drains this until it's null again, so consecutive saves
   * coalesce to a single trailing write.
   */
  private latestPending: QueueItem[] | null = null
  private readonly logger: (msg: string) => void

  constructor(
    sid: string,
    opts: {
      dir?: string
      logger?: (msg: string) => void
    } = {},
  ) {
    this.path = queueFilePath(sid, opts.dir)
    this.tmpPath = `${this.path}.tmp.${process.pid}`
    this.logger = opts.logger ?? (() => {})
  }

  /**
   * Schedule a write of `queue` to the queue file. Coalesces with any
   * other pending or in-flight writes — only the latest snapshot
   * survives. Returns immediately; the write happens on a microtask.
   *
   * Pass an empty array to schedule deletion of the file (equivalent to
   * {@link clear}).
   *
   * Safe to call from any context, including hot keystroke handlers.
   * The actual disk write runs off the event loop via Bun.write +
   * `rename`, both of which are non-blocking.
   */
  save(queue: readonly QueueItem[]): void {
    // Defensive copy so the caller can mutate their array (push/shift/
    // splice) without racing the in-flight write.
    this.latestPending = queue.map((q) => ({
      text: q.text,
      commitLines: q.commitLines.slice(),
    }))
    if (this.inFlight) return
    void this.flush()
  }

  /**
   * Schedule deletion of the queue file. Equivalent to `save([])` but
   * reads more naturally at call sites that want to communicate "the
   * queue is empty AND the session is exiting cleanly".
   *
   * Idempotent: calling clear() when no file exists is a no-op.
   */
  clear(): void {
    this.save([])
  }

  /**
   * Drain `latestPending` to disk one write at a time. Re-checks
   * `latestPending` after each write so a save that races with the
   * in-flight write isn't lost — the loop keeps going until
   * `latestPending` is null at the start of an iteration.
   *
   * Reentrancy is prevented by `inFlight`. Errors per-write are
   * swallowed (logged via the injected logger if any) so a transient
   * disk problem can't kill the REPL.
   */
  private async flush(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      while (this.latestPending !== null) {
        const snap = this.latestPending
        this.latestPending = null
        try {
          await this.writeOnce(snap)
        } catch (err) {
          this.logger(
            `queue-store: write failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    } finally {
      this.inFlight = false
    }
  }

  /**
   * Single write. An empty `snap` deletes the queue file (best-effort —
   * ENOENT is fine). A non-empty `snap` JSON-encodes the array to a
   * per-pid tmp file then atomically renames into place. POSIX
   * guarantees same-filesystem `rename(2)` is atomic, so a reader (next
   * session start) sees either the old contents or the new contents,
   * never a half-written file.
   */
  private async writeOnce(snap: QueueItem[]): Promise<void> {
    if (snap.length === 0) {
      await rm(this.path).catch((err: NodeJS.ErrnoException) => {
        // ENOENT is expected (already deleted, or never existed).
        if (err?.code !== "ENOENT") throw err
      })
      return
    }
    await Bun.write(this.tmpPath, JSON.stringify(snap))
    await rename(this.tmpPath, this.path)
  }

  // ── test helpers ──────────────────────────────────────────────────

  /**
   * Returns true when an async write is currently running. Tests use
   * this to await quiescence; production code should never need it.
   * @internal
   */
  isWriting(): boolean {
    return this.inFlight
  }

  /**
   * Returns the snapshot most recently passed to {@link save} that has
   * not yet been flushed to disk, or `null` if everything is flushed.
   * @internal
   */
  pendingSnapshot(): QueueItem[] | null {
    return this.latestPending
  }
}
