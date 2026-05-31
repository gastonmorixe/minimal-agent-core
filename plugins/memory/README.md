# memory plugin

Persistent cross-session memory plus a per-session short-term scratchpad.
Three scopes:

| Scope | File | Lifetime |
|---|---|---|
| `global` | `~/.minimal-agent/memory.md` | persistent, per-user, cross-project |
| `project` | `~/.minimal-agent/projects/<absolute-cwd>/memory.md` | persistent, per-user, per-project |
| `short-term` | `~/.minimal-agent/sessions/<sid>.scratch.md` | one session |

All three live OUTSIDE the project tree, never committed, never shared
with collaborators.

## What it contributes

| Surface | Trigger | Handler |
|---|---|---|
| Tool | `MemoryTool` | `handlers/memory_tool.ts` |
| Inline tag | `<ma::emit::memory>` | `handlers/memory.ts` |
| Prompt fragment | `id: memory_load` | `handlers/load.ts` |

The inline tag is the zero-friction save path (mid-response). The tool
handles list/read/edit/remove and is also a valid save path. The prompt
fragment loads the short-term scratchpad into every user turn and (if
the user has opted in via `plugins.memory.inject`) the persistent
memories too.

## Files

- `manifest.json`: tool + tag + fragment declarations.
- `handlers/memory.ts`: `<ma::emit::memory>` inline save.
- `handlers/memory_tool.ts`: `MemoryTool` actions.
- `handlers/load.ts`: prompt-fragment producer (reads the scratchpad
  + optionally the persistent files).
- `lib/memory-config.ts`: config schema (`scope.inject = "off" | "verbatim" | "summary"`).
- `cli.ts`: out-of-agent inspection.
- `PROMPT.md`: model-facing policy: when to query, when to save, three
  scopes, decision tree.

## Save echo

Saves via the inline tag emit a `<ma::agent::memory-saved scope="..." id="...">`
attachment on the next user turn. That's how the model learns the
bullet id without round-tripping through `MemoryTool list`.

## Storage format

Per-bullet markdown line of the form `[<isots>] <body>` for persistent
scopes; short-term uses an incrementing integer id.

## Namespacing (testing)

Set `MINIMAL_AGENT_MEMORY_NAMESPACE=<name>` to rebase every storage
path under `~/.minimal-agent/namespaces/<name>/...`. Useful for testing
memory behavior without polluting real files.

## Disabling

`plugins["memory"].enabled = false` in `~/.minimal-agent/config.jsonc`.
`MemoryTool` disappears from the tool list and the prompt fragment is
omitted.
