---
title: TODOS
description: Deferred work, ideas, and known-but-not-yet items. One file at the repo root so any future session can find it. Append-only in spirit; entries are edited only to flip state (todo → doing → done/canceled) and to add a timestamped resolution.
schema_version: 1
created_at: 2026-05-26T00:15:29-04:00
last_updated: 2026-05-26T00:15:29-04:00
---

# TODOS

Future work that we explicitly punted on. Each entry has a short random id (six hex chars prefixed with `T-`) so we can reference it from commits, memories, and conversations without typing long titles.

## Conventions

- **State** is one of `todo`, `doing`, `done`, `canceled`.
- **Locking** when an agent picks up a todo, it flips the state to `doing` and writes `lock` with `session`, `pid`, `started_at`. Other agents that see a live lock should pick a different todo (or skip).
- **Cancellation** keep the entry. Set state to `canceled`, add `canceled_at` and a one-paragraph `reason`. We do NOT delete entries; the historical decision is the point.
- **Completion** set state to `done`, add `done_at` and a one-line `outcome` pointing at the commit / PR / doc that landed.
- **Stale locks** if `lock.started_at` is older than 24h with no progress, the next agent may steal the lock by overwriting it. Record an `audit` line noting the steal.

The state line uses a real markdown checkbox so a quick `grep "\[ \]" TODOS.md` finds open items.

## Entries

### T-a4f8c1: Garbage-collect orphan blob directories

- [ ] state: `todo`
- created_at: 2026-05-26T00:15:29-04:00
- created_by: session=ca04ccf1-2161-4b14-af55-d264119d9384, conversation about blob-store design (see `docs/changes/2026-05-26-feat-blob-store.md`)
- area: `src/blob-store.ts`, possibly a new `src/cli/gc.ts` subcommand

**Description.** The per-session blob store enforces an LRU cap inside one session (`maxBlobsPerSession` count, `maxBytesPerSession` total). It does NOT clean up entire `<sid>.blobs/` directories that belong to old / abandoned / orphaned sessions. Disk grows monotonically until the user runs `rm -rf` manually.

**What landing looks like.** A `minimal-agent gc` subcommand (or an opportunistic check at startup) that walks `~/.minimal-agent/sessions/`, finds `<sid>.blobs/` directories whose corresponding `<sid>.jsonl` is older than N days OR whose session id is no longer referenced by `index.jsonl`, and deletes them. Mirrors the implicit cleanup pattern session-store already follows for old JSONL files.

**Open questions.**
- Default N. 30 days is the obvious starting point.
- Opportunistic mode (run on every startup, capped at a small budget) vs explicit subcommand only.
- Does fork-on-resume reparent blobs into the child sid or keep them under the parent? Today's implementation keeps them under the parent, so a `gc` that deletes the parent's blobs dir on its own would orphan child JSONL `rawPath` entries pointing at a vanished file. The fix is either to hardlink on fork (handled separately, see `T-b8c2d3`) or to skip dirs that have surviving children somewhere in the index.

### T-b8c2d3: Hardlink parent session blobs on fork

- [ ] state: `todo`
- created_at: 2026-05-26T00:15:29-04:00
- created_by: session=ca04ccf1-2161-4b14-af55-d264119d9384, deferred at design time
- area: `src/session-store.ts:fork`, `src/blob-store.ts`

**Description.** When `SessionStore.fork` clones a parent session's JSONL into a new sid, the JSONL rows carry `rawPath` strings pointing at the parent's `<sid>.blobs/` directory. The fork does NOT copy those blob files. If the parent is later deleted (manually or by the future GC in `T-a4f8c1`), the child's pointers break.

**What landing looks like.** Extend `SessionStore.fork` to walk the parent's JSONL once, collect all `rawPath` entries, and either: (a) hardlink each blob from `<parent-sid>.blobs/<id>.raw` into `<child-sid>.blobs/<id>.raw` (cheap on the same filesystem, blobs are immutable), or (b) copy them. Hardlink is preferred; falls back to copy if `link()` returns `EXDEV`.

**Why deferred.** No reported breakage yet. The pointer-survives-fork case only matters in workflows that delete the parent. Cleaner to do this alongside `T-a4f8c1`.

### T-c91d4e: Promote ma-fetch markdown noise fix upstream into obscura

- [ ] state: `todo`
- created_at: 2026-05-26T00:15:29-04:00
- created_by: session=ca04ccf1-2161-4b14-af55-d264119d9384, design-time research found 47-line blank runs in Wikipedia output
- area: `~/Projects/obscura/` (separate repo)

**Description.** ma-fetch-plugin's `handlers/fetch.ts` now ships a defensive `normalizeMarkdown` helper that strips per-line trailing whitespace, collapses 2+ blank runs into one, and trims ends. It cuts Wikipedia output from 651 to 175 lines, github.com from 1160 to 539. The noise is upstream of ma-fetch though: obscura's HTML→markdown writer emits `\n\t\n\t\t\n…` for empty container elements. Fixing it once at the source removes the noise for every downstream consumer.

