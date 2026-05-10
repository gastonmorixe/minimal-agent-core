# Draft prompt persistence

**Date:** 2026-05-09
**Type:** feat
**Status:** landed
**Author:** Claude Code (Opus 4.7)

## Problem

The editor buffer (the multi-line text the user is typing into the
pinned `❯ ` prompt) is normally ephemeral. If the agent crashes, the
terminal window is closed by mistake, or `kill -9` is sent before the
user presses Enter, every byte of the unsubmitted draft is lost. There
is no recovery — the draft was only ever in process memory.

This is a real, repeatedly-painful UX bug in long-form work: the user
spends two minutes composing a prompt, hits the wrong window-close
shortcut, and starts over from a blank screen.

The session JSONL log is not a fix: it commits at turn boundaries
(submitted user message, assistant turn complete, each tool result),
which is correct for conversation history but by design never sees the
in-flight draft.

## Goals

1. **Survive a crash.** `kill -9` immediately after the user pauses
   typing should leave the latest draft snapshot recoverable on the
   next agent start.
2. **Don't pay for it on every keystroke.** A typist at 600 chars/min
   will fire a buffer-change notification ~10 times per second under
   pessimistic assumptions; we must coalesce so the disk sees ≤2 writes
   even during a sustained burst.
3. **Don't block the keystroke path.** Even at modest rates, sync
   `writeFileSync` from the keystroke handler would drop frames during
   typing and visibly stutter the editor.
4. **Be safe across crashes.** A crash mid-write must leave EITHER the
   old draft OR the new draft on disk, never a half-written file.
5. **Be invisible when nothing went wrong.** Clean exits, normal
   submits, and Ctrl+C-on-empty-buffer should leave no draft file
   behind.

## Research / options considered

### A. Sync write on every keystroke

```ts
editor.on("input", (e) => writeFileSync(path, e.text))
```

**Rejected.** Blocks the event loop on every keystroke (worst-case
~1ms per write under contention). The keystroke handler is a hot path
in raw-mode TTY; a stutter here is immediately visible. Also fragments
the disk and pummels the FS journal for tens of writes per second of
typing.

### B. Async write on every input event, fire-and-forget

```ts
editor.on("input", (e) => Bun.write(path, e.text))
```

**Rejected.** Two issues:

1. **Race conditions.** Two concurrent `Bun.write` calls to the same
   path can interleave at the syscall level — different chunks land in
   any order, and the on-disk file may end up with stale text mixed
   into newer text. Especially bad during burst typing.
2. **No coalescing.** Even though each individual write is async, we
   still issue O(events) syscalls. The 120ms editor debounce already
   coalesces SOME events but not all bursts.

### C. Worker thread for I/O

Spawn a Node `worker_threads` Worker dedicated to draft writes,
message-pass the latest text from the main thread.

**Rejected as overkill.** The whole point of using a Worker would be
to keep file I/O off the JS event loop, but Bun.write is already
non-blocking — it dispatches to libuv-style I/O thread pools under
the hood. Empirically:

```
$ bun -e '<atomic write loop>'
1000 atomic writes in 188.8ms = 188.8μs each
```

Each Bun.write+rename pair completes in ~190μs of *off-loop* time. A
Worker would add millisecond-scale message-passing overhead per write
and ~5MB of memory for the Worker context, just to save sub-1KB writes
that are already off-loop. Wrong tool. Reserve workers for genuinely
CPU-bound or sustained I/O work.

### D. fsync after every write for durability

```ts
await Bun.write(path, text)
await fsync(handle)
```

**Rejected.** fsync forces the kernel to flush dirty pages to physical
storage, adding 1-10ms latency (depending on FS type and SSD wear
state). For an ephemeral draft that the user can re-type if the worst
happens, this is the wrong trade-off — our crash window is "kernel
panic" or "power loss", not "process crash". The page cache survives
process crashes and `kill -9`. Ext4 / APFS / NTFS all guarantee that
write-then-rename leaves either the old or new content visible after
a process crash without explicit fsync.

### E. **CHOSEN: `Bun.write` + `rename` with in-flight coalescing**

```ts
class DraftStore {
  private inFlight = false
  private latestPending: string | null = null

  save(text: string): void {
    this.latestPending = text
    if (!this.inFlight) void this.flush()
  }

  private async flush() {
    this.inFlight = true
    try {
      while (this.latestPending !== null) {
        const text = this.latestPending
        this.latestPending = null
        await Bun.write(this.tmpPath, text)
        await rename(this.tmpPath, this.path)
      }
    } finally {
      this.inFlight = false
    }
  }
}
```

Wins:

- **Atomic on disk.** POSIX `rename(2)` on same FS is guaranteed
  atomic — readers see either the old or new draft, never a partial
  one.
- **Off the keystroke path.** `save()` is a microtask trigger;
  `Bun.write` + `rename` run via Bun's native non-blocking I/O.
- **Coalescing.** A burst of 50 keystrokes produces at most 2 disk
  writes (one in-flight, one final pending). The middle 48 states
  never touch disk.
- **No race conditions.** Only one write executes at a time. The
  flush loop drains `latestPending` until it's null, so a save that
  arrives during the in-flight write is captured by the next loop
  iteration.
