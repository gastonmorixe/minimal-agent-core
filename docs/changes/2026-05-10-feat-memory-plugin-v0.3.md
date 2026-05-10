# Memory plugin v0.3 -- short-term scope, MemoryTool, CLI

**Date:** 2026-05-10
**Type:** feat
**Status:** landed
**Author:** Claude Code (Opus 4.7)

## Problem

The pre-v0.3 memory plugin had three rough edges that compounded over
long sessions:

1. **No per-session scratchpad.** Everything saved through
   `<tui::memory>` went to either `~/.minimal-agent/memory.md`
   (cross-project, permanent) or the per-project memory file (also
   permanent). There was no place to stash *"active hypothesis: width
   80"* or *"user said the failing test is at foo.test.ts:47"* --
   things that are actively useful for the next ten turns and useless
   forever after. Users either polluted persistent memory with
   transient stuff, or kept it in working memory only and lost it
   across context-window churn.

2. **No way to edit or remove by id.** The bullet format had a
   timestamp prefix but no stable id. The model had no name for any
   single entry, so editing or removing required full-text search
   followed by `Edit`/`Write` against the raw markdown. Two bullets
   with the same body had no way to be distinguished.

3. **The model never learned the id of what it just saved.** The
   inline tag returns ANSI rendered to scrollback, not anything the
   model sees on its next turn. So even if we stamped ids, the model
   couldn't act on them without first calling a list/read tool every
   time it wanted to revise something.

## Goals

1. **Add a `short-term` scope** that's per-session, FIFO-capped, and
   shows up in the model's context every turn (not just at session
   start), so the model can use it as a high-frequency scratchpad.
2. **Add stable per-bullet ids** in all three scopes -- sortable,
   compact, and unambiguous across legacy + new content.
3. **Close the loop on save**: after every save (tag or tool), the
   model gets the new id back via a small attachment on its very next
   turn, with no extra tool round-trip.
4. **Add a `MemoryTool`** for structured CRUD by id (list, read, add,
   edit, remove, clear).
5. **Add a TypeScript CLI** so the human can curate memory from a
   shell without booting the full agent.
6. Keep the inline `<tui::memory>` tag as the preferred save path --
   it's lower friction than a tool call and works well today.

## Research / options considered

### Save-echo mechanism

When the inline-tag handler runs, how does the agent's message
construction learn that a save happened so it can echo the id back to
the model?

#### A. `message.willSend` chain hook (channel registry already exists)

```ts
loader.bus().on("memory.saved", ...)
hooks.declare("message.willSend", { shape: "chain" })
agent.dispatch("message.willSend", { messages, system })
```

**Rejected for v0.3.** The channel is declared in
`src/plugins/hooks/channels.ts` but not yet wired into `agent.ts` --
no emit/listen call exists. Wiring it properly means designing the
chain payload shape, return-value semantics (`{payload}` |
`{halt}`), per-listener timeouts, and the
`tool_result-must-come-first` ordering interaction with the existing
`<mode-change>` attachment. That's a 500-LOC arc on its own;
shipping it inside this PR would balloon scope. Listed as a follow-up
instead -- same UX, cleaner architecture, swap-in later.

#### B. Singleton mirroring `ModeManager.consumePendingAttachment`

```ts
// memory plugin emits on the existing global bus
getGlobalEventBus()?.emit("memory.saved", {scope, id, body, evicted?})
// agent owns one collector subscribed to the bus
this.saveEcho?.consumeAll() // -> ContentBlock[]
```

**Chosen.** Reuses the proven `getGlobalEventBus()` /
`setGlobalEventBus(loader.bus())` pattern from `quota-broadcast.ts`.
~60 LOC. The agent's `run()` drains at the same two seams that
already drain the mode-change attachment (initial user content + loop
user content after tool_use). Migration to the chain hook later is a
refactor, not a redesign.

### ID format for persistent scopes

#### A. Hash of cwd + timestamp

```ts
id = sha1(cwd + ts).slice(0, 8) // -> "a3f7b29c"
```

**Rejected.** Opaque (good) but expensive (sha1 is overkill for the
small per-file domain) and not sortable. Hashing also makes the model
think the id encodes meaning, which might tempt it to try to
back-derive cwd from the id.

#### B. Random uuid

**Rejected.** 36 chars is too long for a recurring inline reference;
the model burns tokens whenever it cites an id.

#### C. `${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`

