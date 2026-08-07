---
title: Input pipeline
created_at: "2026-05-27T10:14:30.725679000-0400"
updated_at: "2026-05-27T10:14:30.725679000-0400"
tags: [tui, input, capture-stack, hooks, escape-parsing, fsm]
taillog:
 - "2026-05-27T10:14:30.725679000-0400 | Initial: input dispatch chain, capture stack, bracketed paste, abort FSM"
---

# Input pipeline

How one byte from stdin becomes a buffer mutation (or an abort, or a paste, or a mode toggle).

## The chain

```
┌───────────────────────────────────────────┐
│               ESC / key byte              │
└─────────────────────┬─────────────────────┘
                      ▼
              bracketed paste?
              ┌──────┴──────┐
             yes            no
              │              │
              ▼              ▼
       paste buffer       bare ESC?
       -> insert     ┌────────┴────────┐
                    yes               no
                  (wait              (parse
                bareEscapeMs)          CSI)
                     │                 │
                     └────────┬────────┘
                              ▼
                  InputCaptureStack.dispatch
                  ┌───────┬───────────┐
                claimed   not claimed
                  │           │
                  ▼           ▼
              transient   editor.key hook chain
              overlay     ┌─────┬──────────┐
              handler   claimed   not halted
                          │            │
                          ▼            ▼
                       plugin      abort-quit FSM
                       handler  ┌──────┬──────┐
                              esc/^C  default text
                                │           │
                                ▼           ▼
                          abortBus      EditorBuffer
                          .requestAbort  mutation
                                              │
                                              ▼
                                  scheduleRepaint -> setLiveArea
```

## Stage 1: bracketed paste

`EditorController.start` enables bracketed paste (`ESC[?2004h`). When the terminal wraps a paste in `ESC[200~ ... ESC[201~`, the controller routes the entire payload to `EditorBuffer.insert(payload)` as a single atomic operation. No per-byte key dispatch, no abort heuristics - large pastes are common.

The paste also bypasses the per-line submission heuristic: a paste containing `\n` produces multi-line buffer content, it does NOT submit on the first newline.

## Stage 2: bare-Esc disambiguation

Esc (`\x1b`) is the lead byte of every CSI escape sequence (`\x1b[A`, `\x1b[200~`, …). When we see a lone `\x1b` in `pending`, we cannot tell yet whether it's "user pressed Esc and stopped" or "more bytes are en route across a second stdin chunk".

Strategy: arm a `bareEscapeMs`-ms timer. If no follow-up bytes arrive before it fires, treat the byte as a true bare Esc and route it to `AbortBus.requestAbort`. Default 20ms - short enough to feel instant, long enough to swallow the cross-chunk gap on typical terminals.

This is why pasted text starting with `\x1b` followed by `[A` (raw escape sequence) reads as an arrow key on hosts that don't bracket the paste: the second chunk arrives well within 20ms and the FSM never fires.

## Stage 3: `InputCaptureStack`

Source: `src/input-capture-stack.ts`. A LIFO stack of transient input claimers that sits in FRONT of the durable hook chain.

```ts
const dispose = inputCaptureStack.push({
  onKey(key: NormalizedKey): "claimed" | "not-claimed" { … }
})
// when overlay closes:
dispose()
```

Why this exists (and why it's not the `editor.key` hook chain):

| Hook chain | Capture stack |
|---|---|
| **Durable** subscribers - lifetime spans the session | **Transient** captures - open and close mid-session |
| Static `priority` declared once at registration | LIFO: top of stack claims first |
| Plugins with manifest entries | Reflection cooldown, confirm modals, no manifest |
| Examples: history, slash-menu, autocomplete | Reflection cooldown (~60s mid-turn), future "save changes? [y/N]" |

Two overlays may be open at once. The one that opened LAST should close FIRST. A priority chain can't express "most recently pushed" without ad-hoc fiddling. The stack is the smallest abstraction that gets this right.

Safety contract (from the source):

- **Single source of truth**: module-level singleton `inputCaptureStack` shared by `EditorController` (consumer) and any push-side caller. Tests construct a fresh `InputCaptureStack` and inject it.
- **Out-of-order release is safe**: removing a capture from the middle of the stack does not disturb the others. Needed when the slash-menu was below the reflection cooldown but the user pressed Enter on the menu (closing it) before the cooldown elapsed.
- **Handler errors are absorbed**: a throwing handler is logged (best-effort) and treated as "did not claim", so a buggy capture cannot trap subsequent ones or wedge the dispatch loop.

## Stage 4: `editor.key` hook chain

The plugin facade. Subscribed via a plugin's manifest:

```ts
// plugin manifest
hooks: ["editor.key"]

// plugin code
hooks.on("editor.key", (key) => {
  if (key.name === "up" && this.isHistoryShortcut(key)) {
    this.cycleBack()
    return "halt"
  }
  return "pass"
})
```

Ordered by static `priority`. Loaded once at session start; lifetime spans the session. The chain is sequential - a `"halt"` short-circuits the rest of the chain (and the abort-quit FSM after it).

## Stage 5: abort-quit FSM

Source: `src/abort-quit-fsm.ts`. The only place that can request an abort or quit. Inputs: Esc (after bare-Esc disambiguation passes the chain unclaimed), Ctrl+C, plain text. Outputs:

- **default text** → `EditorBuffer` mutation → `repaint`
- **Esc / Ctrl+C** with no pending state → first press: warn ("press again to ..."), arm the footer with `setFooterLayer(FOOTER_LAYER_ARMED, ...)`
- **Esc / Ctrl+C** with armed state → fire `cancel` or `quit` event

The two-press requirement is intentional: a single accidental Ctrl+C must not kill the REPL mid-thought. The armed state self-disarms after a few seconds or any non-abort keystroke.

## Editor-side modes

`RawInput` (`src/input.ts`) has three lifecycle states. Note: `RawInput` is the legacy mount-per-read implementation; `EditorController` is the persistent replacement that shares the same key parsing.

| State | Description |
|---|---|
| `"idle"` | no listeners installed; raw mode off (default) |
| `"ambient"` | persistent stdin ownership; only global shortcuts (mode cycling, Ctrl+C) are processed. Used between turns AND while a turn is streaming so the user can prepare the next turn (e.g. cycle into ASK mode) without waiting for the response to finish. |
| `"reading"` | full input editing. Set transitionally inside `read()` |

`EditorController` is essentially `"reading"` permanently from the moment `start()` is called until `stop()` or process exit. Mode cycling lives in `editor.key` hooks driven by `ModeManager`.

## Terminal capability flags enabled at start

```
ESC[?2004h           bracketed paste on
ESC[>31u             kitty keyboard protocol on (level 31)
ESC[>4;1f            xterm formatOtherKeys = 1 (CSI escape per non-printable)
ESC[>4;2m            xterm modifyOtherKeys = 2 (modifiers reported on all keys)
```

These give us:

- Distinguishable Ctrl+I vs Tab, Ctrl+M vs Enter, etc.
- Modified function keys (Shift+Tab, Ctrl+ArrowLeft)
- Atomic paste handling

All flipped off in `emergencyRestore()` and on `stop()`.
