# `history` plugin

Adds persistent prompt-input history to the `❯ ` editor. The model does
not interact with this plugin directly. It's a UX layer for the human
user. There are no tools or inline tags.

The plugin emits no information into the system prompt that affects
model behavior. The human-facing UX is:

- **↑ on an empty-or-recalled buffer** when cursor sits on the FIRST
  visual row recalls the previous submitted prompt.
- **↓ on the LAST visual row** of a recalled buffer walks toward newer
  entries. Overshoot past the newest entry restores the user's pre-recall
  draft.
- **Ctrl+R** is reserved for a future incremental reverse-search modal.
  For now it's a silent no-op.

Storage is per-user (never in the project tree, never committed):

- `~/.minimal-agent/projects/<absolute-cwd>/history.jsonl`, primary
  recall index for this project.
- `~/.minimal-agent/history.jsonl`, global mirror, useful for future
  cross-project search.

Each entry is a single JSON line of the form
`{"id","ts","sid","cwd","text","exit"}`. Stable wire format,
append-only, never rewrite an existing line.

Inspect / manage outside the agent via:

```
bun run tui-plugins/history/cli.ts list           # newest-first
bun run tui-plugins/history/cli.ts search <query> # case-insensitive substring
bun run tui-plugins/history/cli.ts path           # show the resolved file
bun run tui-plugins/history/cli.ts clear          # wipe (with confirm)
```

Disable entirely with `MINIMAL_AGENT_NO_HISTORY=1` (env) or
`plugins.history.enabled = false` (config).
