# tasks plugin

Per-session task list. Plan multi-step work, mark progress as you go,
the user sees a live TODO. Single `Task` tool with action switch.

## Visual

```
╭ ○ Tasks · ✔ marked done #d04c91 · 3/9
│
│    1  ✔  #a7b3c4  Add contextSize to SessionTokens
│    2  ✔  #f8e21a  Update addSessionUsage callers
│    3  ◐  #d04c91  Update src/session-tokens.test.ts
│         ├  ✔  #d04c91a  Zero-state includes contextSize
│         ├  ◐  #d04c91b  Replace-not-accumulate semantics
│         ╰  ○  #d04c91c  Multi-turn growth pinned
│    4  ○  #b18f73  Update renderSessionSegment in render.ts
│    5  ○  #e3a5d8  Update showSession gate
│    6  ○  #c91428  ✘ Remove the legacy cached column  (canceled by user)
│    7  ○  #7b8f92  Run biome format + lint
│    8  ○  #3a91c4  Run full test suite
│
╰  3 done · 1 doing · 5 todo · 1 canceled
```

Glyphs are pure unicode (no nerd-font, no emoji):

| Glyph | Status      | Color           |
|-------|-------------|-----------------|
| `○`   | todo        | dim             |
| `◐`   | doing       | sky (accent)    |
| `✔`   | done        | bold lime       |
| `✘`   | canceled    | dim red (title prefix) |

## Files

```
plugins/tasks/
├── manifest.json
├── PROMPT.md                   # model-facing usage rules
├── README.md                   # this file
├── cli.ts                      # `bun run plugins/tasks/cli.ts <cmd>`
├── integration.test.ts
├── lib/
│   ├── parse.ts                # id gen, JSONL serialize/parse, types
│   ├── store.ts                # TaskStore class (CRUD + ordering + rollup)
│   ├── render.ts               # ANSI / plain renderer
│   └── attachment.ts           # <ma::agent::tasks> per-turn producer
└── handlers/
    └── task_tool.ts            # the Task tool dispatch
```

State on disk: `~/.minimal-agent/sessions/<sid>.tasks.jsonl`, one task
per line, order = display order.

## Tool actions

| action      | required           | optional                          |
|-------------|--------------------|----------------------------------|
| `add`       | `title`            | `parent`, `after`, `status`       |
| `add_many`  | `titles[]`         | `parent`                          |
| `update`    | `id`, `title`      |                                   |
| `status`    | `id`, `status`     | `reason` (for canceled)           |
| `start`     | `id`               | `parallel` (allow sibling doing)  |
| `done`      | `id`               |                                   |
| `remove`    | `id`               |                                   |
| `reorder`   | `order[]` (ids)    |                                   |
| `list`      |                    | `filter`, `query`, `format`       |
| `clear`     |                    | `force` (if any task `doing`)     |

Every action returns the post-mutation rendered list in `display` so the
user sees the new state after every change.

## Id formats accepted

- Position (1-indexed integer): `3`
- Bare hash: `"a7b3c4"`
- Prefixed hash: `"#a7b3c4"`
- Subtask hash: `"a7b3c4a"` (parent + alpha suffix)

## CLI

```sh
bun run plugins/tasks/cli.ts list
bun run plugins/tasks/cli.ts add "Make plan visible"
bun run plugins/tasks/cli.ts done 1
bun run plugins/tasks/cli.ts status 2 canceled "user redirected"
```

Reads the same session id (`MINIMAL_AGENT_SESSION_ID` env or
`--sid <uuid>` flag) as the in-agent tool.

## Auto-injection

A `<ma::agent::tasks total="…" done="…" doing="…" todo="…" canceled="…">…</ma::agent::tasks>`
attachment is prepended to the first user message of every `Agent.run`,
so the model always knows the current plan. Omitted when zero tasks
exist. No token cost unless tasks are in play.

## Design doc

`docs/changes/2026-05-12-feat-tasks-plugin.md` records the alternatives
considered and the rationale for each choice (visual variants, id
scheme, status state machine, on-disk format).