- **Best-effort error handling.** Disk-full, permission-denied, etc.
  are logged but never thrown — never crashes the REPL.
- **Tiny operational cost.** ~190μs per write off-loop; even pathological
  10-saves-per-second typing is <2ms/sec of background CPU.

## Implementation

### New module: `src/draft-store.ts`

- `DraftStore` class — `save(text)`, `clear()`, `path` getter, internal
  flush loop with `inFlight` + `latestPending` for coalescing.
- `loadDraft(sid, dir?)` — synchronous load helper (called once at
  REPL startup; cheap one-shot file read).
- `draftFilePath(sid, dir?)` — path helper, mirrors
  `sessionFilePath(sid, dir)` from `session-store.ts`.

The draft file lives at
`~/.minimal-agent/sessions/<sid>.draft` — sibling of the existing
`<sid>.jsonl` log. Reasons:

- Tied to the session: `--resume <sid>` finds the draft for that
  session.
- One-shot cleanup: removing a session also removes its draft.
- Discoverable by existing session-listing UIs.
- The tmp file uses a per-pid suffix (`.tmp.<pid>`) to prevent
  collision when two agents are attached to the same session
  (`--resume <sid>` in two terminals — rare but possible).

### Wiring in `src/index.ts`

Only the live-area REPL path (default for TTY stdout) gets the draft
hook. The legacy `RawInput`-based REPL doesn't have a long-lived
multi-line draft buffer in the first place — every read is a fresh
mount/unmount cycle, so there's nothing to persist.

```ts
// after: const editor = new EditorController({...})

const draftStore = new DraftStore(sid, { logger: ... })

const savedDraft = loadDraft(sid)
if (savedDraft && savedDraft.length > 0) {
  editor.setBuffer(savedDraft) // restore on resume
}

editor.on("input", (e) => draftStore.save(e.text))
editor.on("submit", () => draftStore.clear())
editor.on("cancel", () => draftStore.clear())
```

The editor's `"input"` event is already debounced internally at 120ms
(see `EditorController.scheduleInputEmit` and the `inputDebounceMs`
option). We rely on that — no second debounce layer.

### Opt-out

`MINIMAL_AGENT_NO_DRAFT_PERSIST=1` disables the feature entirely
(skips the DraftStore construction and event hooks). For users who
want to keep the editor truly stateless across crashes.

## Loss window

Up to ~120ms of typing between the last keystroke and an unrecoverable
crash. This is the editor's input-debounce window — a faster typist
might lose the last few characters, but anything earlier is on disk.

For the `--prompt` non-interactive path: not applicable, no editor.

## Tests

### Unit (`src/draft-store.test.ts`, 17 tests)

- save → file appears with right content
- save twice → second value wins
- save then clear → file gone
- clear with no prior save → no-op (no throw)
- save("") is equivalent to clear()
- coalescing: 50 rapid saves → 1 final on-disk text
- coalescing: save during in-flight is captured (no race loss)
- clear during in-flight removes the draft
- save→clear→save sequence ends in the saved state
- loadDraft: returns null for missing/empty/permission-denied
- loadDraft: returns text verbatim (no trim/normalize)
- loadDraft: round-trips through DraftStore.save
- error handling: write to bad dir logs and continues
- per-pid tmp filename used internally

### Integration (`src/draft-store-editor.integration.test.ts`, 6 tests)

Drives a real `EditorController` against a real `DraftStore`:

- typing keystrokes persists to disk
- Enter (submit) clears the draft
- Ctrl+C on empty buffer clears the draft
- setBuffer (used by `--resume`) restores and re-saves
- multi-line drafts round-trip
- rapid typing produces stable final state

### Tmux smoke drivers (regression guards)

- `tmp/draft-persist-tmux-driver.ts` — two-phase: (1) type and
  process.exit without submitting; (2) restart with same sid and
  verify draft is restored into the editor buffer.
- `tmp/draft-clear-on-submit-tmux-driver.ts` — type, submit, verify
  the draft file is gone from disk.

Both verified manually:

```
RUN 1 PANE:
> first line of unsent prompt
  second line, important context

RUN 2 PANE (after process exit, fresh start with same sid):
> first line of unsent prompt
  second line, important context
```

## Future work

- **Draft TTL.** Currently restores any draft regardless of age. Could
  add "drop drafts older than 24h" to avoid surprising the user. Defer
  until we get a concrete user complaint.
- **Cross-session draft.** Right now drafts are scoped per-sid. A
  fresh session (no `--resume`) starts with an empty editor even if
  the previous session had an unsubmitted draft. Workaround: use
  `--resume last` to pick up the most recent session.
- **Workers for very large drafts.** If users ever paste megabytes of
  text into the editor, the off-loop write time will start to matter.
  At ~190μs per 1.3KB write, the crossover where Worker overhead
  becomes worthwhile is around 1MB+ payloads.

## File inventory

- **Added:** `src/draft-store.ts`, `src/draft-store.test.ts`,
  `src/draft-store-editor.integration.test.ts`,
  `tmp/draft-persist-tmux-driver.ts`,
  `tmp/draft-clear-on-submit-tmux-driver.ts`,
  `docs/changes/2026-05-09-feat-draft-prompt-persistence.md`
- **Modified:** `src/index.ts` (import + ~40 lines of wiring inside
  the live-area branch)
