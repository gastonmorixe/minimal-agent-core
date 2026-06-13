# feat(repl): abort-quit FSM, plugin-dispatch abort wiring, goodbye banner

2026-05-19 — final fix for the family of bugs around "the agent doesn't
abort when I press Esc/Ctrl+C" + the family of UX gripes around "Ctrl+C
silently quit my session". Closes the user-reported stuck-Fetch
scenario from session `d5e415fb` (Fetch hung 15+ minutes, no abort
worked) AND the broader Ctrl+C UX overhaul.

## Why

Two underlying bugs converged:

1. **Plugin tools didn't see the agent's per-turn `AbortSignal`.**
   `loader.dispatch(trigger, cwd)` made its own internal
   `AbortController` bounded only by the manifest `timeoutMs`. When the
   user pressed Esc / Ctrl+C, `abortBus.requestAbort` fired, the agent's
   turn-level signal aborted — but `ma-fetch` / `WebSearch` / future
   plugin tools never saw it, because no third argument was threaded
   through. Pipeline hung until manifest timeout.

2. **`Ctrl+C` on idle empty buffer was instant exit.** No confirmation.
   Users who pressed Ctrl+C while idle (very common: "wait, that's not
   right, let me retype") accidentally killed their session and lost
   conversation context.

Both fixed in this change.

## Spec (#abort-quit-ux-spec — user-mandated, saved as `mpd09k9l-0900`)

| State    | Input          | Behavior                                                                |
| -------- | -------------- | ----------------------------------------------------------------------- |
| working  | ESC            | Abort, restore prompt, NO confirm                                       |
| working  | Ctrl+C ×1      | Abort, restore prompt, ARM 10s quit window (NO confirm yet)             |
| working  | Ctrl+C ×2 fast | Quit immediately (escape hatch)                                         |
| idle     | Ctrl+C ×1      | Arm 10s quit window: "press Ctrl+C again within Xs to quit"             |
| idle     | Ctrl+C ×2 fast | Quit immediately (escape hatch)                                         |
| any      | Ctrl+C ×3+     | Quit immediately (hard guarantee even if FSM wedges)                    |
| armed    | Ctrl+C         | Quit:confirmed → goodbye banner, process.exit(0)                        |
| armed    | ESC            | Cancel modal, back to idle (ESC is not a quit signal)                   |
| armed    | type / arrow   | Cancel modal, back to idle (user re-engages)                            |
| armed    | tick at 10s    | Cancel modal, back to idle (auto-dismiss)                               |

Escape-hatch threshold: 500ms between consecutive Ctrl+Cs.

## Architecture

### `src/abort-quit-fsm.ts` — pure transducer

`step(state, input, opts) → {state, effects[]}`. No timers, no IO, no
closures. Effects (`abort-turn`, `show-armed`, `hide-armed`, `quit`) are
applied by the host. Full transition table in the module docstring;
37 unit tests cover every row + inverse-direction guards.

`EscapeHatch` class is separate from the FSM: rapid double Ctrl+C is a
backstop the host applies BEFORE feeding the FSM, so a wedged FSM cannot
prevent quit. (6 unit tests.)

### `src/ui/chrome/armed-footer.ts` — countdown renderer

Pure `formatArmedFooter({source, expiresAt, now}) → string | null`.
Returns null when expired. Countdown rounds up so a fresh 10s window
reads "10s" not "9s". Different copy for `idle-confirm` ("ready to
quit") vs `post-abort` ("aborted"). (12 unit tests.)

### `src/ui/chrome/goodbye-banner.ts` — quit footer

`formatGoodbye({sessionId, reason}) → string[]` and `printGoodbye(...)`.
Frame chrome matches startup banner (`╭│╰`, pink brand, lime ✦). The
`--resume <sid>` line stands alone for triple-click copy-paste. Degraded
copy when sessionId missing. (12 unit tests, including snapshot of the
copy-paste-safe trailing-character rule.)

### `src/editor-controller.ts` — integration

Owns the FSM instance + `EscapeHatch` + a recurring 250ms tick painter
for the countdown. New methods on `ReplEditor` interface:
`notifyTurnStart()` and `notifyTurnEnd()` so the REPL signals turn
boundaries to the FSM. New `"quit"` event with reason; legacy
`"cancel"` event is still emitted for back-compat (draft-store cleanup
listener continues to work).

The Ctrl+C handler (formerly: cancel-on-empty / clear-on-content) is
now FSM-routed. The bare-Esc handler routes to FSM `esc` input. Any
other keystroke while armed feeds `printable` to dismiss.

### `src/plugins/loader.ts` — abort wiring

`dispatch(trigger, agentCwd, externalSignal?)` accepts an optional
caller-provided `AbortSignal` and OR-s it with the internal
`timeoutMs` controller. Either source aborts `ctx.abort`. The agent
forwards the per-turn signal in `src/agent.ts:1144`. Plugins already
listen on `ctx.abort` and do SIGTERM→SIGKILL escalation
(see `ma-fetch/lib/backend.ts`); they're now reachable.

### `src/agent.ts` runReplLiveArea — turn lifecycle

- `editor.notifyTurnStart()` before `abortBus.beginTurn()` so the FSM
  enters `working` state and dismisses any stale armed footer.
- `editor.notifyTurnEnd()` in the turn `finally`, after `endTurn()`.
- New optional `sessionId` opt threaded from `src/index.ts` via
  `getSessionId()` into the goodbye banner print.
- `printGoodbye(...)` called AFTER `editor.stop()` + `compositor.unmount()`
  so the banner lands in normal scrollback with terminal in cooked
  mode.

## TDD trail

| Phase | Type   | Tests added | Result |
| ----- | ------ | ----------- | ------ |
| 0     | RED    | 4 (loader dispatch external signal) | 2 fail at 5s timeout — bug reproduced |
| 1     | GREEN  | same 4 | 4 pass; abort fires in 33ms |
| 2/3   | unit   | 37 (FSM transitions + EscapeHatch) | green |
| 4     | unit   | 12 (armed-footer renderer) | green |
| 5     | unit   | 12 (goodbye banner) | green |
| 8     | rewrite| 5 (Ctrl+C policy in EditorController) | green |
| 9     | tmux   | 1 (end-to-end Ctrl+C×2 → banner) | green |

Total: 71 new tests across 5 new test files. Full suite: 2356 pass / 0 fail / 5 skip.

## Files

New:
- `src/abort-quit-fsm.ts` + `.test.ts`
- `src/ui/chrome/armed-footer.ts` + `.test.ts`
- `src/ui/chrome/goodbye-banner.ts` + `.test.ts`
- `src/quit-confirm-tmux.test.ts`
- `tmp/quit-confirm-tmux-driver.ts` (local-only regression guard)
- `tmp/quit-armed-footer-tmux.ts` (local-only)

Modified:
- `src/agent.ts` — wired notifyTurnStart/End, sessionId opt, printGoodbye on quit, plugin-dispatch signal forwarding, `"quit"` event on ReplEditor
- `src/editor-controller.ts` — FSM ownership, EscapeHatch, armed-footer painter, tick timer
- `src/editor-controller.test.ts` — rewrote 2 old-policy tests, added 5 new-policy tests
- `src/plugins/loader.ts` — `externalSignal` param on `dispatch()`, OR-composed with internal timeout
- `src/plugins/loader.test.ts` — 4 new abort-propagation tests
- `src/index.ts` — pass `sessionId: getSessionId()` to runRepl

## Migration notes

The legacy `editor.on("cancel", listener)` still fires (with a reason
argument now), so `draft-store-editor` cleanup continues to work
unchanged. Listeners that want the structured reason can subscribe to
`editor.on("quit", (reason) => ...)` instead.

`loader.dispatch(trigger, cwd)` (2-arg form) is fully back-compatible;
the new third argument is optional.
