---
title: Editor controller
created_at: "2026-05-27T10:14:30.725679000-0400"
updated_at: "2026-05-27T10:14:30.725679000-0400"
tags: [tui, editor-controller, repaint, footer-layers, lifecycle]
taillog:
 - "2026-05-27T10:14:30.725679000-0400 | Initial: lifecycle, repaint loop, footer layers, events, signals"
---

# Editor controller

Source: `src/editor-controller.ts` (2096 lines). The persistent multiline editor that owns the live area for the entire REPL session.

## Why "persistent"

Unlike a typical `readline`-style loop that mounts and unmounts raw mode on every read, `EditorController` is started once and stays alive. Submits emit events; the buffer is cleared in place; raw mode and bracketed paste stay enabled the whole time. This is what keeps the `❯ ` prompt visible while the agent is working on the previous turn.

## Constructor surface

```ts
new EditorController({
  prompt: string,
  continuationPrompt: string,
  compositor: CompositorLike,
  stdin?: NodeJS.ReadStream,
  output?: Pick<NodeJS.WriteStream, "write" | "columns">,
  maxLiveHeight?: number | (() => number),     // dynamic cap recommended
  showHidden?: boolean,                         // render ws as · → ↵
  bareEscapeMs?: number,                        // bare-Esc debounce, default 20
  inputDebounceMs?: number,                     // "input" event coalesce, default 120
  hooks?: Hooks,                                // plugin facade for editor.key etc.
})
```

The compositor parameter is duck-typed to `CompositorLike`:

```ts
interface CompositorLike {
  setLiveArea(lines: string[], cursor: { row: number; col: number } | null): void
  setLiveHeight(n: number): void           // legacy no-op
  liveHeight: number
  writeStream?(chunk: string): void        // optional; commits prompt to scrollback on submit
}
```

## Lifecycle

```
       new EditorController(...)
                 │
                 ▼
            (constructed, idle)
                 │
                 │ start()
                 ▼
      raw mode on, bracketed paste on,
      kitty keyboard / xterm modifyOtherKeys on,
      stdin listener installed,
      ambient capture active,
      first repaint() scheduled
                 │
                 ▼
           (running forever)
       │                          │
       │ submit (Enter)           │ setStatus / setDecoration /
       ▼                          │ setFooterLayer / external state
   "submit" event,                │ change
   buf.clear(), repaint()         │
                                  ▼
                              repaint()
                 │
                 │ stop() / process exit / SIGINT
                 ▼
      restore tty state, uninstall listeners
```

## The repaint loop

`repaint()` is invoked after every meaningful state change: keystroke, submit, `setStatus`, `setDecoration`, `setFooterLayer`, plugin hook return, mode change. The flow:

