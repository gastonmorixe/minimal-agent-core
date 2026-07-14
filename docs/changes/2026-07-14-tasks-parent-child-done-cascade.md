# Tasks: parent ↔ child done cascade / rollup

**Date:** 2026-07-14
**Scope:** `ma-tasks-plugin` (`lib/store.ts`, handler `all_done` path, PROMPT.md)

## Problem

Parent tasks with fully-finished subtasks stayed `todo`/`doing` until the
model remembered a second `done` call. Real sessions (e.g. sid `418fd57e`)
ended phases looking incomplete in the live list even though every child
was ✔. The PROMPT even documented this as intentional ("the store does not
auto-promote, that is on you") — which cost an extra tool call per phase
and regularly left parents stuck open.

The inverse was also true: marking a parent phase `done` left open
children sitting under a finished header.

## Decision

Make tree consistency a store invariant on `status === "done"` only:

| Mutation | Effect |
|---|---|
| Parent → `done` | Cascade open children (`todo` / `doing`) to `done`. Leave already-`done` alone. Leave `canceled` alone (abandoned ≠ finished). |
| Child → `done` | If every sibling is also `done` and the parent is not `canceled`/`done`, promote the parent to `done`. |

Other statuses do **not** cascade. Cancel, reopen, and single-doing demotion
stay explicit one-row mutations.

Rules of thumb for the edge cases:

- A canceled sibling **blocks** auto-promote (the phase is not fully done).
- A canceled parent is **never revived** when a late child finishes.
- One `nowPair()` sample covers the whole cascade so timestamps match and
  duration accrual stays consistent.

## Implementation

- `TaskStore.setStatus` — after the primary transition, call private
  `applyDoneCascade` when status is `done`, then a single `writeAll`.
- `TaskStore.done` inherits via `setStatus`.
- Handler `doDone` / `doStatus` — "ALL DONE" verb now keys off post-cascade
  stats for **any** target (a last-child done can finish the whole plan).
- PROMPT.md — drop the "on you" language; document auto-promote/cascade in
  one line (net fewer model tool calls, slightly fewer prompt tokens).
- Tests: store cascade suite + two handler integration cases.

## Non-goals

- Cascading `canceled` / `todo` / `doing`.
- Depth > 2 (still refused).
- Migrating historical sessions with stuck-open parents (one-shot; model
  or user can `done` the parent, which now cascades, or finish the last
  child to roll up).
