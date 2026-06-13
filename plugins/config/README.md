# config

Interactive editor for `~/.minimal-agent/config.jsonc`, shipped as the
`/config` slash command plus a footer overlay.

```
  ⚙ config  ● 2 unsaved  ~/.minimal-agent/config.jsonc
  MODEL & REASONING
► model              claude-opus-4-8[1m]
  effort           ● low
  thinkingDisplay    unset → (provider default)
  ──────────────────────────────────────────────  ↓ 11 more
  ↑↓ move · ←/→ change · ⏎ edit/run · esc close

❯
```

## What it does

- `/config` opens an interactive overlay in the editor's footer band. Arrow
  keys move the selection; `←/→` cycle enum + boolean fields in place; `⏎`
  edits a free-text field (type into the prompt, `⏎` to confirm, `esc` to
  cancel); the trailing **Save / Revert all / Close** rows commit or discard.
- Edits are **comment-preserving**. Saving rewrites only the keys you changed
  and leaves every `//` note, block comment, trailing comma, and your key
  order untouched. The surgical writer (`lib/jsonc-edit.ts`) re-validates its
  own output so a bug can never write a broken config.
- The **Plugins** section is discovered at open time: one on/off toggle per
  installed plugin (`plugins.<id>.enabled`), scanning the same roots the host
  loader scans. Third-party plugins under `~/.agents/plugins` show up
  automatically.
- Headless sub-commands for scripting / quick checks:
  - `/config get <field-id>` prints a field's current value.
  - `/config path` prints the resolved config file path.

Most settings take effect on the **next** session (they're read at startup);
the overlay says so. Plugin enable/disable always applies next launch.

## How it's wired (decoupling)

The command is **host-owned**: it's registered through `manifest.commands[]`
and dispatched by the agent's command registry
(`loader.dispatchCommand`), so it works whether or not the `ma-slash-menu`
overlay is installed. The slash menu only adds discoverability by listing the
same registry through `ctx.listCommands()`.

The plugin never imports another plugin or reaches into the agent's editor.
It paints + reads input purely over the shared bus:

| channel | direction | use |
| --- | --- | --- |
| `editor.overlay.open` | plugin → host | take MODAL ownership: hide prompt + cursor, block submit, route every key here |
| `editor.overlay.close` | plugin → host | release ownership; restore the prompt |
| `editor.footer.set` | plugin → host | paint / clear the overlay band |
| `editor.key` (hook) | host → plugin | ALL keystrokes while owned: nav, printables (as single-char keys), Backspace, Enter, Esc |

Because `/config` takes modal ownership, the prompt is hidden and the field
edit draft lives entirely in the FSM (`phase.draft`) — it never shares the
editor's prompt buffer. That sharing was the old bug where the typed value
showed up in BOTH the prompt and the field. The host's ask-user modal uses the
same key-capture + prompt-suppression recipe; `editor.overlay.*` exposes it to
plugin command TUIs over the bus.

## Layout

```
plugins/config/
├── manifest.json            # command + editor.key hook + buffer.changed event
├── handlers/                # imperative shell (binds host ctx → pure core)
│   ├── cmd_config.ts        #   /config — opens the modal overlay (or headless)
│   ├── on_key.ts            #   editor.key → FSM nav/edit (incl. printables + Backspace)
│   └── wiring.ts            #   the ONLY node:fs / node:path / env access
└── lib/                     # pure functional core (host-free, fully tested)
    ├── schema.ts            #   declarative field list (mirrors UserConfig)
    ├── discovery.ts         #   scan plugins → dynamic enable/disable fields
    ├── jsonc-edit.ts        #   comment-preserving set/removeKeyPath
    ├── mini-jsonc.ts        #   strip-comments JSONC parse (validation)
    ├── model.ts             #   ConfigModel: load / stage / diff / save
    ├── fsm.ts               #   pure overlay state machine
    ├── view.ts              #   ConfigModel + state → rows + RenderModel
    ├── render.ts            #   RenderModel → ANSI footer lines
    ├── runtime.ts           #   effect applier (the testable shell core)
    ├── state.ts             #   per-process singleton (FSM state + model)
    └── palette.ts           #   style facade backed by plugin-api palette/ANSI helpers
```

The `lib/` core has **zero** host imports — it talks only in plain data, so
every piece is unit-testable in isolation. The handlers are the thin shell
that maps host context to the core and applies the resulting effects.

## Adding a setting

Append a `Field` to `SCHEMA` in `lib/schema.ts` (id, label, help, `kind`,
`path`, `section`, optional `choices` / `defaultHint`). That's the whole
edit surface. For the value to actually *do* something, add the matching
reader to the agent's `src/config.ts` (the host owns parsing). A field the
host doesn't read is simply ignored, so the two can drift safely.

## Tests

```sh
bun test plugins/config        # ~80 tests: lib units + integration
```
