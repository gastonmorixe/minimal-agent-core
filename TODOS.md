---
title: TODOS
description: Deferred work, ideas, and known-but-not-yet items. One file at the repo root so any future session can find it. Append-only in spirit; entries are edited only to flip state (todo → doing → done/canceled) and to add a timestamped resolution.
schema_version: 1
created_at: 2026-05-26T00:15:29-04:00
last_updated: 2026-05-30T18:59:03-04:00
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

### T-5a17e0: Land the 3 entangled `<ma::emit::>`/`<ma::agent::>` comment renames

- [x] state: `done`
- created_at: 2026-05-30T18:59:03-04:00
- created_by: session=5f286880-03b8-4fb6-a2d5-b079a0f0bd2b, deferred during the system-prompt role-composition refactor (commits 429f54d + 16c9c36; see `docs/changes/2026-05-30-system-prompt-role-composition.md`)
- done_at: 2026-05-30T20:34:00-04:00
- outcome: commit 7cb912b (session 2dae6456). All 11 comment renames landed via a filtered zero-context patch (`git apply --cached --unidiff-zero`) so only my lines committed; the concurrent writer's WIP in the same 3 files stayed in the tree untouched. `grep -rn 'ma::plugin::' src/agent.ts src/index.ts src/plugins/types.ts` → 0; wip preserved (30/232/376 lines); typecheck green.
- area: `src/agent.ts`, `src/index.ts`, `src/plugins/types.ts`