**What landing looks like.** Patch obscura's markdown writer pass to skip whitespace-only sibling blocks during emission. Open an issue with a Wikipedia reproducer (the captured fixture lives in `private/research/raw-tool-output/05-wikipedia-markdown.raw`).

**Why we still keep the ma-fetch normalizer.** Defense in depth, and it would still help with other backends if we swap obscura out.

### T-d72f5a: Blob store `_log.jsonl` diagnostic feed

- [ ] state: `todo`
- created_at: 2026-05-26T00:15:29-04:00
- created_by: session=ca04ccf1-2161-4b14-af55-d264119d9384, scaffolded in `src/blob-store.ts`
- area: `src/blob-store.ts`

**Description.** `blob-store.ts` exports an `appendBlobStoreDiagLine` helper that writes a one-line JSONL trace into `<sid>.blobs/_log.jsonl`. The helper exists but is not currently called by anything. The intent is a sidecar trace for "why didn't this blob land?" / "why was this evicted?" diagnostics. Lower priority than the GC work.

**What landing looks like.** Call `appendBlobStoreDiagLine` from the eligibility-skip paths inside `BlobStore.write` (when `enabled=false`, when below `minBytesToPersist`, when an error fired) and from the eviction loop (one line per evicted blob). One line per event, fields are `ts`, `kind`, `tool_use_id`, plus event-specific stuff. Add a `BlobStore.diag = false` constructor opt to turn it off; default off so tests don't spew.

### T-e83g6b: Optional always-persist mode

- [ ] state: `todo`
- created_at: 2026-05-26T00:15:29-04:00
- created_by: session=ca04ccf1-2161-4b14-af55-d264119d9384, raised in design discussion
- area: `src/blob-store.ts`

**Description.** Today the blob store skips writes below `minBytesToPersist` (default 4096 B). The reasoning: small bodies already fit in the inline `content`, no value in a sidecar file. But some workflows (full-fidelity session export, deterministic replay, model debugging) want EVERY tool output on disk regardless of size.

**What landing looks like.** Add `plugins.blob-store.alwaysPersist: false` (default) to user config. When true, `minBytesToPersist` is bypassed and every non-empty tool output lands. Document the disk-use trade-off in the change doc.

**Why deferred.** No user has asked yet. Adding the knob without a use case adds API surface we'd then have to keep working. Trivial to wire once needed.

### T-e7ce6f: Per-mode tool permission ACL (replaces the binary `disallowedTools` list)

- [ ] state: `todo`
- created_at: 2026-05-27T11:08:00-04:00
- created_by: session=100a7080-f2fe-4d5e-8f23-0b532d7df36a, conversation about hardening mode enforcement
- area: `src/modes.ts`, `src/plugins/types.ts` (`ManifestMode`), `src/agent.ts` (dispatch gate), `plugins/ask-mode/manifest.json`

**Description.** Today `ManifestMode` carries a flat `disallowedTools: string[]` list. `ModeManager.isToolAllowed` gates each `tool_use` at dispatch time against that list and synthesizes a refusal `tool_result` when blocked. This is solid for the "no Edit/Write in ASK" case but it cannot express:

- per-tool input-shape constraints (e.g. allow `Bash` only when the command matches a read-only allowlist like `git status|log|diff|show|ls|cat|rg|grep`)
- per-tool path constraints (e.g. allow `Edit` only inside `docs/`)
- per-tool argument constraints (e.g. allow `MemoryTool` for `list`/`read`, deny `add`/`edit`/`remove`)
- tier-graded refusals ("ask for confirmation" vs "hard deny")

**What landing looks like.** Replace `disallowedTools: string[]` with `permissions: ToolPermission[]` on `ManifestMode`, where `ToolPermission` is a discriminated union along the lines of:

```ts
type ToolPermission =
  | { tool: string; allow: true }
  | { tool: string; allow: false; refusalHint?: string }
  | { tool: string; allow: "match"; predicate: ToolInputPredicate; refusalHint?: string }

type ToolInputPredicate =
  | { kind: "bash-cmd-regex"; pattern: string }
  | { kind: "path-prefix"; field: string; prefix: string }
  | { kind: "field-in"; field: string; values: string[] }
```

