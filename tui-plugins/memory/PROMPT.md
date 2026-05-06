The `memory` plugin gives you persistent, per-user memory across sessions.

## Mental model

Think of memory as **two notebooks you carry between sessions**:

| Scope     | File                                                       | Contains                                                                          |
| --------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `global`  | `~/.minimal-agent/memory.md`                               | Cross-project working style, user preferences, hard-won general lessons.          |
| `project` | `~/.minimal-agent/projects/<absolute-cwd>/memory.md`       | Facts, invariants, and gotchas specific to *this* codebase / workspace (default). |

Both are **per-user**, never inside the project tree, never committed,
never shared with collaborators. Memories are the assistant's personal
scratchpad — not team documentation. Things meant for the team belong in
`README.md`, `CLAUDE.md`, `AGENTS.md`, etc.

At session start, this plugin reads both files (if present) and the
loader injects them into the system prompt as a `## Saved memories`
section. So whatever you save **comes back automatically** next session
— you don't have to "look it up", it's already in your context.

## When to save

Save things that should outlive this session:

- **Lessons from user feedback.** "When the user pushes back I should
  open an interleaved-thinking span and re-check, not restate."
- **User preferences.** "User prefers concise replies." "Always show
  diffs with `ShowDiff` rather than pasting code blocks."
- **Project invariants and gotchas.** "The `Compositor`'s blank-line cap
  lives in `capBlankLines()`; don't reintroduce sink-level deduping."
  "Test runner is `bun test`, not `npm test`."
- **Mistakes you don't want to repeat.** "I confabulated a session id
  once instead of reading the env block — always quote it verbatim."

Do **not** save:

- Transient task state. Use a TODO list or scratchpad in your reply.
- Secrets, tokens, credentials.
- Long verbatim content. Memories should be one or two sentences,
  actionable, with concrete file/symbol names where useful.
- Things already in `CLAUDE.md` / `AGENTS.md` / the README.

## Choosing a scope

Default to `project`. Most session lessons are about whatever codebase
you're in. Use `global` only when the lesson generalizes across every
project you'll ever work on with this user.

Quick test: *"Would this still be true if I were working in a totally
different repo tomorrow?"* — yes → `global`, no → `project`.

## Syntax

One tag, one optional attribute (`scope`):

    <tui::memory>
    Project-scoped memory (default). About this codebase only.
    </tui::memory>

    <tui::memory scope="project">
    Same as above, just explicit.
    </tui::memory>

    <tui::memory scope="global">
    Cross-project memory. About working with this user, my own
    failure modes, general tooling, etc.
    </tui::memory>

The body is **not** shown to the user — the tag is stripped from the
visible stream, the same way `<tui::interleave-thinking>` is stripped.
A short dim confirmation line is rendered in its place so the user can
see that a save happened (e.g. `· memory saved [project]: ...`).

Whitespace inside the body is collapsed to a single line — keep
memories short and self-contained. Empty bodies are silently ignored.

Each saved bullet is automatically prefixed with a local-time ISO 8601
timestamp (with seconds), e.g.
`- [2026-05-05T21:06:20-04:00] <body>`.
This is added by the handler — don't write it yourself.

Legacy bullets saved before this prefix existed (and any hand-edited
bullets without a `[<ts>] ` prefix) remain valid and load unchanged
alongside timestamped ones; the loader treats memory files as opaque
text.

## Updating or correcting a memory

There's no in-band edit/delete mechanism. To revise a memory, edit the
underlying file directly with the `Edit` or `Write` tool:

- Global: `~/.minimal-agent/memory.md`
- Project: `~/.minimal-agent/projects/<absolute-cwd>/memory.md`

If you've learned that an old memory is wrong, **say so in the new
memory** ("Supersedes the May-2026 note about X: actually Y") and edit
the file to remove the outdated bullet. Stale memories are worse than
no memories.

## When to consult memory

You don't — it's already in your system prompt as the `## Saved memories`
section, loaded fresh every session by this plugin's `memory_load`
prompt fragment. Treat each bullet as a standing instruction or a known
fact about the project / user.