**Description.** The refactor renamed model-facing tags (`<ma::plugin::*>` → `<ma::emit::*>` / `<ma::agent::*>`). The functional renames are committed. Three files carry only COSMETIC docstring/comment renames of those tags but could not be committed because they were entangled with unrelated in-flight work (a concurrent writer's prompts-as-markdown / SessionInfo workstream) in the same files. `agent.ts` (4 hunks) and `index.ts` (1 hunk) are cleanly hunk-isolatable; `types.ts` has 2 of its 4 renames buried inside a ~109-line WIP hunk, so it cannot be cleanly separated.

**What landing looks like.** When that WIP commits (or is reverted), fold the comment renames in: `git add -p` the pure-mine hunks in `agent.ts`/`index.ts`, and for `types.ts` either wait for the WIP to land then sweep `ma::plugin::` → `ma::emit::` in the 4 TagSpan/trigger docstrings, or `git add -e` the two trapped lines. Verify with `grep -rn 'ma::plugin::' src/{agent,index}.ts src/plugins/types.ts` → 0.

**Why deferred.** Comment-only, zero functional impact, and partial-staging on files an active concurrent writer is editing already caused one bad `--amend` (recovered). Cleanest to let them ride the WIP commit.

### T-5b28f1: Update 4 plugin dev-doc READMEs to the new tag scheme

- [x] state: `done`
- created_at: 2026-05-30T18:59:03-04:00
- created_by: session=5f286880-03b8-4fb6-a2d5-b079a0f0bd2b, found during post-refactor doc audit
- done_at: 2026-05-30T20:32:00-04:00
- outcome: commit 26b0174 (session 2dae6456). All 12 refs across the 4 READMEs renamed; `grep -rn '<ma::plugin::\|<memory-saved\|<short-term-memory' plugins/*/README.md` → 0.
- area: `plugins/diff-view/README.md` (4), `plugins/interleave-thinking/README.md` (3), `plugins/memory/README.md` (3), `plugins/tasks/README.md` (2)

**Description.** The MODEL-facing prompts (PROMPT.md) are fully migrated, but these four developer-facing READMEs still document the old `<ma::plugin::*>` / `<memory-saved>` / `<short-term-memory>` tags (12 refs total). Not a correctness issue (READMEs are not sent to the model), just stale dev docs.

**What landing looks like.** Sweep each README: `<ma::plugin::diff>` → `<ma::emit::diff>`, `<ma::plugin::memory>` → `<ma::emit::memory>`, `<ma::plugin::interleave-thinking>` → `<ma::emit::interleave-thinking>`, `<ma::plugin::tasks>` → `<ma::agent::tasks>`, `<ma::plugin::memory::short-term>` → `<ma::agent::short-term-memory>`, `<memory-saved>` → `<ma::agent::memory-saved>`. Confirm `grep -rn '<ma::plugin::\|<memory-saved\|<short-term-memory' plugins/*/README.md` → 0.

**Why deferred.** Out of the refactor's stated scope (system-prompt generation). Low urgency.

### T-5c39a2: Extend the session-history migration to the new attachment/emit renames

- [ ] state: `todo`
- created_at: 2026-05-30T18:59:03-04:00
- created_by: session=5f286880-03b8-4fb6-a2d5-b079a0f0bd2b, deferred during the role-composition refactor
- area: `private/migrations/`, cross-check `src/session-replay.ts`, `src/session-restore.ts`

**Description.** Saved sessions (`~/.minimal-agent/sessions/*.jsonl`) created before this refactor carry the OLD per-turn attachment tags (`<ma::plugin::tasks>`, `<ma::plugin::memory::short-term>`, `<memory-saved>`) and old model-emitted tags in assistant turns (`<ma::plugin::diff|memory|interleave-thinking>`). On resume these still render correctly because `session-replay.ts` / `session-restore.ts` match the legacy forms by design, but the stored bytes stay old.

**What landing looks like.** A migration (sibling to `private/migrations/20260528T161007-old-session-history-to-new-plugin-syntax.ts`) that rewrites `<ma::plugin::tasks>` → `<ma::agent::tasks>`, `<ma::plugin::memory::short-term>` → `<ma::agent::short-term-memory>`, `<memory-saved …>…</ma::plugin::memory::saved>` → `<ma::agent::memory-saved>`, and `<ma::plugin::{diff,memory,interleave-thinking}>` → `<ma::emit::…>` in saved JSONL. Dry-run default, `--apply`, full backup, tests, same as the prior migration.

**Why deferred (evidence, session 2dae6456).** Measured 381 of 2459 saved sessions carry old tags. They resume CORRECTLY today: `session-replay.ts` matches `<ma::plugin::*>` + legacy bare forms, `session-restore.ts` likewise. A migration is a destructive batch rewrite of 381 user-data files for zero functional gain while read-tolerance stands, so it stays deferred and must not run unprompted (irreversible-ish even with backup). Do it only as the deliberate companion to removing the legacy read-path tolerance, on the user's call.

### T-5d40b3: (perf, optional) move stable `<ma::sys::*>` sections to the global cache block

- [ ] state: `todo`
- created_at: 2026-05-30T18:59:03-04:00
- created_by: session=5f286880-03b8-4fb6-a2d5-b079a0f0bd2b, deferred design alternative from the role-composition refactor
- area: `src/agent.ts` (system-prompt assembly), `src/llm/system-prompt.ts`, `src/plugins/loader.ts`

**Description.** Plugin-composed prompt text currently rides in the session-context block (system[3], per-session cache). The `behavior` / `tool` / `emit` / `mode` sections are stable across users with the same plugin set, so they are candidates for system[2] (the `scope:"global"`, cross-session-shared cache block). Only `context` sections (env snapshot, skills catalog) are genuinely per-session and must stay in system[3].

**What landing looks like.** `loader.getPromptBlock*` returns the composition split by stability (global vs session), and `agent.ts` appends the global sections to the cached instructions block (system[2]) and the context sections to system[3]. The loader should reject `kind: behavior/tool/...` content containing volatile interpolation to keep the global block byte-stable across users.

**Why deferred (reaffirmed, session 2dae6456).** This is the one remaining item I am deliberately NOT doing: it moves plugin content across cache breakpoints (system[3] → system[2] `scope:"global"`), which is exactly the cache layout + provider-seam area the refactor was scoped to leave untouched (`src/llm/system-prompt.ts:buildAgentSystemBody`). Perf-only upside (cross-session cold-start cache sharing); within a session the per-session breakpoint already gives turn-over-turn reuse. Wants explicit sign-off + its own before/after cache-hit measurement before touching.

### T-5e51c4: (minor) per-tool section naming for multi-tool plugins

- [x] state: `done`
- created_at: 2026-05-30T18:59:03-04:00
- created_by: session=5f286880-03b8-4fb6-a2d5-b079a0f0bd2b, known limitation noted during the refactor
- done_at: 2026-05-30T20:34:30-04:00
- outcome: commit de76b9f (session 2dae6456). Promoted from latent to live: the concurrent writer's `schedule` (3 Cron tools) and `sub-agents` (7 tools) plugins both ship one PROMPT.md and WERE mis-composing as `<ma::sys::tool name="CronCreate">` / `name="SpawnAgent">`. Fix: a >1-tool plugin names its tool section after the plugin's H1/display-name slug (schedule → "schedule", sub-agents → "sub-agents"); single-tool plugins keep the tool name. 2 new unit tests cover the multi-tool branch.
- area: `src/plugins/loader/helpers.ts` (`classifyPluginPrompt`), `src/plugins/loader.ts` (`buildBlock`)

**Description.** `classifyPluginPrompt` named a `tool`-role section after the FIRST tool the plugin declares and composed the whole PROMPT.md under that one `<ma::sys::tool name="…">`. A multi-tool plugin shipping one PROMPT.md would mislabel the section after only tool #1.

**What landed.** Multi-tool plugins (`> 1` tool handler) now name the section after the plugin's H1/display-name slug, same fallback a behavior section uses; single-tool plugins keep the bound tool name. (The richer alternative — splitting one PROMPT.md into a per-tool section via a body convention — was considered and rejected as overkill: a multi-tool pack's doc is written as one narrative covering the tool family.)