Default policy is "allow" (so an empty `permissions` array means no restrictions, matching today's no-mode behavior). The dispatch gate evaluates predicates against the `tool_use.input` object and rejects with the same synthesized refusal envelope as today. Keep `disallowedTools` working for one release as sugar for `[{tool, allow: false}]`.

**Why deferred.** The current binary list covers the only mode we ship (ASK = no Edit/Write). Granular ACLs are valuable but the surface area is real (schema, validation, predicate engine, test matrix). Land the foundation work for modes first (this session): hard PROMPT, reliable activation markers, model-facing query channel, in-flight propagation. Once the foundation is solid, add the ACL.

**Open questions.**
- Predicate language: ad-hoc DSL (above) vs JSONSchema vs a tiny CEL-like expression evaluator. Ad-hoc DSL is the smallest surface; JSONSchema is the most expressive but heaviest.
- Should plugins be able to *contribute* permissions to a mode (e.g. the `git-tidy` plugin adds "Bash git:*" to a "read-only" mode)? That would need a permission-merge contract.
- Audit-log channel for refusals: today the dispatcher writes a transcript line (`⊘ refused by ask`). With richer predicates the audit gets noisier; consider a structured `refusals.jsonl` sidecar in the session.

### T-ca2ce1: Tag-namespace migration to `<ma::...>`  ✅ done 2026-05-28

- [x] state: `done`
- created_at: 2026-05-27T11:31:00-04:00
- closed_at: 2026-05-28
- created_by: session=100a7080-f2fe-4d5e-8f23-0b532d7df36a, conversation about mode-system overhaul
- closed_by: session=cb9aa802-6017-46c3-b764-385b6e476279
- area: tree-wide (all places that emit or parse XML-style tags in user/assistant content and tool_result envelopes)

**Landed.** Every model-facing tag now uses the `<ma::*>` namespace. Agent-runtime emissions are `<ma::agent::*>`, plugin-contributed emissions and inline-tag triggers are `<ma::plugin::<id>(::sub)?>`. Bracket footers (`[raw-output: …]`) are gone too: now `<ma::agent::raw-output path="…" size="…" sha256="…" />`. See `docs/changes/2026-05-28-feat-ma-schema-and-plugin-rename.md` and the CHANGELOG `[Unreleased]` entry for the full rename table. Session-replay accepts BOTH old and new spellings during a one-release migration window. Migration script for old session files at `private/migrations/20260528T161007-old-session-history-to-new-plugin-syntax.ts`.

### T-e945ec: Unify `tui-plugins/` and `src/plugins/` into a single tree  ✅ partial 2026-05-28

- [x] state: `done` (tui-plugins → plugins rename); see T-c510d3 for the next step (extract more core into the plugins/ tree).
- created_at: 2026-05-27T11:31:00-04:00
- closed_at: 2026-05-28
- area: `plugins/`, `src/plugins/loader.ts`, all `manifest.json` references

**Landed.** `tui-plugins/` is now `plugins/`. The loader scans `plugins/` (embedded), `~/.agents/plugins/` (home), and `<cwd>/.agents/plugins/` (project). Every comment, doctring, and test fixture under `src/` and `plugins/` was renamed in lockstep. `src/plugins/` still holds the loader + types (one tree, different role: the runtime engine vs the plugin packages it loads), which the original TODO description conflated.

### T-c510d3: Extract `ModeManager` + dispatch gate into a core plugin

- [ ] state: `todo`
- created_at: 2026-05-27T11:31:00-04:00
- created_by: session=100a7080-f2fe-4d5e-8f23-0b532d7df36a
- area: `src/modes.ts`, `src/agent.ts` dispatch gate, future `plugins/modes/` directory

**Description.** `ModeManager` and the dispatch-time `isToolAllowed` gate live in `src/`. They're "core" because the agent loop directly calls into them. But "everything is a plugin" is the project direction, and modes are a textbook plugin concern: per-feature behavior toggle + tool gating + UI styling, all already declared in plugin `manifest.json` files.

**What landing looks like.** A `plugins/modes/` (built-in) plugin that owns:
- The `ModeManager` lifecycle and the `ManifestMode` schema.
- The `<ma::mode-change>` + `<ma::mode-active>` tag emitters.
- The dispatch gate hook (registered as a tool-dispatch interceptor via the plugin bus).
- The `Mode` tool.
- The REPL keybindings (Shift+Tab, Ctrl+Shift+Tab, Alt+M).

The agent core retains only the abstract "tool-dispatch interceptor" extension point. Mode plugins (ask-mode, future plan-mode, etc.) register their modes with the core plugin via a published API.

**Why deferred.** The mode-system foundation work (session 100a7080) lands in the current shape (core + ask-mode plugin) to keep the diff focused. Once the foundation is stable, refactor location without changing semantics.

**Open questions.**
- Tool-dispatch interceptor API surface: synchronous gate vs async, single-callback vs ordered chain.
- How does `Mode` tool registration coexist with the future per-mode tool-permissions ACL (T-e7ce6f)?

## Audit log

History of state changes goes here as date-stamped one-liners. Helps a future agent understand why an entry's state moved.

- 2026-05-26T00:15:29-04:00: file created. Seeded with 5 deferred items from the blob-store design conversation (session ca04ccf1...).
- 2026-05-27T11:08:00-04:00: added T-e7ce6f (per-mode permission ACL) deferred from the mode-foundation work in session 100a7080.
- 2026-05-27T11:31:00-04:00: added T-ca2ce1 / T-e945ec / T-c510d3 (tag-namespace migration, plugins tree unification, ModeManager extraction) as deferred sibling work to the mode-system overhaul in session 100a7080.
