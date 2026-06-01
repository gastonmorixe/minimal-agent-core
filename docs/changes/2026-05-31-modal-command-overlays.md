# Modal command overlays: `/config` & `/usage` own the input line

> 2026-05-31. Fixes the broken `/config` UX (several Enters to open, a blinking
> prompt under the overlay, the field-edit syncing with the prompt buffer, and
> `/config` leaking to scrollback). Adds a host "modal overlay" capability so a
> command TUI can OWN the input line — hide the prompt, capture every key, block
> submit — the same thing the host's ask-user modal already did, now exposed to
> plugins over the bus.

## The bugs (all one root cause)

A command overlay painted the footer via `editor.footer.set` but never *owned*
the input. The prompt buffer stayed live underneath the whole time. So:

1. **Several Enters to open `/config`.** The slash-menu completed on Enter by
   rewriting the buffer to `/config ` (trailing space closed the menu) and
   relying on a follow-up submit. That raced the async `editor.buffer.changed`
   re-open, so it took multiple Enters before the command actually dispatched.
2. **A blinking prompt cursor under the open overlay.** Nobody hid the prompt;
   the editor kept rendering + focusing it.
3. **`/config` leaked to scrollback as a prompt.** The overlay was open but the
   editor still owned Enter, so a stray submit went down the normal queue path.
4. **Field edits synced with the prompt.** By design the config edit used the
   prompt buffer as its text input (`editor.buffer.set` + `editor.buffer.changed`).
   With the prompt visible, the typed value appeared in BOTH the prompt and the
   field. The worst tell.

## The fix: a host modal-overlay capability

### Host channels (`src/plugins/hooks/channels.ts`)

- `editor.overlay.open` `{owner}` — a command TUI takes MODAL ownership of the
  input line.
- `editor.overlay.close` `{owner}` — release it (owner-checked, idempotent).
- `command.run` `{line}` — dispatch a registered slash command directly through
  the host registry (no editor buffer / submit). What the slash-menu uses to
  open a command on one Enter.

### EditorController (`src/editor-controller.ts`)

A new `overlayOwner` field. While owned, the editor:

- **hides the prompt row + cursor** (`refreshLiveArea` short-circuits to just the
  status band + decoration + the overlay's footer paint; cursor parked at 0,0);
- **blocks `submit()`** so a stray Enter can never flush the typed `/cmd` (or
  anything) to scrollback;
- **routes every key through the `editor.key` hook** instead of mutating the
  buffer: printable chars arrive as their single-char `key`, Backspace as
  `"Backspace"`. Other control bytes are swallowed so they can't edit the hidden
  prompt. Enter / Esc / Tab / arrows still flow through `dispatchKeyHook`.

`openOverlay(owner)` / `closeOverlay(owner)` are the public methods; the host
wires them to the bus channels in `src/agent/repl-live-area.ts`. This is the
same key-capture + prompt-suppression recipe the ask-user modal
(`src/agent/ask-user-host.ts`) already used; it's now a reusable plugin
capability.

### slash-menu (`ma-slash-menu`, plugins repo)

Enter on a **command** row (category `act`) now emits `command.run` with
`/<slug>` and halts the key, so ONE Enter dispatches the command and opens its
TUI. **Skill** rows (model-routed) keep the buffer-rewrite + submit path. No
more multi-Enter dance, no scrollback leak.

### config (`plugins/config`)

- Emits `editor.overlay.open {owner:"config"}` on open, `editor.overlay.close`
  on close.
- **Field edits now use an internal draft** (`phase.draft` in the FSM), driven
  by `char` / `Backspace` events from `editor.key`. The `editor.buffer.set` /
  `editor.buffer.changed` coupling (and the `on_buffer_changed` handler) are
  gone. The typed value lives in one place: the overlay.
- Header now carries the common chrome: `[icon] title  <chip>  <path>`, a
  full-width top divider, the windowed content, a bottom divider, then the hint
  footer.

### usage (`plugins/usage`)

Emits `editor.overlay.open`/`close` too (browse-only TUI; ownership is what
hides the phantom prompt and blocks the scrollback leak).

## Common command-TUI chrome

```
[icon] title  <chip>  <context>
──────────────────────────────────   top divider
[content / windowed rows]
──────────────────────────────────   bottom divider
[footer hint chips]
```

Plugins can't import each other or the agent, so the chrome is a per-plugin
convention (config implements it in its own `render.ts`), not a shared import.
The host channels are the shared seam; the visual contract is documented here.

## Tests

- Host: 6 new `EditorController` modal-ownership tests (prompt hidden, submit
  blocked + restored on close, printables routed to `editor.key`, Backspace
  routed, owner-checked close, control bytes swallowed). Main gate: 4408 pass.
- config: FSM `char`/`Backspace` draft tests, runtime `editor.overlay.close` on
  close, integration drives edits via the char-key path + asserts overlay
  open/close. usage: overlay open/close.
- slash-menu (plugins repo): command-row Enter → `command.run` + halt; skill-row
  Enter → buffer rewrite, no halt. Plugins gate: 587 pass.

## Decoupling note

Everything stays on the published bus contract. Plugins `import type` the
`CommandInfo` / channel shapes (or mirror them in the plugins repo) and never
reach into harness internals. The command registry is host-owned, so commands
dispatch headlessly whether or not any overlay is installed.
