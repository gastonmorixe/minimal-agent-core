The `memory` plugin gives you persistent, per-user memory plus a per-session
scratchpad. Two write paths and one read/edit/remove path -- see below.

## Three scopes -- pick deliberately

| Scope        | Lives in                                                | Use when                                                      |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------------- |
| `global`     | `~/.minimal-agent/memory.md`                            | True for any project I'll touch with this user.               |
| `project`    | `~/.minimal-agent/projects/<absolute-cwd>/memory.md`    | True for *this codebase* across sessions.                     |
| `short-term` | `~/.minimal-agent/sessions/<sid>.scratch.md`            | Useful only until this session ends (per-session scratchpad). |

All three are **per-user**, never inside the project tree, never committed,
never shared with collaborators. Memories are *your* personal scratchpad.
Things meant for the team belong in `README.md`, `CLAUDE.md`, `AGENTS.md`,
etc.

## Freshness -- the snapshot is frozen at session start

The `## Saved memories` section in your system prompt is captured **once
at session start** and never refreshes. Mid-session it can drift: you
add bullets that aren't in the snapshot, another agent in a shared
worktree writes concurrently, the user edits via the CLI. `short-term`
is the exception -- it re-reads on every turn via `<short-term-memory>`.

So when staleness matters -- the user asks "what do you remember?",
you're about to save and want to avoid duplicates, you're debugging a
symptom that may already be documented -- `list` first, don't recite
from the snapshot.

## Decision tree (run top-to-bottom before saving)

1. **Will this still be true in a *future* session?**
    - In any project I'll work on with this user → `global`
    - In this project only → `project`
    - No → `short-term` (or don't save at all)

2. **Is it actionable / specific?** Vague aspirations ("we should fix
   the bug") aren't memories -- that's task state, use a TODO list.

3. **Is something close to it already saved?** List with a `query`
   first. If a near-duplicate exists, edit it instead. Clusters of
   overlapping bullets on one topic are noise.

4. **Is it a secret / token / credential?** → never save.

## When to use `short-term` specifically

Per-session scratchpad. Things you're *actively* tracking and want to
look at every turn or every few turns:

- "user said the failing test is in `foo.test.ts:47`"
- "symptom: snapshot diff fails only when `COLUMNS<80`"
- "tried setting `LANG=C` -- no change, don't loop back to it"
- "user's intent for this work block: refactor X without touching Y"

Short-term entries appear in your context as `<short-term-memory>` at the
top of every user turn. Free to refresh / amend frequently. There's a
cap (20 entries, FIFO eviction), so consolidate as you go.

## Don't save (any scope)

- Transient turn-by-turn task state -- use a TODO list in the response.
- Long verbatim content. One or two sentences max.
- Things already in `CLAUDE.md` / `AGENTS.md` / the README.
- Manually-prefixed dates in the body (`[2026-05-10] foo …`). The
  store attaches `[<ts>]` automatically -- duplicating it is noise.
- Secrets, tokens, credentials.

## Saving -- inline tag (preferred)

Mid-response, low-friction. The body is hidden from the user (the tag
is replaced with a dim confirmation line), and whitespace is collapsed
to one line.

    <tui::memory>
    Project-scoped memory (default). About this codebase only.
    </tui::memory>

    <tui::memory scope="global">
    Cross-project memory. About working with this user, my own
    failure modes, general tooling, etc.
    </tui::memory>

    <tui::memory scope="short-term">
    Active hypothesis: the wrap bug only reproduces at width 80.
    </tui::memory>

After every save, your **next user turn** will carry a small attachment:

    <memory-saved scope="short-term" id="3">Active hypothesis: …</memory-saved>

Keep an eye on it. That's how you learn the bullet's id, which you'll
need if you later want to edit or remove the entry. When short-term
overflows the cap, the echo also reports the eviction count
(`evicted="1"`).

## Editing / browsing -- `MemoryTool`

Once you need structured I/O -- listing, reading by id, editing, removing --
use the tool. Schema: `{action, scope, id?, body?, query?, limit?, format?}`.
`scope` is always required. `id` is required for `read`/`edit`/`remove`.
`body` is required for `add`/`edit`. `query`+`limit` are list-only.

    MemoryTool({action: "list",   scope: "short-term"})
    MemoryTool({action: "list",   scope: "project", query: "compositor", limit: 10})
    MemoryTool({action: "read",   scope: "project", id: "lwq8tg-a8f3"})
    MemoryTool({action: "add",    scope: "project", body: "tests live in src/*.test.ts"})
    MemoryTool({action: "edit",   scope: "short-term", id: "3", body: "Refined: …"})
    MemoryTool({action: "remove", scope: "short-term", id: "2"})
    MemoryTool({action: "clear",  scope: "short-term"})       # short-term only

`add` exists for symmetry but **prefer the inline tag for in-flight
saves**. The tag is lower-friction (no tool round-trip, no pause in
prose) and you get the id back via the same `<memory-saved>` echo. Use
the tool's `add` only when you're already curating (batch operations
after a `list`, follow-up to a `read`, etc.).

`clear` is **only** allowed for `scope="short-term"`. Wiping
global/project is a footgun, so remove individual ids instead.

### High-value `list` patterns

- **User-asked recall** ("what do you remember about X?") -- list with a
  `query`, don't paraphrase the system-prompt snapshot.
- **Before debugging a known-feeling symptom** -- list `project` with the
  symptom keyword. Saves re-deriving a documented fix.
- **Curation pass** when you spot overlapping bullets on one subsystem:
  list, read the worst, edit one to be comprehensive, remove the rest.

## Id formats

- **Persistent** (`global`, `project`): `<base36-millis>-<rand4hex>`,
  e.g. `lwq8tg-a8f3`. Sortable by time, opaque to you.
- **Short-term**: integer auto-incrementing per session, e.g. `1`, `2`,
  `3`. Never reuses gaps left by removes -- id 4 follows even after
  id 2 was deleted.
- **Legacy** (untagged bullets in pre-v0.3 files): `legacy:<sha12>`,
  derived from the line text. Addressable by `MemoryTool` actions just
  like normal ids. The user can stamp persistent ids onto legacy
  bullets via the CLI's `rewrite-ids` command.
