---
title: Data flows
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
tags: [tui, data-flow, sequence, sigwinch, mount]
taillog:
 - "2026-05-27T10:14:30.725679000-0400 | Initial: end-to-end flows for keystroke, stream chunk, SIGWINCH, mount"
---

# Data flows

End-to-end pictures of who calls whom for the common events.

## One keystroke

```
┌────────────────────────────┐
│         stdin byte         │
└──────────────┬─────────────┘
               ▼
┌────────────────────────────┐
│      RawInput keymap       │
│        src/input.ts        │
└──────────────┬─────────────┘
               │ key event
               ▼
┌────────────────────────────┐
│   InputCaptureStack LIFO   │
└──────────────┬─────────────┘
               │ not claimed
               ▼
┌────────────────────────────┐
│   editor.key hook chain    │
└──────────────┬─────────────┘
               │ not halted
               ▼
┌────────────────────────────┐
│      EditorController      │
│    mutates EditorBuffer    │
└──────────────┬─────────────┘
               ▼
┌────────────────────────────┐
│ EditorRenderer wrap+cursor │
└──────────────┬─────────────┘
               ▼
┌────────────────────────────┐
│   Compositor.setLiveArea   │
└──────────────┬─────────────┘
               ▼
┌────────────────────────────┐
│           stdout           │
└────────────────────────────┘
```

See [chapter 05](./05-input-pipeline.md) for the input-side details and [chapter 01](./01-compositor.md) for what `setLiveArea` actually does.

## One stream chunk (model output)

```
┌────────────────────────────────┐
│  SSE event from Anthropic API  │
└────────────────┬───────────────┘
                 ▼
┌────────────────────────────────┐
│         Agent.run loop         │
│          src/agent.ts          │
└────────────────────────────────┘
                 │
                 ├───────────────────────────────┐
                 ▼                               ▼
┌────────────────────────────────┐     ┌──────────────────┐
│         Formatter pipe         │     │   console.log    │
│       mdstream optional        │     │ third-party libs │
└────────────────┬───────────────┘     └─────────┬────────┘
                 │                               │
                 ├───────────────────────────────┘
                 ▼
┌────────────────────────────────┐
│ StdioInterceptor.write wrapper │
└────────────────┬───────────────┘
                 ▼
┌────────────────────────────────┐
│        AnsiStreamBuffer        │
│    holds partial CSI bytes     │
└────────────────┬───────────────┘
                 ▼
┌────────────────────────────────┐
│     Compositor.writeStream     │
└────────────────┬───────────────┘
                 ▼
┌────────────────────────────────┐
│         capBlankLines          │
│       cap consecutive \n       │
│             at 3               │
└────────────────┬───────────────┘
                 ▼
┌────────────────────────────────┐
│      writeBufferedStream       │
│   BSU erase write redraw ESU   │
└────────────────┬───────────────┘
                 ▼
┌────────────────────────────────┐
│   stdout via rawStdoutWrite    │
└────────────────────────────────┘
```

Key invariant: even `console.log` from a third-party library goes through this exact path. The `StdioInterceptor.makeWrapper` patches the underlying `write` so any caller (logger, error reporter, debug print) lands in `compositor.writeStream` and the live area survives.

## SIGWINCH (terminal resize)

```
SIGWINCH from kernel
   |
   v
process.stdout emits "resize"
   |
   +--> compositor.notifyResize()
   |       |
   |       v
   |    HARD RULE: emit nothing, do not reset counters.
   |    (See chapter 01 for the regression history.)
   |
   +--> editor.notifyResize()
           |
           v
        repaint()
           |
           v
        maxLiveHeight() re-evaluated (closure reads process.stdout.rows)
        cols re-read from process.stdout.columns
        viewport window recomputed
        new lines + cursor handed to compositor.setLiveArea(...)
           |
           v
        compositor:
         - maybeRecoverFromColsDrift() detects the cols change at paint time
         - HARD RULE: emit nothing for drift either (same regression history)
         - normal eraseLiveSeq walk-up + drawLiveSeq per-row ESC[K
            overwrite covers the old reflowed content in place
```

Trade-off baked in by current design: in the cols-change worst case, one row of stale old-live-area content may remain visible ABOVE the new live area until the next stream write covers it. Bounded, NOT scrollback loss. See chapter 01's `notifyResize` section for the full history of what we tried and broke.

## Mount / unmount

```
src/index.ts boot
   |
   v
detectSyncOutput()          <- ESC[?2026$p, parse reply, capture typeahead
   |
   v
new Compositor({output: ..., syncOutput: probeResult})
new StdioInterceptor(compositor)
new EditorController({prompt, compositor, maxLiveHeight: () => ...})
   |
   v
interceptor.install()        <- patches process.stdout.write, process.stderr.write,
                                console.log / .error / .warn / .info / .debug
   |
   v
process.stdout.on("resize", () => {
  compositor.notifyResize()
  editor.notifyResize()
})
   |
   v
runRepl()                    <- ambient capture starts, first repaint scheduled

(running ...)
   |
   v
on exit / SIGINT / SIGTERM / SIGHUP:
 - editor cleanup hook -> emergencyRestore() on each active controller:
      restore raw mode, disable bracketed paste, disable kitty kb, show cursor
 - compositor.unmount():
      flushStream() drains streamAnsi
      walk cursor down to below the live area, \r\n, show cursor
      reset all internal counters
 - interceptor.uninstall():
      restore original process.stdout.write, process.stderr.write
      restore original console.*
```

The compositor never tries to "tear down" the live area on exit. It just walks the cursor below it so the next thing the user (or shell) prints lands on a fresh line beneath the final prompt state. The prompt itself stays in scrollback as the user's last interaction. Useful for "scroll up after the program exits to see what I asked".

## Submit (Enter pressed)

```
user presses Enter
   |
   v
key event flows through input pipeline (chapter 05)
   |
   v
EditorController.submit():
   1. text = buf.lines.join("\n")
   2. rendered = renderer.render(buf, {firstRow: 0, rowCount: buf.lines.length})
      commitLines = rendered.lines  (wrap-aware, with prompts)
   3. buf.clear(), viewportTop = 0
   4. repaint()                    <- live area now shows empty prompt
   5. emit("submit", text, commitLines)
   |
   v
host (runRepl in agent.ts):
  - flush commitLines to compositor.writeStream so the just-submitted
     prompt enters scrollback
  - Agent.run(text) starts the API turn
```

`commitLines` is the trick that puts the user's prompt in scrollback even though the editor cleared the buffer. Without it, hitting Enter would erase the prompt visually with no record left above.

## Mode change (Shift+Tab)

```
Shift+Tab pressed
   |
   v
input pipeline routes to mode-cycle hook
   |
   v
ModeManager.cycle()
   |
   +-- modeManager.subscribe() fires per-subscriber:
   |     editor.setShowHidden(...)
   |     editor.setPrompt(`${newMode.label} ❯ `)   (e.g. "ASK ❯ ")
   |
   +-- next user message attaches <mode-change from=... to=... at=...>
       (see ask-mode plugin)
   |
   v
editor.repaint() picks up the new prompt
   |
   v
compositor.setLiveArea(...) with the new prompt baked into editor lines
```

The mode prefix change shifts editor wrap math (the prompt is wider now), so the next `EditorRenderer.render` returns slightly different physical-row counts. The compositor's `setLiveArea` shortcircuit (`drawnLiveKey === nextKey`) misses because the lines array changed; full eraseLiveSeq + drawLiveSeq fires.