```
lwq8tg-a8f3
```

**Chosen.** Mirrors the prompt-history plugin's id scheme
(`work/plans/prompt-history-plugin.md:46`). Sortable (millis-based,
base36 preserves numeric ordering for any realistic file lifetime).
4-hex random tail makes intra-millisecond collisions ~1/65536. Short
enough to be ergonomic in tool args. Opaque enough that the model
won't try to decompose it.

### ID format for short-term

#### A. Same persistent id format

**Rejected.** A scratchpad bullet should have an id you can say in
one syllable (`#3`), not eleven characters. The model edits/removes
short-term items frequently, and concise ids matter.

#### B. Auto-incrementing integer per session

**Chosen.** Compute `nextId = max(seen ints) + 1` on every add.
Never reuses gaps left by removes (so `#2` is a stable name even
after `#1` was removed). Per-session domain is ~20 entries (capped),
so int collisions are impossible by construction.

Concise ids matter for short-term: it gets edited and removed
frequently, and the model says ids out loud in its responses.

### Eviction policy for short-term

#### A. No cap

**Rejected.** Snapshot ships in every user-turn attachment;
unbounded short-term means the snapshot grows every save and pays
tokens forever.

#### B. LRU with explicit pin operation

**Rejected.** Tracking "last used" is hard (used in a tool call?
referenced in prose? auto-touched on every turn-as-context-read?).
Pin operation adds a new tool action and a new bullet field. Too
much surface for a feature most users never see.

#### C. FIFO at cap=20, edit-bumps-timestamp ⇒ effective LRU

**Chosen.** Drop oldest at cap. Edits bump the bullet's `ts`, which
naturally re-inserts the entry at the bottom of the file -- so
edit-touched entries survive longer without inventing a "pin"
concept. Cap chosen at 20 (conservative): if you need 30 short-term
notes, you're hoarding rather than curating, and the cap forces
consolidation. The eviction count surfaces in the save-echo
(`<memory-saved … evicted="1"/>`) so the model sees it and
self-prunes.

### How short-term reaches the model every turn

#### A. Inject into `## Saved memories` section of the system prompt

**Rejected.** The system prompt sits on a `cache_control` breakpoint
(~12k tokens of pluginBlock). Mutating short-term -- i.e. on every
save -- would invalidate the entire prefix every turn, killing the
prompt cache. Catastrophic for token cost.

#### B. Per-turn user-message attachment

**Chosen.** Same channel as `<mode-change>` and `<memory-saved>`.
Sits behind the rolling-tail breakpoint (already invalidated every
turn by the changing user message), so the snapshot costs zero extra
cache invalidation. Block shape:

```
<short-term-memory>
[#1] active hypothesis: width 80
[#2] tried setting LANG=C -- no change
</short-term-memory>
```

**Initial seam only.** Re-emitting on every loop iteration after
tool_use rounds would balloon the conversation with stale repeats. The
model can call `MemoryTool({action: "list", scope: "short-term"})` if
it needs a refresh mid-turn.

### Tool `add` vs inline-tag-only saves

#### A. Tool has `add`, inline tag also exists

**Chosen** (with a guard against double-echo). The tool's `add`
returns the new id directly in the `tool_result.content`, so we
deliberately do NOT emit `memory.saved` on the bus from the tool
path -- otherwise the model sees the id twice (tool result + next-turn
`<memory-saved>` echo) which reads as "did I save twice?". The
inline-tag handler emits because it has no other way to surface the
id.

PROMPT.md teaches the split: in-flight save during a response → tag
(no pause in prose); deliberate curation → tool (after a list, or as
part of a batch operation).

#### B. Tool does not have `add`; tag is the only write path

**Rejected.** Forces "save inside a tool-call sequence" through the
tag too, which is awkward when you're already mid-tool. Symmetry has
value, and double-echo is solvable by not emitting from the tool path.

### Cross-scope id collision

`id="3"` could be a short-term int OR a persistent bullet whose
`Date.now().toString(36)` happens to be just `"3"` (impossible
within ~22000 years from epoch -- but theoretically). And
`lwq8tg-a8f3` could exist in both `global` and `project` (extremely
unlikely but not zero).

#### A. Auto-resolve scope from id shape (`/^\d+$/` ⇒ short-term, etc.)

**Rejected.** Fancy resolution + ambiguity error for the
global/project case. More code, more failure modes, and the model
gets `scope` for free in the save-echo anyway.

