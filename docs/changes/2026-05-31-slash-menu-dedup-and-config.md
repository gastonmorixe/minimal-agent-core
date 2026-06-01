# Slash menu: one overlay, registry-driven; `/config` interactive editor

> 2026-05-31. Removes the duplicate in-repo slash overlay so a single menu
> drives the prompt, and confirms the `/config` interactive editor + the
> command registry it rides on. No command is hardcoded anywhere: the menu
> lists exactly what plugins register, plus skills by convention.

## The bug

Two slash overlays were live at once:

- `plugins/slash-menu` (in this repo) — commands-only autocomplete. Hooks
  `editor.buffer.changed` + `editor.key` (priority 70), paints `editor.footer.set`.
- `ma-slash-menu` (external, `minimal-agent-plugins`, installed under
  `~/.agents/plugins` and `~/.minimal-agent/plugins`) — commands **and** skills,
  token-cost chips, `/` and `$` triggers. Also hooks `editor.key` (priority 70)
  and paints `editor.footer.set`.

The host footer overlay is a single shared layer (last-writer-wins) and both
plugins claimed the same `editor.key` band, so they fought over every keystroke
and every repaint. Distinct manifest ids (`slash-menu` vs `ma-slash-menu`) meant
the loader's id-dedup didn't collapse them — both loaded.

Separately, the external plugin had carried a hardcoded `BUILTIN_ACTIONS` array
(`/config`, `/memory`, `/tasks`, `/help`, …) that advertised commands no plugin
registered, so selecting one dispatched to nothing.

## The fix

1. **Deleted the in-repo `plugins/slash-menu`.** The external `ma-slash-menu` is
   the single overlay: same host registry via `ctx.listCommands()`, plus skills +
   token chips + `/`/`$` triggers. Nothing in `src/` imported the removed dir.

2. **Killed the hardcoded action list in `ma-slash-menu`** (committed in the
   plugins repo). `BUILTIN_ACTIONS` is gone; `providers/actions.ts` is now a pure
   `commandItems(CommandInfo[]) → Item[]` map over the host's live registry, and
   `lib/state.ts` calls `refreshItems(ctx.listCommands?.())` on every handler tick
   so a newly-registered command appears without a relaunch. Skills stay cached.

The result: the menu shows exactly the commands that actually dispatch
(`/config`, `/usage`, `/loop`, `/schedule` today) plus discovered skills. Select a
command row and Enter rewrites the buffer to `/<name>` and submits, so the host's
`dispatchCommand` runs it as a real command.

## Why this is the right seam (decoupling)

The COMMANDS contract is **host-owned**, in `src/plugins/types.ts`:
`ManifestCommand`, `CommandHandler`, `CommandContext`, `CommandResult`,
`CommandInfo`. A plugin declares `commands[]` in its `manifest.json`; the loader
collects them into one registry (`getCommands` / `hasCommand` / `listCommandInfo`
/ `dispatchCommand`) and injects a read-only `listCommands()` into hook + event
handler contexts. So:

- Commands dispatch **headlessly** — they work with no overlay installed.
- An overlay is a pure **consumer** of the registry; it never owns or stores
  commands, and never imports another plugin. It mirrors the `CommandInfo` type
  rather than importing it (the plugin↔plugin / plugin↔agent import ban).
- The slash menu lists **registered commands + skills** only. No hardcoding.

## `/config` — the interactive editor

`/config` (in `plugins/config`, registered via `manifest.commands[]`) opens an
interactive overlay in the editor's footer band. It is fully decoupled the same
way: a pure `lib/` core (schema, FSM, comment-preserving JSONC writer, view,
renderer, palette) with **zero** host imports, and a thin handler shell that talks
only over the bus (`editor.footer.set`, `editor.buffer.set`, `editor.key`,
`editor.buffer.changed`).

- Sectioned field list (Model & reasoning / Session behavior / Terminal &
  rendering), windowed scroll, dim `unset → default-hint` rows, a per-field
  dirty dot, and an `● N unsaved` / `(saved)` header chip.
- `↑/↓` move; `←/→` cycle enum + boolean fields in place; `⏎` edits a free-text
  field inline (with a live caret); trailing Save / Revert all / Close rows.
- Saving is **comment-preserving** — only changed keys are rewritten; every `//`
  note, block comment, trailing comma, and key order is left untouched, and the
  writer re-validates its own output.
- Headless: `/config get <id>` prints a field's value; `/config path` prints the
  resolved config file path.
- The Plugins section is discovered at open time: one on/off toggle per installed
  plugin (`plugins.<id>.enabled`), scanning the same roots the host loader scans.

Adding a setting is a one-entry append to `SCHEMA` in `plugins/config/lib/schema.ts`
(plus the matching reader in `src/config.ts` for it to take effect).

## Verification

- Command registry (real `PluginLoader` against the embedded plugins): registers
  `/config`, `/usage`, `/loop`, `/schedule`; `dispatchCommand` runs them; unknown
  `/foo` and pasted `/usr/bin` fall through to a normal prompt. Unchanged before
  and after the in-repo deletion (the registry is host-owned).
- Load precedence: the stale buggy clone at `~/.minimal-agent/plugins` (user root)
  is shadowed by the fixed copy at `~/.agents/plugins` (home root), so the dead
  `BUILTIN_ACTIONS` code never runs even though it is still on disk in that clone.
- Gate green: `bun run check` — typecheck, lint, format, biome, docs, 4399 tests.
- Plugins repo gate green: `bun run check` — 586 tests.

## Follow-up (not blocking)

The user-root clone `~/.minimal-agent/plugins/ma-slash-menu-plugin` is a stale
checkout (pre-fix `BUILTIN_ACTIONS`). It is inert (shadowed), but it should be
refreshed once the plugins-repo fix is pushed to its remote, so the dead code
isn't sitting on disk as a footgun.
