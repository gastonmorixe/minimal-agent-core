# Plugin system: `enabled` flag, `tui-plugins` rename, `<ma::*>` schema migration

Status: in progress · 2026-05-28

## Motivation

Three intertwined cleanups that landed together because they touch the
same surface (the plugin loader, the system prompt block, and every
model-facing attachment):

1. **Plugins should be able to ship disabled.** Until now, a manifest
   that was discovered was loaded; the only opt-out was user-side
   (`plugins.<id>.enabled = false` in `~/.minimal-agent/config.jsonc`).
   Some plugins (interleave-thinking, anything experimental) want to be
   present in the embedded directory but off until the user opts in.
2. **`tui-plugins` is a misnomer.** The plugin system was originally
   scoped to TUI concerns and the name stuck. It's no longer accurate:
   plugins contribute prompt fragments, hooks, modes, live-area slots,
   tools, etc. Renaming to plain `plugins` matches what it does.
3. **`<ma::*>` is the only allowed attachment tag namespace.** Mixed
   conventions accumulated (`<short-term-memory>`, `<memory-saved>`,
   `<ma::tui::tasks>`, plus a bracket form `[raw-output: ...]`). All
   model-facing attachments now use a uniform schema: `<ma::agent::*>`
   for the agent runtime, `<ma::plugin::<id>(::sub)?>` for plugin-
   contributed text. Brackets are forbidden.

## Schema

### Top-level system prompt block

```xml
<ma::plugins>
  <ma::plugins-overview>...one-paragraph orientation...</ma::plugins-overview>
  <ma::plugin id="ask-mode">...PROMPT.md body...</ma::plugin>
  <ma::plugin id="diff-view">...</ma::plugin>
  ...
</ma::plugins>
```

The wrapper element was `<tui-plugins>`; the per-plugin element was
`<plugin id="...">`. Both now sit under the `<ma::*>` namespace.

### Agent-emitted attachments

| Old | New |
| --- | --- |
| `<ma::reflection-checkpoint round="N" cooldown-applied-seconds="S" />` | `<ma::agent::reflection-checkpoint round="N" cooldown-applied-seconds="S" />` |
| `<ma::reflection-ack silence-for="K" reason="..." />` | `<ma::agent::reflection-ack silence-for="K" reason="..." />` |
| `<ma::emergency-cap-triggered round="N" />` | `<ma::agent::emergency-cap-triggered round="N" />` |
| `<ma::tui-preview shown=N total=M tool=T>...</ma::tui-preview>` | `<ma::agent::output-preview shown="N" total="M" tool="T">...</ma::agent::output-preview>` |
| `<ma::mode-active id="..." since="..." />` | `<ma::agent::mode-active id="..." since="..." />` |
| `<ma::mode-change from="..." to="..." at="..." />` | `<ma::agent::mode-change from="..." to="..." at="..." />` |
| `[raw-output: <path>  <size> · sha256=<hex>]` | `<ma::agent::raw-output path="..." size="..." sha256="..." />` |

The reflection-ack tag is in `<ma::agent::*>` even though the model
emits it: the namespace tracks ownership of the protocol, not the
emitter. The agent core owns reflection.

### Plugin-emitted attachments

| Old | New |
| --- | --- |
| `<ma::tui::tasks ...>...</ma::tui::tasks>` | `<ma::plugin::tasks ...>...</ma::plugin::tasks>` |
| `<short-term-memory>...</short-term-memory>` | `<ma::plugin::memory::short-term>...</ma::plugin::memory::short-term>` |
| `<memory-saved scope="..." id="...">...</memory-saved>` | `<ma::plugin::memory::saved scope="..." id="...">...</ma::plugin::memory::saved>` |

### Inline-tag triggers (model emits, plugin handles)

The scanner's opener probe moves from `<tui::` to `<ma::plugin::`. The
manifest `inline_tag.tag` field stays a bare name (`"diff"`,
`"memory"`, `"interleave-thinking"`); the runtime composes
`<ma::plugin::diff>...</ma::plugin::diff>` (etc.) and the scanner
matches that composed form.

| Old | New |
| --- | --- |
| `<tui::diff>...</tui::diff>` | `<ma::plugin::diff>...</ma::plugin::diff>` |
| `<tui::memory scope="...">...</tui::memory>` | `<ma::plugin::memory scope="...">...</ma::plugin::memory>` |
| `<tui::interleave-thinking>...</tui::interleave-thinking>` | `<ma::plugin::interleave-thinking>...</ma::plugin::interleave-thinking>` |

### Escape form

The scanner's escape moves from `\<tui::` to `\<ma::plugin::`.

## Manifest schema additions

`enabled` (optional, default `true`): when set to literal `false`, the
loader skips this manifest at discovery time with a logger note. User
config can still override (a user-config `enabled: true` brings a
manifest-disabled plugin back, since user config is checked LAST).

```json
{
  "id": "interleave-thinking",
  "name": "Interleave Thinking",
  "version": "0.2.0",
  "description": "...",
  "enabled": false
}
```

Precedence (loader perspective):

1. User config `plugins.<id>.enabled === false` → DISABLED, manifest never read.
2. User config `plugins.<id>.enabled === true` → ENABLED (overrides manifest opt-out).
3. Manifest `enabled === false` → DISABLED.
4. Otherwise → ENABLED (the default).

## Directory rename

| Old | New |
| --- | --- |
| `<repo>/tui-plugins/` | `<repo>/plugins/` |
| `~/.agents/tui-plugins/` | `~/.agents/plugins/` |
| `<cwd>/.agents/tui-plugins/` | `<cwd>/.agents/plugins/` |

Symlinks in the plugin repo (`~/Projects/minimal-agent-plugins`) are
re-pointed accordingly.

## Migration policy for session-replay

Old session files contain the legacy attachment forms. The replay
scanner accepts BOTH the legacy bare/`<ma::*>` forms and the new
`<ma::agent::*>` / `<ma::plugin::*>` forms during this window, so users
can resume sessions started before the migration. New writes always
use the new form.

## Files touched

(See the diff. Roughly: manifest parser, loader, scanner, all attachment
producers, session-replay, every test that asserts a literal tag string,
all PROMPT.md files, README/CHANGELOG/docs, plus the mirror in the
plugin repo.)
