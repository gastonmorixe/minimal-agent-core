/**
 * Per-session draft prompt persistence.
 *
 * The editor buffer (the multi-line text the user is currently typing
 * into the `❯ ` prompt) is normally ephemeral: if the terminal is closed
 * or the agent crashes before the user presses Enter, the draft is lost.
 * `DraftStore` persists the draft to disk on a debounced cadence so it
 * survives crashes / accidental terminal closures and can be restored on
 * the next `--resume <sid>` (or any future session opened against the
 * same sid).
 *
 * Design choices and rejected alternatives — see
 * `docs/changes/2026-05-09-feat-draft-prompt-persistence.md` for the
 * full decision record. Summary:
 *
 *   - We write `~/.minimal-agent/sessions/<sid>.draft` (sibling of the
 *     append-only `<sid>.jsonl` log). Per-session scoping means resume
 *     finds the right draft and `rm <sid>*` cleans up everything.
 *   - We use Bun.write (async, non-blocking, native I/O) followed by
 *     POSIX `rename(2)` for atomicity: a crash mid-write can leave a
 *     stale draft but never a half-written one. Worker threads were
 *     considered and rejected — Bun's I/O is already off the JS event
 *     loop, and a sub-KB write costs ~190μs.
 *   - We coalesce in-flight writes: only ONE write executes at a time,
 *     and the latest text overrides any queued state. A burst of 50
 *     keystrokes produces at most 2 disk writes (one in-flight, one
 *     queued) regardless of how fast they arrive.
 *   - We hook the editor's existing `"input"` event, which already
 *     debounces buffer-text changes at 120ms (default). No additional
 *     debounce layer — the editor's coalescing is sufficient.
 *
 * Loss window: up to ~120ms of typing between the last keystroke and an
 * unrecoverable crash. Acceptable for a draft-recovery feature; we are
 * not the source of truth for the conversation (that's the JSONL log).
 *
 * @module draft-store
 */

import { readFileSync } from "node:fs"
import { rename, rm } from "node:fs/promises"
import { join } from "node:path"

import { defaultSessionsDir } from "./session-store.ts"

/**
 * Returns the on-disk path for a session's draft file.
 *
 * @param sid - Session id (UUID, same as the `<sid>.jsonl` log)
 * @param dir - Sessions directory (defaults to `~/.minimal-agent/sessions/`)
 */
export function draftFilePath(sid: string, dir: string = defaultSessionsDir()): string {
  return join(dir, `${sid}.draft`)
}

/**
 * Synchronously load a session's draft from disk.
 *
 * Returns `null` when no draft exists (the common case: clean exit, or a
 * session that never had unsubmitted text). Returns `null` on any read
 * error — drafts are best-effort, never block startup. We swallow the
 * error rather than re-throw because a corrupted/unreadable draft is
 * equivalent to no draft from the user's perspective.
 *
 * Used at REPL startup to seed the editor buffer with the previous
 * session's unsubmitted text.
 *
 * @param sid - Session id
 * @param dir - Sessions directory (defaults to `~/.minimal-agent/sessions/`)
 */
export function loadDraft(sid: string, dir?: string): string | null {
  try {
    const text = readFileSync(draftFilePath(sid, dir), "utf-8")
    // Empty file means "no meaningful draft" — treat as absent so we
    // don't restore an empty buffer that won't be visible anyway.
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

/**
 * Per-session draft writer.
 *
 * Construct once per process, alongside the {@link SessionStore} for the
 * same sid. Call {@link save} with each new buffer snapshot from the
 * editor's `"input"` event; the store handles debouncing-already-handled,
 * in-flight coalescing, and atomic on-disk replacement. Call {@link clear}
 * after a successful submit (the draft is now in the JSONL log) or after
 * Ctrl+C-on-empty-buffer cancellation.
 *
 * Errors from individual writes are reported via the optional `logger`
 * dep (defaults to silent) — they NEVER throw out of save/clear.
 */
export class DraftStore {
  readonly path: string
  /**
   * Per-process tmp path. The pid suffix prevents collision when two
   * agents are attached to the same session (rare — `--resume <sid>` in
   * two terminals — but possible; a dropped tmp file from one would
   * otherwise overwrite the other's in-flight write). The final
   * `rename` is still racy across processes, but each process's write
   * is internally consistent.
   */
  private readonly tmpPath: string
  private inFlight = false
  /**
   * Latest text the caller wants on disk. `null` means "nothing
   * pending"; `""` means "an explicit clear is queued". The flush loop
   * drains this until it's null again, so consecutive saves coalesce
   * to a single trailing write.
   */
  private latestPending: string | null = null
  private readonly logger: (msg: string) => void

  constructor(
    sid: string,
    opts: {
      dir?: string
      logger?: (msg: string) => void
    } = {},
  ) {
    this.path = draftFilePath(sid, opts.dir)
    this.tmpPath = `${this.path}.tmp.${process.pid}`
    this.logger = opts.logger ?? (() => {})
  }

  /**
   * Schedule a write of `text` to the draft file. Coalesces with any
   * other pending or in-flight writes — only the latest text survives,
   * earlier intermediate states are discarded without ever touching
   * disk. Returns immediately; the write happens on a microtask.
   *
   * Pass `""` to schedule a clear (equivalent to {@link clear}).
   *
   * Safe to call from any context, including hot keystroke handlers.
   * The actual disk write runs off the event loop via Bun.write +
   * `rename`, both of which are non-blocking.
   */
  save(text: string): void {
    this.latestPending = text
    if (this.inFlight) return
    void this.flush()
  }

  /**
   * Schedule deletion of the draft file. Equivalent to `save("")` but
   * reads more naturally at call sites that want to communicate "the
   * draft is no longer relevant" (e.g. on submit, cancel, clean exit).
   *
   * Idempotent: calling clear() when no draft exists is a no-op.
   */
  clear(): void {
    this.save("")
  }

  /**
   * Drain `latestPending` to disk one write at a time. Re-checks
   * `latestPending` after each write so a save that races with the
   * in-flight write isn't lost — the loop just keeps going until
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
        const text = this.latestPending
        this.latestPending = null
        try {
          await this.writeOnce(text)
        } catch (err) {
          this.logger(
            `draft-store: write failed: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    } finally {
      this.inFlight = false
    }
  }

  /**
   * Single write. Empty `text` deletes the draft file (best-effort —
   * ENOENT is fine). Non-empty `text` writes to a per-pid tmp file
   * then atomically renames into place. POSIX guarantees same-filesystem
   * `rename(2)` is atomic, so a reader (next session start) sees either
   * the old contents or the new contents, never a half-written file.
   */
  private async writeOnce(text: string): Promise<void> {
    if (text.length === 0) {
      await rm(this.path).catch((err: NodeJS.ErrnoException) => {
        // ENOENT is expected (already deleted, or never existed).
        if (err?.code !== "ENOENT") throw err
      })
      return
    }
    await Bun.write(this.tmpPath, text)
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
   * Returns the text most recently passed to {@link save} that has not
   * yet been flushed to disk, or `null` if everything is flushed.
   * @internal
   */
  pendingText(): string | null {
    return this.latestPending
  }
}
