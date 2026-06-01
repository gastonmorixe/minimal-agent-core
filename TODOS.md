---
title: TODOS
description: Deferred work, ideas, and known-but-not-yet items. One file at the repo root so any future session can find it. Append-only in spirit; entries are edited only to flip state (todo → doing → done/canceled) and to add a timestamped resolution.
schema_version: 1
created_at: 2026-05-26T00:15:29-04:00
last_updated: 2026-05-31T20:36:00-04:00
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

### T-7c3f02: opus-4-8 tool-batch hallucination under interleaved-thinking

- [x] state: `done`
- created_at: 2026-05-31T15:12:00-04:00
- created_by: session=4eae09c7-9529-404c-9fba-8aef47abce73, surfaced live while answering a question about raw-tool-output persistence
- done_at: 2026-05-31T20:36:00-04:00
- done_by: session=38a5e964-bc9a-430b-b5a1-0abe0dd737a1 (fresh session, clean transport)
- outcome: Fixed by gating `interleaved-thinking-2025-05-14` OFF for opus-4-8 in `src/headers.ts` + `plugins/llm-anthropic/beta-flags.ts` (escape hatch `MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING=1`). +3 regression tests in `src/headers.test.ts`; 2 opus-4-8 fixture-parity tests updated. Full suite 4436 pass / 0 fail. Change-doc: `docs/changes/2026-05-31-fix-opus48-interleaved-thinking-tool-batching.md`. Corrected root cause: `private/tool-bugs-and-improvements/08-ROOT-CAUSE-corrected.md`.
- area: `src/headers.ts`, `plugins/llm-anthropic/beta-flags.ts`

**Description (corrected).** The original framing — "provider-refactor delivery regression, tool results stall then flush" — was WRONG, diagnosed from a degraded transport. Wire captures (`.net-dbg`) prove the harness delivers every tool result correctly (cumulative `tool_use`->`tool_result` counts match exactly across 20 round-trips). The real defect is model behavior: opus-4-8 under `interleaved-thinking-2025-05-14` emits many `tool_use` blocks in ONE turn (observed 44) with `thinking` blocks between them that reason about same-turn tool results that cannot exist yet, inducing a self-inflicted "results are batching/stalling" spiral + duplicate calls. Differential proof: pre-refactor opus-4.7 with the SAME beta is clean, so the change tracks the MODEL (4.7->4.8), not the refactor.

**Self-evidence.** A single read-only question produced 33 blobs, 21 (64%) byte-identical re-reads. Blob-dir `dupes > 0` after a no-re-read session was the oracle. The model's own interleaved thinking literally narrated the false "batching/flushing" story mid-turn (quoted in doc 08).

**Resolution.** Omit interleaved-thinking for opus-4-8 only; 4.6/4.7 + sonnet keep it (they sequence tool use correctly). Removes the mechanism at its source: standard adaptive thinking means the model thinks once, emits its batch, gets ALL results, then thinks again next turn — no thinking block sits between same-turn tool_use blocks.

**Full writeup.** `private/tool-bugs-and-improvements/` docs 01-08 (08 is the corrected root cause; 05-07 preserve the wrong path on purpose). Tracked live as tasks `#73dafa` (superseded) then the Phase 0-5 tree, and project memories `mpu5q1np-b8b4`, `mpu6wm1f-5814`.

### T-9d2e44: Content-dedup blobs by sha256 (standalone, deferred from T-7c3f02)

- [ ] state: `todo`
- created_at: 2026-05-31T20:36:00-04:00
- created_by: session=38a5e964, split out of T-7c3f02 when its retry-storm justification was removed by the fix
- area: `src/blob-store.ts`

**Description.** Two tool calls with byte-identical output currently write two separate `<tool_use_id>.raw` blobs (no dedup, by design — see `docs/changes/2026-05-26-feat-blob-store.md` Option A). Legitimate identical re-reads (same file read twice across a session) still duplicate on disk. A content-dedup would collapse them.