**Why deferred.** No current plugin triggers it; speculative until one does.

### T-9c2e7a: Media Files-API upload + live upload-progress line (v1.1)

- [ ] state: `todo`
- created_at: 2026-05-30T17:15:00-04:00
- created_by: session=40d7e158-b860-4768-ac70-54f029a29813, multimodality ingestion build (design in `private/multimodality-ingestion/`)
- area: `plugins/llm-anthropic/*`, `plugins/llm-openai/*`, `src/llm/provider.ts` (`prepareMedia`/`onMediaProgress` already defined), `src/media/*`, `src/agent/repl-live-area.ts`

v1 inlines images as base64 (matches Claude Code; verified byte-identical to the captured wire). The upgrade: implement `ProviderAdapter.prepareMedia()` to upload large/reused media to the provider file store and reference it by id, caching into `item.prepared[providerId]`.

- Anthropic: `POST /v1/files`, beta header `files-api-2025-04-14`, then image source `{type:"file", file_id}` (canonical `kind:"file_id"` is already encoded by `adapter-legacy.ts`). Threshold ~1 MB or reused-across-turns.
- OpenAI: `/v1/files`, then Responses `input_image{file_id}` (already encoded in `responses/request-body.ts`).
- Progress: `prepareMedia` emits `RunContext.onMediaProgress(mediaId, phase, fraction, bytesDone/total)` (hook already on the port); the agent renders a transient line ABOVE the input prompt via the live-area decoration region (`renderDecoration` in `repl-live-area.ts`), cleared on ready/failed. This satisfies the "preemptive upload starts while the user is still typing" requirement.

**Why deferred.** base64 path ships first and is sufficient for the common case; the upload path is the bandwidth/latency optimization for big or repeated media.

### T-4b1f08: openaiMediaLimits() for the canonical OpenAI submit path

- [ ] state: `todo`
- created_at: 2026-05-30T17:15:00-04:00
- created_by: session=40d7e158-b860-4768-ac70-54f029a29813
- area: `src/media/`, `plugins/llm-openai/`

