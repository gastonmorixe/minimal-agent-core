Use `MemoryTool` for durable, per-user notes that persist across sessions, plus a per-session scratchpad. Two write paths (the inline `<ma::emit::memory>` tag and `MemoryTool.add`) and one read/edit/remove path (`MemoryTool`).

## You have memories. The latest ones are pre-loaded.

Persistent memories (`global` and `project` scopes) had their full history dumped verbatim into the system prompt in older versions, consuming ~13% of a 200k context window. As of v0.4 the default injects only the 10 most-recent bullets per scope, formatted as `MemoryTool.list` output (the exact shape you see when calling the tool). This gives you quick access to recent memories without burning context on the full history.

What this means for you:

- **The latest 10 `global` and `project` bullets are in your prompt** under `## Saved memories`. They include ids, so you can `MemoryTool.read` any one for the full body.
- **For older memories or any you don't see listed**, call `MemoryTool({action: "list", ...})` the same way you always have. The tool is always registered.
- **Saves still work the same way.** The inline `<ma::emit::memory>` tag appends to the file, and the next-turn `<ma::agent::memory-saved id="...">` attachment hands you the bullet's id.
- **The user can configure the injection mode** via `~/.minimal-agent/config.jsonc`: `"latest"` (default, N most-recent with configurable `top`), `"none"` (query-only), `"verbatim"` (full dump), or `"summary"` (LLM-compressed).

The short-term scratchpad (`short-term` scope) is the exception. It still rides every turn as a `<ma::agent::short-term-memory>` attachment, so what you wrote there last turn is right above this paragraph in your next user message.

## When you should call `MemoryTool.list`

Reach for it whenever any of these is true:

- The user asks "what do you remember about X?" or "do we have notes on Y?". Do not improvise an answer. Query.
- You're about to debug a symptom that feels familiar (a wrap bug at width 80, an auth refresh storm, a tmux-vs-iTerm discrepancy, etc.). A 5-second `list` with a keyword may save you the round trip.
- You're about to start a non-trivial change in this codebase. Skim `project` for the subsystem you're touching ("compositor", "editor-controller", "agent.ts").
- You're about to save a new bullet on a topic. Query first. If a near-duplicate exists, `edit` it instead of stacking another.
- The user mentions a past session, a recent fix, or "we discussed this before". List with the relevant keyword.

Don't query when:

- The question is fully answered by the conversation so far.
- The user gave you a fresh fact one paragraph ago. Don't re-derive it.
- The work is one-shot and trivial.

## How `MemoryTool.list` is shaped

Calls are paginated and bodies are truncated, on purpose, to keep tool results small:

- **Default page size: 20** (max 100; larger values are clamped).
- **Default offset: 0** = the most recent page. Offset counts entries FROM THE NEWEST END, so `offset=20` returns the page immediately before the most recent one.
- **Bodies are clipped to ~160 chars** in list results. The full body is always available via `MemoryTool({action: "read", id})`.
- The response header always shows `showing N of M entries, offset O`.
- When more pages exist, the response ends with a paste-ready hint: `next: MemoryTool({action: "list", scope: "project", offset: 20, limit: 20})`.

So a typical flow looks like:

    MemoryTool({action: "list", scope: "project", query: "compositor"})
       -> header: showing 5 of 5 entries matching "compositor"
       -> 5 truncated bodies with their ids

    MemoryTool({action: "read", scope: "project", id: "mpfm-..."})
       -> full body of the one that looked most relevant

Don't fetch full bodies for every match. Skim previews, then `read` the one or two you actually need.

## Three scopes: pick deliberately when saving

| Scope        | Lives in                                                | Use when                                                      |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------------- |
| `global`     | `~/.minimal-agent/memory.md`                            | True for any project I'll touch with this user.               |
| `project`    | `~/.minimal-agent/projects/<absolute-cwd>/memory.md`    | True for *this codebase* across sessions.                     |
| `short-term` | `~/.minimal-agent/sessions/<sid>.scratch.md`            | Useful only until this session ends (per-session scratchpad). |

All three are **per-user**, never inside the project tree, never committed, never shared with collaborators. Memories are *your* personal scratchpad. Things meant for the team belong in `README.md`, `CLAUDE.md`, `AGENTS.md`, etc.

### Namespaces (when the user is testing memory)

If `MINIMAL_AGENT_MEMORY_NAMESPACE=<name>` is set, every path above is rebased under `~/.minimal-agent/namespaces/<name>/...` and the user's real memory files are untouched. You won't see this directly. If a `list` looks unexpectedly empty mid-session, that's a likely cause. Don't try to "restore" anything. The namespaced store is intentional.

## Decision tree (run top-to-bottom before saving)

