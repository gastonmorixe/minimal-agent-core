# `history` plugin

Persistent ↑/↓ recall for the prompt editor (`❯ `). Submitted prompts are
appended to two newline-delimited JSON files and recalled via arrow keys.

This is a UX layer for the human user. **No model-facing surface, no
tools, no inline tags, no PROMPT.md** the loader treats this plugin as
silent in the system prompt.

## Key bindings

- **↑ on an empty-or-recalled buffer** when the cursor sits on the FIRST
  visual row recalls the previous submitted prompt.
- **↓ on the LAST visual row** of a recalled buffer walks toward newer
  entries. Overshoot past the newest entry restores the user's
  pre-recall draft.
- **Ctrl+R** is reserved for a future incremental reverse-search modal.
  For now it's a silent no-op.

## Storage

Per-user, never in the project tree, never committed:

- `~/.minimal-agent/projects/<absolute-cwd>/history.jsonl`: primary
  recall index for the current project.
- `~/.minimal-agent/history.jsonl`: global mirror, useful for future
  cross-project search.

Each entry is a single JSON line:

```json
{"id":"...","ts":1700000000000,"sid":"...","cwd":"/abs/path","text":"...","exit":0}
```

Stable wire format, append-only, never rewrite an existing line.

## CLI

Inspect / manage outside the agent:

```sh
bun run plugins/history/cli.ts list           # newest-first
bun run plugins/history/cli.ts search <query> # case-insensitive substring
bun run plugins/history/cli.ts path           # show the resolved file
bun run plugins/history/cli.ts clear          # wipe (with confirm)
```

## Disabling

- `MINIMAL_AGENT_NO_HISTORY=1` for one-off invocations.
- `plugins.history.enabled = false` in `~/.minimal-agent/config.jsonc` to
  turn it off permanently.
