---
title: TUI overview
created_at: "2026-05-27T10:14:30.725679000-0400"
updated_at: "2026-05-27T10:14:30.725679000-0400"
session_id: 4aa1cfdf-7a42-47ce-8b99-c7612a39e167
host_info:
  hostname: macbookpro.home.arpa
  user: gaston
  os: "macOS 26.5 (25F71)"
  kernel: "25.5.0"
  arch: arm64
  serial: FHQ93DD9T6
tags: [tui, overview, scrollback, live-area]
taillog:
 - "2026-05-27T10:14:30.725679000-0400 | Initial: big-picture model + screen diagram + the three actors"
---

# TUI overview

## What it is, what it isn't

`minimal-agent` is a **scrolling REPL with a pinned live area**, not a full-screen TUI. Everything the model streams (text, tool calls, formatter output) is appended to the terminal's native scrollback. A small block of UI (status row + editor + footer) sits just below the most recent output and gets erased-and-redrawn on every state change.

The user can scroll up freely and re-read past turns because nothing is held in an alternate screen buffer.

## The screen, conceptually

```
Terminal viewport
--------------------------------------------------------------------------------
  > hello
  Hi! Here is what I think...
  [tool_use: Bash]
  ...streamed output continues...
  Done.

  (free-flowing native scrollback, owned by terminal)

--------------------------------------------------------------------------------
  (blank separator)                                    <- liveSep / sepRows
  status   ::  Thinking... 12s  1234 tok               <- status row
  (gap)                                                <- statusGapRows
  > user is typing                                     <- editor row 0
    second line of buffer                              <- editor row 1
  (footer spacer)                                      <- footerSpacer
  footer  ::  context 42%  quota 88%                   <- composedFooter

--------------------------------------------------------------------------------
Legend:  rows 2..9 = SCROLLBACK (append-only, scrolls up freely)
         rows 11..17 = LIVE AREA (compositor owns, erased+redrawn per frame)
```

## The three actors

| Actor | Owns | Lives in |
|---|---|---|
| **Compositor** | the bytes inside the live area | `src/ui/compositor.ts` |
| **EditorController** | the high-level layout of the live area (status / editor / footer) | `src/editor-controller.ts` |
| **StdioInterceptor** | every write to stdout/stderr/console.* | `src/ui/stdio-interceptor.ts` |

Roughly: the **EditorController** decides what the live area *should look like* and hands an array of strings to the **Compositor**. The Compositor figures out how to get from the previous frame to that array with the fewest cursor moves, wraps the whole thing in a synchronized-update envelope, and writes it. The **StdioInterceptor** sits in front of every other write path so a stray `console.log` doesn't tear a hole in the live area.

## The wiring

```
┌───────────────────┐     ┌──────────────────────────┐
│                   │     │                          │
│    src/index.ts   │  ┌──┤         SIGWINCH         │
│        boot       │  │  │                          │
│                   │  │  │                          │
└───────────────────┘  │  └─────────────┬────────────┘
          │            │                │
          │            │    process.stdout.on resize
          ├────────────┼────────────────┼────────────────────────────┬───────────────────────────────────────────────┐
          │            │                │                            │                                               │
          ▼            │                ▼                            ▼                                               ▼
┌───────────────────┐  │  ┌──────────────────────────┐     ┌──────────────────┐                            ┌───────────────────┐
│     term-caps     │  ├──┤     EditorController     ├──┬──┤ StdioInterceptor │console / formatter writes  │   Agent.run loop  │
│ probe DECRPM 2026 │  │  │                          │  │  │                  │                            │                   │
└─────────┬─────────┘  │  └─────────────┬────────────┘  │  └──────────────────┘                            └───────────────────┘
          │            │                │               │
     writeStream───────┴────────────────┼───────────────┴──────────owns────────────────────────────────────────────reads
          │                             │                            │                                               │
          ▼                             ▼                            ▼                                               ▼
┌───────────────────┐     ┌──────────────────────────┐     ┌──────────────────┐                            ┌───────────────────┐
│     Compositor    │     │      EditorRenderer      │     │   EditorBuffer   │                            │ InputCaptureStack │
│  syncOutput flag  │     │                          │     │                  │                            │                   │
└─────────┬─────────┘     └──────────────────────────┘     └──────────────────┘                            └───────────────────┘
          │
   rawStdoutWrite
          │
          ▼
┌───────────────────┐
│    stdout fd 1    │
└───────────────────┘
```

## Boot order (`src/index.ts`)

1. **Probe** the terminal for DEC mode 2026 (synchronized output) via `term-caps.ts`. Stash typeahead bytes the user managed to send during the probe.
2. **Construct the Compositor** with `output.write` routed through `interceptor.rawStdoutWrite` (set up in step 4) so the compositor's own escape sequences never recurse.
3. **Construct the EditorController** with the compositor handed in. `maxLiveHeight` is a closure that returns `max(2, floor(rows/2))` so the live area never eats more than half the viewport.
4. **Construct and install the StdioInterceptor**. From this point on every `process.stdout.write`, `process.stderr.write`, and `console.*` call routes through the compositor.
5. **Subscribe to SIGWINCH** on `process.stdout` and fan it out to `compositor.notifyResize()` + `editor.notifyResize()`.
6. **Hand off to `runRepl`** (in `src/agent.ts`).

## Hard rules

These show up over and over in compositor source; they're worth internalizing before reading chapter 01.

1. **The compositor never touches scrollback.** Only its owned live-area rows. Any cursor walk-up that lands above the live area's first row is a bug. The HARD RULE is repeated in `notifyResize`, `eraseLiveSeq`, and `maybeRecoverFromColsDrift`.
2. **No absolute cursor moves.** Only `ESC[A` (up), `\r` (col 0), `ESC[C` (right), `ESC[K` (clear-to-EOL), `ESC[J` (clear-to-EOS). Absolute positioning (`ESC[H`) desynchronizes when the viewport scrolls in the middle of a write.
3. **No DEC scroll regions.** Rows that scroll off the top of a scroll region are *lost* - they never enter scrollback. That breaks the "scroll up to re-read" UX.
4. **Resize and silent cols-drift: emit nothing, forget counters.** The terminal already reflowed our cells in place. Any cursor walk from us could damage scrollback. See the regression history comment block on `notifyResize`.
5. **All writes go through the compositor.** That's `StdioInterceptor`'s job - patching `process.stdout.write`, `process.stderr.write`, and the `console.*` methods (Bun bypasses `process.stderr.write` for `console.error`, so the methods themselves are swapped).

## Where this falls apart (known limitations)

- **macOS BSD `script(1)`** doesn't propagate window size, so `process.stdout.columns` is 0. Compositor falls back to `$COLUMNS`. `mdstream` does the same. Without one of them, partial-line redraw math is off and you see duplicated rows in script-recorded sessions.
- **Cross-host NFS or weird ptys** can race the terminal's TIOCGWINSZ. The compositor detects this as "cols drift" at paint time and triggers a soft-recovery (emit nothing, forget counters, let the next paint flow from current cursor). Trade-off: one row of stale content may sit above the new live area until the next stream write covers it.
- **Grapheme clustering** for flag emoji and complex ZWJ sequences is not implemented in `term-width.ts`. Wide CJK and basic emoji work; uncommon sequences may drift cursor by ±1 cell.