1. **Will this still be true in a *future* session?**
    - In any project I'll work on with this user -> `global`
    - In this project only -> `project`
    - No -> `short-term` (or don't save at all)

2. **Is it actionable / specific?** Vague aspirations ("we should fix the bug") aren't memories. Use a TODO list.

3. **Is something close to it already saved?** Always `list` with a `query` first. If a near-duplicate exists, `edit` it instead. Clusters of overlapping bullets on one topic are noise.

4. **Is it a secret / token / credential?** Never save.

## When to use `short-term` specifically

Per-session scratchpad. Things you're *actively* tracking and want to look at every turn or every few turns:

- "user said the failing test is in `foo.test.ts:47`"
- "symptom: snapshot diff fails only when `COLUMNS<80`"
- "tried setting `LANG=C`, no change, don't loop back to it"
- "user's intent for this work block: refactor X without touching Y"

Short-term entries appear in your context as `<ma::agent::short-term-memory>` at the top of every user turn. Free to refresh / amend frequently. There's a cap (20 entries, FIFO eviction), so consolidate as you go.

## Don't save (any scope)

- Transient turn-by-turn task state. Use a TODO list in the response.
- Long verbatim content. One or two sentences max.
- Things already in `CLAUDE.md` / `AGENTS.md` / the README.
- Manually-prefixed dates in the body (`[2026-05-10] foo ...`). The store attaches `[<ts>]` automatically. Duplicating it is noise.
- Secrets, tokens, credentials.

## Saving via inline tag (preferred for in-flight saves)

Mid-response, low-friction. The body is hidden from the user (the tag is replaced with a dim confirmation line), and whitespace is collapsed to one line.

    <ma::emit::memory>
    Project-scoped memory (default). About this codebase only.
    </ma::emit::memory>

    <ma::emit::memory scope="global">
    Cross-project memory. About working with this user, my own
    failure modes, general tooling, etc.
    </ma::emit::memory>

    <ma::emit::memory scope="short-term">
    Active hypothesis: the wrap bug only reproduces at width 80.
    </ma::emit::memory>

After every save, your **next user turn** will carry a small attachment:

    <ma::agent::memory-saved scope="short-term" id="3">Active hypothesis: ...</ma::agent::memory-saved>

Keep an eye on it. That's how you learn the bullet's id, which you'll need if you later want to edit or remove the entry. When short-term overflows the cap, the echo also reports the eviction count (`evicted="1"`).

## `MemoryTool` cheatsheet

Schema: `{action, scope, id?, body?, query?, limit?, offset?, format?}`. `scope` is always required. `id` is required for `read`/`edit`/`remove`. `body` is required for `add`/`edit`. `query`/`limit`/`offset` are list-only.

    # Browse: the most common call. Pages of 20 by default.
    MemoryTool({action: "list", scope: "short-term"})
    MemoryTool({action: "list", scope: "project", query: "compositor"})
    MemoryTool({action: "list", scope: "project", limit: 10})
    MemoryTool({action: "list", scope: "project", offset: 20, limit: 20})

    # Fetch a specific bullet in full.
    MemoryTool({action: "read",   scope: "project", id: "lwq8tg-a8f3"})

    # Mutate.
    MemoryTool({action: "add",    scope: "project", body: "tests live in src/*.test.ts"})
    MemoryTool({action: "edit",   scope: "short-term", id: "3", body: "Refined: ..."})
    MemoryTool({action: "remove", scope: "short-term", id: "2"})
    MemoryTool({action: "clear",  scope: "short-term"})       # short-term only

`add` exists for symmetry but **prefer the inline tag for in-flight saves**. The tag is lower-friction (no tool round-trip, no pause in prose) and you get the id back via the same `<ma::agent::memory-saved>` echo. Use the tool's `add` only when you're already curating (batch operations after a `list`, follow-up to a `read`, etc.).

`clear` is **only** allowed for `scope="short-term"`. Wiping global/project is a footgun, so remove individual ids instead.

### High-value `list` patterns

- **User-asked recall** ("what do you remember about X?"). List with a `query`. Don't paraphrase from your context, you don't have the data.
- **Before debugging a known-feeling symptom**. List `project` with the symptom keyword. Saves re-deriving a documented fix.
- **Curation pass** when you spot overlapping bullets on one subsystem: list, read the worst, edit one to be comprehensive, remove the rest.
- **Onboarding to a new file**. List `project` with the filename or subsystem keyword before reading the file itself.

## When memories appear in context directly

The latest N persistent memories (default 10) are pre-loaded at session start under a `## Saved memories` section in your system prompt, formatted as `MemoryTool.list` output. If the user has opted into a different inject mode, a `## Saved memories` section may also appear containing a compressed summary (with `Sources: #id` citations) or the full verbatim dump. In any case, `MemoryTool.read` by id fetches the full body when the pre-loaded preview or summary is lossy.

## Id formats

- **Persistent** (`global`, `project`): `<base36-millis>-<rand4hex>`, e.g. `lwq8tg-a8f3`. Sortable by time, opaque to you.
- **Short-term**: integer auto-incrementing per session, e.g. `1`, `2`, `3`. Never reuses gaps left by removes. Id 4 follows even after id 2 was deleted.
- **Legacy** (untagged bullets in pre-v0.3 files): `legacy:<sha12>`, derived from the line text. Addressable by `MemoryTool` actions just like normal ids. The user can stamp persistent ids onto legacy bullets via the CLI's `rewrite-ids` command.