#### B. Tool always requires `scope`; CLI defaults to `-s project`

**Chosen.** Schema is dumb and explicit. Save-echo carries `scope`,
so the model has it cheaply. CLI default `-s project` matches the
inline-tag default.

## Chosen design

Three scopes, three storage paths:

```
~/.minimal-agent/
  memory.md                                   # global
  projects/<absolute-cwd>/memory.md           # project
  sessions/<sid>.scratch.md                   # short-term (NEW)
```

Bullet format (all three):

```
- [#<id>] [<iso-ts>] [session:<sid>] body
```

(`[session:…]` omitted on short-term -- the file IS the session.)

Three flows:

```
                                  ┌─────────────────────────────────────┐
                                  │ inline tag handler (memory.ts)      │
  <tui::memory scope="X">         │   1. MemoryStore.add(body)          │
       body                  ───► │   2. emit("memory.saved", payload)  │
  </tui::memory>                  │   3. return dim ANSI confirmation   │
                                  └────────┬────────────────────────────┘
                                           │ via global bus
                                           ▼
                                  ┌─────────────────────────────────────┐
                                  │ SaveEchoCollector (in agent)        │
                                  │   buffers payloads between turns    │
                                  └────────┬────────────────────────────┘
                                           │ consumeAll() at user-turn seam
                                           ▼
                                  ┌─────────────────────────────────────┐
                                  │ next user message:                  │
                                  │   <mode-change … />                 │
                                  │   <short-term-memory>…</…>          │
                                  │   <memory-saved scope="X" id="…">…  │
                                  │   <user text>                       │
                                  └─────────────────────────────────────┘

  MemoryTool({action,scope,id?,body?,...})  ──► structured CRUD,
                                                 returns content+display
                                                 (no bus emit on add)

  bun run tui-plugins/memory/cli.ts <cmd>   ──► same store, human use
```

## File inventory

### New files (11)

- `tui-plugins/memory/lib/parse.ts` -- bullet parser, id helpers
  (`newPersistentId`, `legacyIdFor`, `nextShortTermId`),
  `formatBullet`, `parseFileWithLines` + `serializeFile` for lossless
  file round-trip
- `tui-plugins/memory/lib/parse.test.ts` -- 32 tests
- `tui-plugins/memory/lib/store.ts` -- `MemoryStore` class with
  factories `global()` / `project(cwd)` / `shortTerm(sid)`, full
  CRUD, FIFO eviction at `SHORT_TERM_CAP=20` for short-term only,
  `clear()` refuses for persistent scopes (footgun guard)
- `tui-plugins/memory/lib/store.test.ts` -- 42 tests
- `tui-plugins/memory/lib/save-echo.ts` -- `SaveEchoCollector`,
  `MEMORY_SAVED` channel constant, `MemorySavedPayload` shape,
  `renderEcho` for the `<memory-saved>` block
- `tui-plugins/memory/lib/save-echo.test.ts` -- 24 tests
- `tui-plugins/memory/lib/short-term-snapshot.ts` --
  `ShortTermSnapshot` (reads disk on demand for freshness;
  `toAttachment(): ContentBlock | null`)
- `tui-plugins/memory/lib/short-term-snapshot.test.ts` -- 10 tests
- `tui-plugins/memory/lib/format.ts` -- text + ANSI renderers for
  `list` / `read` / `add` / `edit` / `remove` / `clear`, plus
  `bulletToJson` / `bulletsToJson` for `format=json`
- `tui-plugins/memory/handlers/memory_tool.ts` -- `MemoryTool` handler
  (6 actions, full input validation, JSON format, defensive paths)
- `tui-plugins/memory/handlers/memory_tool.test.ts` -- 40 tests
- `tui-plugins/memory/cli.ts` -- argv parser + `main(argv, io)` returning
  exit code (testable without `process.exit`); 8 commands incl.
  `rewrite-ids` and `path`
- `tui-plugins/memory/cli.test.ts` -- 47 tests
- `tui-plugins/memory/integration.test.ts` -- 7 closing-the-loop
  end-to-end tests through real `PluginLoader`
- `src/agent.memory-attachments.test.ts` -- 9 wiring tests for the
  agent's two new optional ctor params
- `tmp/memory-save-tmux-driver.ts` -- visible-UX smoke regression
  guard (drives `runReplLiveArea` with a fake agent that emits two
  `<tui::memory>` tags, captures rendered output via tmux)