**Why deferred / why non-trivial.** The original driver (cap a retry storm's disk/context bloat) is gone now that T-7c3f02 is fixed. A SAFE implementation cannot just point two ids at one file: that breaks the per-`tool_use_id` blob invariant and the LRU byte accounting in `evictIfOverCap`. It needs either ref-counting (evict only when the last referencing id is gone) or a content-addressed store (`<sha256>.raw` + an id->sha index). Low priority; only worth it if disk growth from honest duplicate reads becomes a real problem.

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

### T-5c4d10: Self-paced `/loop` — let the model choose the next interval

- [ ] state: `todo`
- created_at: 2026-05-30T19:00:33-04:00
- created_by: session=38cfcafc-1a28-4aaa-af15-908130bc7eea, schedule-plugin work (see `docs/changes/2026-05-30-schedule-plugin.md`)
- area: `plugins/schedule/lib/scheduler.ts`, `plugins/schedule/handlers/cmd_loop.ts`, a new `CronReschedule`/`CronUpdate` tool

**Description.** The scheduled-tasks doc's "let Claude choose the interval" mode picks a fresh delay (1 min–1 h) after EACH iteration based on what it observed. v1 approximates this: a `pace:"dynamic"` task fires, then auto-advances `nextAtMs` by a fixed `DEFAULT_DYNAMIC_MS` (5 min). The model cannot actually adjust the cadence — `CronCreate` would mint a NEW task, and there is no update path.

**What landing looks like.** A `CronReschedule({id, every|nextAtMs})` (or `CronUpdate`) tool the model calls at the end of a dynamic iteration to set the next wakeup, plus a one-line "next wakeup in Nm because …" echo (the doc prints the chosen delay + reason). `cmd_loop` keeps creating the dynamic task; the heartbeat respects the model-set `nextAtMs` instead of the fixed default. Optionally surface the chosen delay in the footer status row.

**Open questions.** Where does the "after each iteration, pick a delay" instruction live — a PROMPT.md addition that fires only for dynamic loops, or an attachment injected alongside the loop prompt? The doc's Monitor-tool streaming path (a background script whose lines re-trigger the loop) is a separate, larger follow-up and explicitly out of scope here.

### T-6e8a22: Esc stops the active `/loop`

- [ ] state: `todo`
- created_at: 2026-05-30T19:00:33-04:00
- created_by: session=38cfcafc-1a28-4aaa-af15-908130bc7eea, schedule-plugin work
- area: `src/agent/repl-live-area.ts` (or an `editor.key`/abort hook), `plugins/schedule`

**Description.** The doc says pressing Esc while a `/loop` waits for its next iteration clears the pending wakeup so it does not fire again. In this port, Esc aborts the current turn but the cron task keeps firing; cancellation is only via `/schedule cancel <id>` or `CronDelete`. There is no "stop the loop I just started" gesture.

**What landing looks like.** Esc at idle (no turn running) cancels the most-recently-created `source:"loop"` task (or all loop tasks), with a one-line scrollback confirmation. Needs a decoupled signal: either the schedule plugin subscribes to an existing abort/idle channel, or a small `loop.stop` convention. Must not interfere with Esc's existing turn-abort and reflection-cooldown-skip semantics. Non-loop scheduled tasks (created by NL/tool) stay put, matching the doc.

### T-7f9b33: Commands + scheduler in non-REPL / `--print` / headless-resume runs

- [ ] state: `todo`
- created_at: 2026-05-30T19:00:33-04:00
- created_by: session=38cfcafc-1a28-4aaa-af15-908130bc7eea, schedule-plugin work
- area: `src/agent.ts` (`runRepl` vs the print/agent path), `plugins/schedule`, `plugins/slash-menu`

**Description.** Slash-command dispatch (`onSubmit` interception) and the schedule heartbeat (a live-area slot) are REPL-scoped. A `--print` one-shot, a piped invocation, or a resumed non-interactive run won't dispatch `/loop` and won't tick the heartbeat. That's acceptable for v1 (the feature is inherently interactive) but undocumented at the code level and surprising if someone scripts `/schedule …`.

**What landing looks like.** Decide + document the boundary. Either (a) explicitly no-op commands/scheduling outside the live-area REPL with a clear message, or (b) move command dispatch to a shared seam both paths call (the agent loop's user-input boundary) and gate the heartbeat on a non-REPL timer when a session is attached. The cron TOOLS already work in any path (they're normal tool calls); only the `/command` sugar + the firing loop are REPL-bound.

### T-8a0c44: Extract command registry/dispatch into `loader/commands.ts`

- [ ] state: `todo`
- created_at: 2026-05-30T19:00:33-04:00
- created_by: session=38cfcafc-1a28-4aaa-af15-908130bc7eea, schedule-plugin work
- area: `src/plugins/loader.ts`, new `src/plugins/loader/commands.ts`

**Description.** The `commands[]` host port added the registry + `dispatchCommand` + `getCommands`/`hasCommand`/`listCommandInfo` directly to `loader.ts`, which was already over the oxlint `max-lines` (800) soft warning. The repo already splits loader internals into `loader/helpers.ts` and `loader/event-subs.ts`; the command bits should follow.

**What landing looks like.** Move `resolveCommand` (already in `event-subs.ts`), the `commandIndex` build, dispatch context construction, and the parse seam into `loader/commands.ts`, leaving thin delegating methods on `PluginLoader`. Pure refactor, no behavior change; the existing `src/plugins/commands.test.ts` is the guard.

### T-9b1d55: `/loop` arg + slash-menu UX polish

- [ ] state: `todo`
- created_at: 2026-05-30T19:00:33-04:00
- created_by: session=38cfcafc-1a28-4aaa-af15-908130bc7eea, schedule-plugin work
- area: `plugins/schedule/lib/loop-parse.ts`, `plugins/slash-menu/*`, `src/plugins/manifest.ts`

**Description.** A cluster of small, deferred niceties: (1) `/loop` only parses a LEADING interval (`5m …`, `every 2 hours …`); the doc also allows a trailing clause (`/loop check CI every 2 hours`). (2) slash-menu `Tab`/`Enter` always complete to `/<name> ` (trailing space), so a bare command like `/loop` needs two Enters to submit — Enter on an exact full-name match could submit directly. (3) The menu filter is prefix + substring; a real subsequence/fuzzy ranking would help once there are many commands. (4) Command handlers are module-only; subprocess command handlers (JSON stdout round-trip) are unimplemented.

**What landing looks like.** Pick off independently. (1) extend `parseLoopArgs` to detect a trailing duration token/clause; (2) add an exact-name Enter-submits branch to `on_key`; (3) swap `filterCommands` substring pass for a scored subsequence matcher; (4) extend `parseCommand` + `resolveCommand` to accept `subprocess` and add an envelope protocol. None are blocking; all have unit-test homes already.

## Audit log

History of state changes goes here as date-stamped one-liners. Helps a future agent understand why an entry's state moved.

- 2026-05-26T00:15:29-04:00: file created. Seeded with 5 deferred items from the blob-store design conversation (session ca04ccf1...).
- 2026-05-27T11:08:00-04:00: added T-e7ce6f (per-mode permission ACL) deferred from the mode-foundation work in session 100a7080.
- 2026-05-27T11:31:00-04:00: added T-ca2ce1 / T-e945ec / T-c510d3 (tag-namespace migration, plugins tree unification, ModeManager extraction) as deferred sibling work to the mode-system overhaul in session 100a7080.
- 2026-05-30T18:59:03-04:00: added T-5a17e0 / T-5b28f1 / T-5c39a2 / T-5d40b3 / T-5e51c4, deferred follow-ups from the system-prompt role-composition refactor (commits 429f54d + 16c9c36, session 5f286880). Note T-ca2ce1 (tag-namespace migration) is closely related and partly subsumed: this refactor landed the `<ma::sys|agent|emit::>` grammar for the system-prompt + live tags; T-5c39a2 tracks the remaining saved-session migration.
- 2026-05-30T17:15:00-04:00: added T-9c2e7a, T-4b1f08, T-d3a6e2, T-77c9b4, T-1e5fa3, T-a08d6c, T-b6402d (multimodality follow-ups: Files-API upload + progress line, OpenAI media limits, compress modal, real-terminal smoke test, ModelInfo nudge fragment, audio/video enablement, and the gated commit) from session 40d7e158 multimodal ingestion build. Design lives in `private/multimodality-ingestion/`.
- 2026-05-30T19:00:33-04:00: added T-5c4d10 / T-6e8a22 / T-7f9b33 / T-8a0c44 / T-9b1d55, deferred follow-ups from the scheduled-tasks port (schedule + slash-menu plugins + the prompt.inject / commands[] / live-area-emit host ports, session 38cfcafc; see `docs/changes/2026-05-30-schedule-plugin.md`). The feature shipped green; these are the intentional v1 cuts: model-driven self-paced loop intervals, Esc-to-stop-loop, non-REPL command/scheduler scope, a loader.ts split, and assorted /loop + slash-menu UX polish.
- 2026-05-30T20:35:00-04:00: session 2dae6456 resumed the role-composition refactor and CLOSED 3 of its 5 follow-ups: T-5a17e0 done (commit 7cb912b, surgical filtered-patch commit of the 3 entangled comment files), T-5b28f1 done (26b0174, 4 dev-doc READMEs), T-5e51c4 done (de76b9f) — the latter promoted from latent to live because session 38cfcafc's `schedule`/`sub-agents` plugins are the first real multi-tool packs and were mis-composing. T-5c39a2 (saved-session migration) and T-5d40b3 (global-cache-block move) remain `todo` by deliberate decision — see their sharpened "Why deferred" notes (381/2459 sessions resume fine via read-tolerance; the cache move needs sign-off + measurement).
