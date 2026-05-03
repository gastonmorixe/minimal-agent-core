# Queue / live-area bugs — divide & conquer

Progress so far. Each line marked `[x]` is done + tested.

## P0 — duplicate prompt in scrollback
- [x] **Bug 7**: Prompt rendered twice. Fixed via `onQueueInject` no-op.
- [x] Regression test in `live-area-e2e.test.ts`.

## P1 — visible misrender in queue widget
- [x] **Bug 1**: `⏳` (2-cell) → `…` (1-cell). Header aligns with `┊`.
- [x] **Bug 3**: UTF-16 slice → `truncateDisplayWidth`. Surrogate-safe.

## P1 — flicker / scroll jump (DECSET 2026)
- [x] `src/ui/term-caps.ts`: `detectSynchronizedOutput` — DECRPM probe,
      80ms timeout, returns `{syncOutput, unparsed}` with typeahead
      preservation. **8 unit tests passing.**
- [x] `Compositor`: `syncOutput` constructor option; `writeBufferedStream`,
      `setLiveArea`, `withSuspendedLiveArea` now bracket their write
      batches with BSU/ESU when enabled. **3 new compositor tests passing.**
      Default off → byte-stable for all existing tests.
- [x] `runRepl` / `runReplLiveArea`: new `initialStdinBytes` option,
      replays typeahead onto `process.stdin` after `editor.start()`.
- [x] `index.ts`: detection runs before `Compositor` ctor; `MINIMAL_AGENT_NO_SYNC=1`
      env-var escape hatch; unparsed bytes threaded through.

## Test suite status
- 622 pass / 1 fail / 3 skip.
- Single failure (`mdstream 60-col raw markdown leak`) is **pre-existing**:
  confirmed by stashing my changes and re-running on baseline.

## Still TODO
- [ ] **Bug 4**: unit tests for `renderDecoration` (queue widget). Currently
      zero coverage; visual fixes are only verified by eye.
- [ ] tmux smoke driver `tmp/queue-render-tmux-driver.ts` to visually
      assert glyph alignment + no duplicate prompt + DECSET 2026 wrapping
      in iTerm2.
- [ ] **Bug 2**: decoration line-wrap not counted in liveHeight (only
      hits ≤80-col terminals; user is at 127).
- [ ] **Bug 5**: queue drains only at tool boundaries, not text-only
      turns. Consider a flush at end-of-turn-text.
- [ ] **Bug 6**: re-evaluate "scroll moves at bottom" after DECSET 2026
      lands. Likely better; may still need partial-line streaming buffer
      refactor (the user's "what's in scrollback never re-renders"
      principle — currently mdstream's cursor-up rerender hits scrollback
      and we strip it; correct fix is moving the partial line into the
      live area).
