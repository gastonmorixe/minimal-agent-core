---
title: TUI architecture (index)
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
tags: [tui, architecture, index, compositor, editor, repl]
taillog:
 - "2026-05-27T10:14:30.725679000-0400 | Initial deep-review docs split into 9 chapters + this index"
---

# TUI architecture (index)

A walkthrough of how `minimal-agent`'s terminal UI is wired, written so a future contributor (or a future me) can pick up the design without re-reading 3000 lines of compositor source.

There is **no full-screen TUI**. The agent is a scrolling REPL with a small block of UI ("the live area") pinned just below the most recent terminal output. Everything streamed by the model flows into the terminal's native scrollback like a regular shell program. The live area is erased and redrawn on every state change.

## Read in order

| # | Chapter | What it covers |
|---|---|---|
| 00 | [Overview](./00-overview.md) | The big picture: scrollback vs live area, the three actors, the screen model |
| 01 | [Compositor](./01-compositor.md) | The atomic redraw cycle, BSU/ESU, eraseLiveSeq, drawLiveSeq, separator logic, cols-drift |
| 02 | [Live-area layout](./02-live-area-layout.md) | What the live area actually contains row-by-row (status, decoration, indicator, editor, footer) |
| 03 | [Editor controller](./03-editor-controller.md) | The persistent editor that owns the live area, footer layer system, viewport scrolling |
| 04 | [Editor buffer + renderer](./04-editor-buffer-renderer.md) | Pure text model + pure wrap-aware view |
| 05 | [Input pipeline](./05-input-pipeline.md) | RawInput → InputCaptureStack → hook chain → abort-quit FSM |
| 06 | [Supporting modules](./06-supporting-modules.md) | StdioInterceptor, AnsiStreamBuffer, term-caps, theme, picker, overlay, quit-modal, scrollback-guard |
| 07 | [Data flows](./07-data-flows.md) | End-to-end diagrams: one keystroke, one stream chunk, SIGWINCH, mount/unmount |
| 08 | [`--tui-debug` design](./08-tui-debug-design.md) | Proposed CLI flag: region tints, copy-paste markers, HUD, frame markers |

## Code map (read-along)

| File | LOC | Role |
|---|---:|---|
| `src/ui/compositor.ts` | 787 | the only thing that writes the live area |
| `src/host/editor-controller.ts` | 2096 | persistent multiline editor, drives setLiveArea |
| `src/input/input.ts` | 1420 | RawInput keymap + escape parsing (legacy, partly superseded) |
| `src/host/ui/editor/renderer.ts` | 438 | EditorBuffer → physical rows + cursor (with wrap) |
| `src/input/editor-buffer.ts` | 312 | pure multiline text model |
| `src/terminal/term-width.ts` | 241 | display-width / wrap math (single source of truth) |
| `src/input/input-capture-stack.ts` | 224 | LIFO transient overlays in front of the hook chain |
| `src/ui/picker.ts` | 173 | generic vertical picker primitive |
| `src/ui/stdio-interceptor.ts` | 155 | re-routes all writes through the compositor |
| `src/ui/term-caps.ts` | 138 | DECRPM probe for synchronized output (mode 2026) |
| `src/ui/terminal/ansi-stream.ts` | 126 | escape-safe split-buffer for partial CSI/OSC bytes |
| `src/ui/quit-modal.ts` | 38 | example of a `LiveOverlay` |
| `src/ui/theme/types.ts` | 27 | dark/light SGR palette |
| `src/ui/overlay.ts` | 19 | `LiveOverlay` interface |
| `src/ui/scrollback-guard.ts` | 14 | unused-but-kept reserve-region helper |

## Hard rules to remember

1. **The compositor never touches scrollback.** Only its owned live-area rows. Any cursor walk-up that lands above the live area's first row is a bug.
2. **No absolute cursor moves.** Only `ESC[A`, `\r`, `ESC[C`, `ESC[K`, `ESC[J`. Absolute positioning desynchronizes when the viewport scrolls mid-frame.
3. **No DEC scroll regions (DECSTBM).** Rows that scroll off the top of a scroll region are lost - they never enter scrollback. That breaks "scroll up to re-read the conversation".
4. **Resize/cols-drift: emit nothing, forget counters.** The terminal already reflowed our cells in place. Any cursor walk from us could damage scrollback. See `notifyResize` for the regression history.
5. **All writes go through the compositor.** `StdioInterceptor` patches `process.stdout.write`, `process.stderr.write`, and `console.*` so direct writes from libraries don't stomp the live area.

## Conventions

- Chapters are numbered; cross-references use the file name (`./01-compositor.md`).
- Every chapter has YAML front matter with `created_at`, `updated_at`, `session_id`, `host_info`, `tags`, and `taillog` per `~/.agents/skills/yaml/SKILL.md`.
- ASCII diagrams come from `~/.agents/skills/ascii-renderer/scripts/` (grid_buffer + mermaid). Sources for the diagrams live in `/tmp/tui_*.py` and `/tmp/dataflow_*.mmd` during authoring; the rendered output is pasted inline.