`src/media/anthropic.ts` exports `anthropicMediaLimits()` (32 MB request / 5 MB item / jpeg-png-gif-webp + pdf). Today the live media submit path is Anthropic-only (`resolveUserTurnContent` in `src/media/ingest.ts`). When media submit-resolution runs for OpenAI models, add `openaiMediaLimits()` (OpenAI's size/detail rules differ) and have the agent pick limits by the active model's provider instead of hardcoding Anthropic. `MediaItem.prepared` is already keyed by `providerId` so one item can be base64 to Anthropic and file_id to OpenAI without conflict.

### T-d3a6e2: "Compress to fit?" modal for oversize media

- [ ] state: `todo`
- created_at: 2026-05-30T17:15:00-04:00
- created_by: session=40d7e158-b860-4768-ac70-54f029a29813
- area: `src/media/limits.ts` (verdict), `src/llm/provider.ts` (`preflight`/`applyResolution`), host modal

No image resize / audio-video transcode now (explicit constraint). Over-limit media is rejected today with a transient `diag.warn` in the live area. The reject path is deliberately shaped as a single pure verdict (`checkMedia`) so the future behavior is: an over-limit item produces a `PreflightIssue{code:"media.oversize", options:[compress|drop|cancel]}` and the host modal offers to compress. A `compress()` step slots between the `validated` and `ready` lifecycle states and rewrites bytes + `bytesSent`; the verdict + registry don't change.

### T-77c9b4: Real-terminal smoke test of media capture + ModelInfo tool

- [ ] state: `todo`
- created_at: 2026-05-30T17:15:00-04:00
- created_by: session=40d7e158-b860-4768-ac70-54f029a29813
- area: manual / e2e

The data path is unit-tested + verified byte-identical to the captured wire, but live TTY input can't be driven from a headless agent. Manually: (1) drag a Finder image onto the prompt → confirm `[Image #id WxH size]` token appears; (2) type "describe this" + Enter → opus-4-8 sees it; (3) copy an image, trigger the clipboard path (empty paste) → token appears; (4) drag a 40 MB file → live-area warning, no token; (5) ask "what can you do?" → confirm the model calls `ModelInfo` and answers correctly; (6) confirm a plain text turn is byte-identical to before. Clipboard shim platform coverage (`src/media/clipboard.ts`): macOS `pngpaste`/`osascript`, Linux `wl-paste`/`xclip` — verify on the target OS.

### T-1e5fa3: Optional ModelInfo nudge prompt-fragment (belt-and-suspenders)

- [ ] state: `todo`
- created_at: 2026-05-30T17:15:00-04:00
- created_by: session=40d7e158-b860-4768-ac70-54f029a29813
- area: `plugins/model-info/` (add a prompt-fragment handler)

The `ModelInfo` tool's description nudges the model to consult it before claiming it lacks a capability (e.g. accepting images). If, in practice, the model still answers capability meta-questions from priors without calling the tool, add a SMALL model-INDEPENDENT system-prompt fragment (contributed by the `model-info` plugin itself, so it stays self-contained) saying capabilities can change mid-session/on-resume and to call `ModelInfo`. Model-independent text stays in the global prompt cache and adds nothing to resume drift. Gauge need after T-77c9b4.

### T-a08d6c: Enable audio/video ingestion when a provider accepts it

- [ ] state: `todo`
- created_at: 2026-05-30T17:15:00-04:00
- created_by: session=40d7e158-b860-4768-ac70-54f029a29813
- area: `src/media/*`, provider plugins' `capabilities.ts`

`MediaKind` includes `audio`/`video` and the registry/probe handle them; they're gated off because no current model accepts them (`modalities.audio/video=false`). OpenAI Chat already has an `input_audio{data,format}` encoder in `chat/request-body.ts`. To enable audio for a capable model: flip `modalities.audio=true` on its registry entry, add accepted formats + byte limits, and the existing `AudioBlock` path carries it. Video needs a canonical video block first (none today; `resolve.ts` returns null for video).

### T-b6402d: Commit the media + ModelInfo + OpenAI work once the tree is green

- [ ] state: `todo`
- created_at: 2026-05-30T17:15:00-04:00
- created_by: session=40d7e158-b860-4768-ac70-54f029a29813
- area: git / repo hygiene

The media-ingestion + `ModelInfo` + OpenAI-image work is complete and green in its own scope (format/lint/typecheck clean, 103 media/model-info/openai tests pass), but the shared worktree is co-occupied by session `5f286880`'s in-flight tool refactor: ~50 of their files are modified, `src/plugins/agent-context.ts` is untracked, and my wiring in `index.ts`/`loader.ts`/`agent.ts`/`plugins/types.ts`/`editor-controller.ts` is intermixed with theirs and imports their untracked `createAgentContext`. A clean isolated commit won't build; a blanket commit captures their unfinished refactor + (transient) failing tests. Once `5f286880` lands and `format:check && lint && typecheck && test` are green, commit the combined tree. My files: `src/media/*`, `src/llm/model-info.ts`(+test), `plugins/model-info/*`, `src/llm/adapter-legacy-media.test.ts`, edits to `src/client/types.ts`/`client.ts`/`llm/adapter-legacy.ts`/`llm/provider.ts`/`client/debug.ts`/`session-dump.ts`/`agent.ts`/`editor-controller.ts`/`index.ts`/`plugins/types.ts`/`plugins/loader.ts`/`plugins/llm-openai/responses/request-body.ts`(+`openai.test.ts`).

## Audit log

History of state changes goes here as date-stamped one-liners. Helps a future agent understand why an entry's state moved.

- 2026-05-26T00:15:29-04:00: file created. Seeded with 5 deferred items from the blob-store design conversation (session ca04ccf1...).
- 2026-05-27T11:08:00-04:00: added T-e7ce6f (per-mode permission ACL) deferred from the mode-foundation work in session 100a7080.
- 2026-05-27T11:31:00-04:00: added T-ca2ce1 / T-e945ec / T-c510d3 (tag-namespace migration, plugins tree unification, ModeManager extraction) as deferred sibling work to the mode-system overhaul in session 100a7080.
- 2026-05-30T18:59:03-04:00: added T-5a17e0 / T-5b28f1 / T-5c39a2 / T-5d40b3 / T-5e51c4, deferred follow-ups from the system-prompt role-composition refactor (commits 429f54d + 16c9c36, session 5f286880). Note T-ca2ce1 (tag-namespace migration) is closely related and partly subsumed: this refactor landed the `<ma::sys|agent|emit::>` grammar for the system-prompt + live tags; T-5c39a2 tracks the remaining saved-session migration.
- 2026-05-30T17:15:00-04:00: added T-9c2e7a, T-4b1f08, T-d3a6e2, T-77c9b4, T-1e5fa3, T-a08d6c, T-b6402d (multimodality follow-ups: Files-API upload + progress line, OpenAI media limits, compress modal, real-terminal smoke test, ModelInfo nudge fragment, audio/video enablement, and the gated commit) from session 40d7e158 multimodal ingestion build. Design lives in `private/multimodality-ingestion/`.