### Modified files (6)

- `src/agent.ts` -- 2 new optional `Agent` constructor params
  (`saveEcho?: {consumeAll(): ContentBlock[]}`,
  `shortTermSnapshot?: {toAttachment(): ContentBlock | null}`),
  structurally typed so the agent has zero hard dep on the memory
  plugin's concrete classes. Wired into both attachment seams (initial
  user content + loop user content) with full ordering rules
  documented in comments.
- `src/index.ts` -- constructs `SaveEchoCollector.attach(loader.bus())`
  and `new ShortTermSnapshot(getSessionId())` after
  `setGlobalEventBus(loader.bus())`, threads both into `new Agent`.
- `tui-plugins/memory/manifest.json` -- bumped to `0.3.0`; added
  `tuis[1]` for the `MemoryTool` (icon = nf-md-memo, color = purple).
- `tui-plugins/memory/PROMPT.md` -- full rewrite. Three-scope decision
  tree, when-to-use-short-term examples, tag-vs-tool guidance, id
  format reference.
- `tui-plugins/memory/handlers/memory.ts` -- retargeted at
  `lib/store.ts`. Accepts `scope="short-term"` (and `"short"`
  shorthand). Refuses short-term writes when no
  `MINIMAL_AGENT_SESSION_ID` is plumbed through. Emits `memory.saved`
  on the global bus after every successful save. Re-exports
  `localIsoSeconds` for back-compat with existing imports.
- `tui-plugins/memory/handlers/memory.test.ts` -- rewritten for v0.3
  bullet format. Adds 9 tests for short-term + bus-emit paths;
  expanded ID_RE matches all three id flavors.

## Tests added

- 32 + 42 + 24 + 10 + 36 + 40 + 47 + 7 + 9 = **247 new/changed tests**
  in the memory plugin surface, **all green**.
- Full repo: 1402+ pass / 0 fail / 5 skip / 1 unrelated pre-existing
  failure (in `src/live-area-providers.ts`, another agent's WIP, NOT
  touched per the shared-tree rule).

## UX evidence (tmux smoke)

`bun run tmp/memory-save-tmux-driver.ts` under tmux produces:

```
❯ save two things
Let me save two memories -- one project-scope, one short-term:

· memory saved [project#mozkamr9-3fb3]: tests live in src/*.test.ts (project body)

· memory saved [short-term#1]: active hypothesis: width 80 (short-term body)

Both saved. Done.
```

CLI smoke (multiple commands in one tmux pane):

```
saved [project#mozlp9xe-61a7]: first thing to remember
saved [project#mozlp9y0-d841]: compositor cap is 2
saved [project#mozlp9yn-e8ab]: tests live in src/*.test.ts
saved [short-term#1]: active hypothesis: width 80
project (3 entries)
  #mozlp9xe-61a7  2026-05-10 05:59:13  first thing to remember
  #mozlp9y0-d841  2026-05-10 05:59:13  compositor cap is 2
  #mozlp9yn-e8ab  2026-05-10 05:59:13  tests live in src/*.test.ts
project (1 entry)
  #mozlp9y0-d841  2026-05-10 05:59:13  compositor cap is 2
short-term (1 entry)
  #1  2026-05-10 05:59:13  active hypothesis: width 80
```

## Follow-ups (out of scope for v0.3)

- **Migrate save-echo to the `message.willSend` chain hook** once
  that hook is wired into `agent.ts`. Same UX, cleaner architecture
  (no global-bus singleton). Planned but not blocking.
- **Auto-stamp legacy ids on first read after upgrade.** Currently
  manual via `cli.ts rewrite-ids`. Punted because mutating files on
  first read is destructive-feeling as a default. Explicit opt-in is
  safer.
- **Search-both-with-friendly-error in CLI** when `-s` is omitted
  with a persistent id. Currently `-s project` is the default. Mild
  friction, not worth the resolution complexity yet.

## Notes for reviewers

- The plugin manifest, PROMPT.md, and the inline-tag handler all
  silently reverted to HEAD at least once during development (probably
  during a `git stash`/`git stash pop` cycle that interacted with
  another agent's WIP in this same working tree). Each was re-applied
  and re-verified. If you see a similar reversion before commit, run
  `git diff` against the listed files and re-apply from this PR.
- One pre-existing test failure in `src/live-area-providers.test.ts`
  is from the other agent's WIP, not this PR.
