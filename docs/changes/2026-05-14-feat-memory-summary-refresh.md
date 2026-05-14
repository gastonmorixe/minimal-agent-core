# Memory summary refresh — compress system-prompt injection

**Status:** in progress
**Owner:** agent (session 66183d76)
**Scope:** `tui-plugins/memory/` plus `src/config.ts` for the config knob

## Problem

The `memory` plugin's prompt fragment dumps **every** bullet from `memory.md` verbatim into the system prompt at session start:

| scope | bullets | bytes | tokens (~4 ch/tok) |
| ----- | ------- | ----- | ------------------ |
| global | 28 | 20 KB | ~5 k |
| project | 94 | 89 KB | ~22 k |
| **total** | **122** | **~109 KB** | **~27 k** |

That's ~13% of a 200 k context window, **frozen at session start, never reclaimed**. And the snapshot is stale the moment the agent boots — concurrent saves, edits via the CLI, peers in shared worktrees all bypass it. We pay the cost AND don't get freshness.

## Options considered

### A. Headline index at injection time
Replace verbatim dump with first-sentence-per-bullet at session start.
- **Pro:** simple, no LLM cost.
- **Con:** loss of nuance for bullets whose content is mostly in the second/third sentence. Still in the hot path.
- **Rejected:** doesn't compose — every future derivation (embeddings, tags) repeats the same "do work at session start" mistake.

### B. Background worker + write-event-driven indexing
Subscribe to `memory.saved` etc., spawn detached workers, maintain a `memory.index.json`.
- **Pro:** zero work in the hot path; composes with future derivations.
- **Con:** complex — new channels, new background worker lifecycle, detached process management, debounce queue, multiple new files.
- **Rejected:** overkill for v1. The user explicitly asked to "forget about background stuff."

### C. Lifecycle-event refresh (chosen)
Run an LLM-driven summary refresh at the existing session-start fragment-load point. Cheap mtime gate → most boots do nothing. Refresh blocks only when actually stale. Within-session freshness via pending-bullet filter (no separate file).
- **Pro:** zero new infra; one new file plus a `load.ts` patch; uses existing `sendMessageSync` API and `getAuth()`.
- **Con:** stale within a session after saves (mitigated by the pending filter that re-reads bullet timestamps at injection time, not a separate delta file).
- **Chosen.**

## Architecture (option C)

```
                                                            (rare)
                                                             │
                                                             ▼
                            ┌────────────────────────────────────────────┐
                            │  WRITES                                    │
                            │  inline-tag `<tui::memory>` save           │
                            │  MemoryTool.add/edit/remove                │
                            │  CLI edits                                 │
                            │  peer agents in shared worktrees           │
                            │                                            │
                            │  → append/edit memory.md (source of truth) │
                            └────────────────────────────────────────────┘
                                                             │
                                                             │ mtime newer
                                                             ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  SESSION START — load.ts prompt fragment runs once                      │
│                                                                         │
│  1. read config: plugins.memory.summary.enabled?                        │
│  2. if disabled OR memory.md too small:                                 │
│        → inject memory.md verbatim (current behavior)                   │
│  3. else:                                                               │
│        a. read summary.md if present; parse <!-- regen-cutoff: … -->    │
│        b. if memory.md.mtime > cutoff AND dirtyBulletCount ≥ N:         │
│             → call summarize(memory.md) via sendMessageSync (Haiku)     │
│             → write summary.md atomically with new cutoff               │
│        c. parse memory.md, partition bullets by ts vs cutoff:           │
│             - bullets WITH ts ≤ cutoff → already in summary             │
│             - bullets WITH ts > cutoff → pending, inject as headlines   │
│             - bullets WITHOUT ts (legacy) → keep verbatim alongside     │
│        d. emit: summary.md body + "### Recent saves" + pending lines    │
└─────────────────────────────────────────────────────────────────────────┘
                                                             │
                                                             ▼
                                                  injected once,
                                                  frozen for session
```

### Source-of-truth invariant

```
        ┌─────────────┐
        │  memory.md  │   ← only source. only humans + plugin saves write.
        └──────┬──────┘
               │  summarize(memoryMd)  — one-way, no `previousSummary` arg
               ▼
        ┌─────────────┐
        │ summary.md  │   ← derived view. fully regenerable. never feeds back.
        └─────────────┘
```

The `summarize()` function signature MUST stay `(memoryMd: string) => Promise<string>` — no `previousSummary` parameter, ever. That door, once open, lets lossy compression compound across regens.

### Cutoff header format

`summary.md` starts with an HTML comment:

```html
<!-- regen-cutoff: 2026-05-14T03:45:00.123-04:00 -->

## Compositor invariants
- The capBlankLines mechanism caps `\n` runs to 3 (#mp0seavd-54cb, …)
…
```

The cutoff is the ISO timestamp of the regen-time. At injection, bullets with `ts > cutoff` are "not yet in the summary" and surface as headlines under a separate section. The comment form is invisible-by-convention in markdown but trivially parseable.

## Files touched