1. **Coalesced "input" emit.** Schedule (or reset) a `inputDebounceMs` timer that emits the `"input"` event with the current buffer text. Skipped when buffer text is unchanged (cursor-only repaints don't fire spurious events).
2. **Plugin `editor.buffer.changed` hook.** Undebounced so overlays render in lock-step. Dedup'd internally.
3. **Build layout segments** (see [chapter 02](./02-live-area-layout.md)):
  - `statusFilled`, `statusReserved`, `statusGapRows`, `statusRows`
  - `composedFooter` from `composeFooter()`, `footerSpacerRows`, `footerRows`
  - `editorBudget = max(1, cap - statusRows - statusGapRows - footerRows)`
4. **Viewport window computation.** `computeWindow(budget, startVTop)` is run up to twice (with and without an indicator-reservation row).
5. **`setLiveHeight(target)`** - legacy compat call; the compositor derives height from the lines array now, but the call is kept for source compatibility.
6. **`renderer.render(buf, {firstRow: vTop, rowCount: editorWindow, columns: cols})`** → `{lines, cursor}`.
7. **Optional indicator** when `vTop > 0` (see [chapter 02](./02-live-area-layout.md) for the three forms).
8. **Assemble `finalLines` and `finalCursor`** in the layout order.
9. **Hand to compositor**: `compositor.setLiveArea(finalLines, finalCursor)`.

## Events

```ts
controller.on("submit", (text: string, commitLines: string[]) => { ... })
controller.on("cancel", (reason: QuitReason) => { ... })
controller.on("quit",   (reason: QuitReason) => { ... })
controller.on("input",  (e: { text: string, seq: number }) => { ... })
```

- **`submit`** - Enter pressed on a non-empty buffer. `text` is `buf.lines.join("\n")`. `commitLines` is the rendered (wrap-aware, with prompts) array that the host can flush to `compositor.writeStream` so the just-submitted prompt enters scrollback before the next turn starts.
- **`cancel`** - Esc / Ctrl+C with the abort-quit FSM in cancel state. Cancels the in-flight turn but does NOT quit the REPL.
- **`quit`** - escape-hatch state of the abort-quit FSM. Tear down and exit.
- **`input`** - debounced buffer-text-changed notification with monotonic `seq`. Subscribed by `AutoAskController` (auto-mode heuristic), draft-store snapshotter, etc.

## Status / decoration / footer setters

```ts
setStatus(line: string | null): void
setDecoration(lines: string[]): void
setFooterLayer(id: FooterLayerId, lines: string[], opts?: { priority?: number }): void
clearFooterLayer(id: FooterLayerId): void
setFooterLines(lines: string[]): void           // back-compat shim → DEFAULT layer
```

`setStatus(null)` clears the line but the row stays reserved (rendered as blank) so the prompt doesn't move. The latch (`statusRowReserved`) flips on the first non-null call and never flips back.

`applyFooterChange()` shallow-compares the composed result against the last composition and only triggers `repaint()` when the visible footer actually changed. Avoids cascade repaints when an irrelevant layer updates.

## Show-hidden mode

```ts
setShowHidden(v: boolean): void
```

Toggles invisible-char rendering (space → `·`, tab → `→`, newline → `↵`) on the renderer. Enabled by `MINIMAL_AGENT_SHOW_HIDDEN_CHARS=1`, `--show-hidden-chars`, or any active mode with `editorShowHidden: true` in its manifest. Useful for debugging whitespace in multiline inputs.

## Prompt updates per mode

```ts
setPrompt(prompt: string, continuationPrompt?: string): void
```

When the active mode changes (Shift+Tab or `ModeManager`), the prompt prefix updates to reflect the mode. ASK mode prepends `ASK ` so the row reads `ASK ❯ `. The renderer is told via `setPrompt`; the next repaint picks up the new width.

## Signal handling

A process-level cleanup hook tracks all active `EditorController` instances. On `exit`, `SIGINT`, `SIGTERM`, or `SIGHUP`, the hook calls `emergencyRestore()` on each, which:

- restores raw mode
- disables bracketed paste
- disables kitty keyboard / xterm modifyOtherKeys
- shows the cursor

This is the only thing that prevents a crashing agent from leaving the user's terminal in an unusable state.

## `notifyResize()`

Invoked from `process.stdout.on("resize")` after the controller's compositor sibling call. Recomputes `maxLiveHeight` (it's a closure that reads `process.stdout.rows`) and triggers a `repaint()`. The compositor handles the bytes-on-wire side per chapter 01.

**Coalesced (May 2026).** A window-edge *drag* fires one SIGWINCH per intermediate column. Repainting on each one stacks a reflow residue into permanent scrollback per column (the terminal scrolls the live area's top rows above the viewport as the pre-wrapped lines re-wrap narrower, and the compositor's relative `ESC[J` can't reach above the viewport top — see chapter 01's `notifyResize`). So `notifyResize` now **debounces**: it arms a trailing timer and repaints once, `resizeDebounceMs` (default 150ms) after the *last* resize, collapsing a whole drag into a single repaint at the final geometry. Measured on a 120→48 drag: 25 leaked copies at 0ms, 10 at 80ms, 0 at ≥150ms. `resizeDebounceMs: 0` restores the legacy synchronous repaint-per-resize (used by the unit tests that assert immediate reflow). The timer is cleared in `stop()` / `emergencyRestore()`. 

## What lives in here that probably shouldn't

The controller has accumulated a lot of orthogonal responsibilities. Future cleanup candidates:

- The **abort-quit FSM** integration (`abort-quit-fsm.ts`) lives here because Esc/Ctrl+C bytes pass through the controller's key dispatch. Could be extracted as a hook-chain subscriber.
- The **auto-ASK heuristic** subscribes via the public `"input"` event - that's the right shape and probably the model for further extractions.
- The **plugin hook dispatch** (`editor.key`, `editor.buffer.changed`, `editor.footer.set`) is fine as a host-side facade but the dispatch ordering policy with `InputCaptureStack` is subtle and worth keeping its own doc - see [chapter 05](./05-input-pipeline.md).