### New
- `tui-plugins/memory/lib/summarize.ts` (~80 lines) — LLM wrapper
- `tui-plugins/memory/lib/summarize.test.ts` (~60 lines) — tests
- `tui-plugins/memory/lib/summary-refresh.ts` (~140 lines) — refresh + injection helper
- `tui-plugins/memory/lib/summary-refresh.test.ts` (~200 lines) — tests
- `tui-plugins/memory/lib/memory-config.ts` (~50 lines) — config reader for `plugins.memory.summary.*`
- `tui-plugins/memory/lib/memory-config.test.ts` (~80 lines) — tests

### Modified
- `tui-plugins/memory/handlers/load.ts` — branch on summary-enabled config
- `tui-plugins/memory/handlers/load.test.ts` (or equivalent) — add summary-aware injection tests
- `tui-plugins/memory/PROMPT.md` — add the "read-before-extend" note

### Not touched (yet)
- `src/config.ts` — config-reader lives in the plugin (keeps plugin self-contained)
- `src/auth.ts` — re-used as-is via module-level `getAuth()`
- `src/client.ts` — re-used as-is via `sendMessageSync()`
- `tui-plugins/memory/manifest.json` — no new handler entries (load.ts does everything)

## Config schema

```jsonc
// ~/.minimal-agent/config.jsonc
{
  "plugins": {
    "memory": {
      "summary": {
        "enabled": false,           // OPT-IN initially; flip to true after vetting
        "model": "claude-haiku-4-5", // optional; defaults to a cheap haiku-class id
        "minBullets": 30,           // skip summarizer below this
        "minBytes": 15000,          // OR below this
        "dirtyBullets": 3           // also: require ≥ N pending bullets to regen
      }
    }
  }
}
```

- All keys optional; defaults baked in.
- `enabled` defaults to **false** so existing users see zero behavior change until they opt in. We flip to true once we have confidence (after a week or so).
- `model` is pass-through to `sendMessageSync({model})`; server validates.

## Behavior matrix

| state | action |
| --- | --- |
| `enabled: false` | verbatim memory.md (current behavior) |
| no summary.md AND memory.md < minBytes/minBullets | verbatim memory.md |
| no summary.md AND memory.md large | regen → inject summary |
| summary.md fresh (memory.md.mtime ≤ cutoff) | inject summary + (likely empty) pending |
| summary.md stale AND dirtyBullets < N | inject summary + pending (no regen yet) |
| summary.md stale AND dirtyBullets ≥ N | regen → inject summary + (empty) pending |
| LLM call fails | keep last-good summary; add a warning comment |
| LLM returns suspiciously short output | reject, keep last-good |

## Fail-safes

1. **No summary feedback loop.** `summarize(memoryMd)` — no `previousSummary` arg. Enforced by signature.
2. **LLM call failure → keep last good.** Atomic write means partial writes never land. Failure path returns last `summary.md` unchanged.
3. **Output validation.** Reject summary if `output.length < memoryMd.length * 0.05` (suspiciously empty) or `> memoryMd.length` (didn't compress). Falls back to last-good.
4. **Per-scope independent.** Global and project handled separately. Bug in one doesn't poison the other.
5. **Opt-in.** Defaults to `enabled: false` until vetted.

## Tests

Each new file gets a colocated `*.test.ts`. Coverage:

- `summarize.test.ts`: builds correct messages array; injects system prompt; handles auth failures gracefully; returns the LLM's text.
- `summary-refresh.test.ts`:
  - Skips when memory is small (under thresholds).
  - Skips when summary is fresh (mtime gate).
  - Skips when dirty count below threshold.
  - Triggers regen when all conditions met.
  - Atomic write (no partial summary.md on crash).
  - Cutoff header parse / write round-trip.
  - Pending bullet filtering by cutoff.
  - Rejects suspiciously short / suspiciously long LLM output.
  - Falls back to last-good on call failure.
- `memory-config.test.ts`: parses each knob; applies defaults; ignores malformed values.
- `load.test.ts` additions: with summary enabled vs disabled; pending section appears only when bullets > cutoff exist; verbatim fallback when summary disabled or missing.

## Deferred (future work)

- **Near-duplicate detection at save** (the second lossy-cycle safeguard from the discussion thread). Worthwhile, but separate change.
- **`hookSubscribers` field in manifest** + emit `agent.didStart` / `turn.willStart` properly. Would let other plugins follow the same lifecycle pattern.
- **Turn-submit refresh.** Currently the refresh only fires at session start. After we wire `turn.willStart`, the same refresh can subscribe there too for within-session re-summarization.
- **Per-bullet embeddings / vector index.** ~120 bullets doesn't need it. Worth revisiting at ~500.

## Future-work issues to file

1. Wire `agent.didStart` / `agent.willStop` / `turn.willStart` in `src/index.ts` so plugins can subscribe.
2. Add a `hookSubscribers` field to the plugin manifest schema.
3. Near-duplicate detection in `store.ts` save path.
4. PROMPT.md addition: "before saving a memory that extends an existing topic, MemoryTool.read the full body, not the summary."

## Rollout plan

1. Land all code with `enabled: false` default. Existing users see zero change.
2. Run with `enabled: true` locally for a few days; check whether the summary actually compresses well.
3. Document the knob in the README.
4. Flip default to `enabled: true` once vetted.
