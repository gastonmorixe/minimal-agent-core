---
title: "Sub-agent permission hardening: read-only roles lose Edit/Write, intercom off for workers"
status: shipped
date: 2026-06-30
author: Jack (session efbc0180)
scope:
  - plugins/sub-agents/lib/library.ts
  - plugins/sub-agents/lib/service.ts
  - plugins/sub-agents/lib/spawn-plan.ts
  - plugins/sub-agents/lib/handler-deps.ts
  - plugins/sub-agents/lib/library.test.ts
  - plugins/sub-agents/lib/service.test.ts
  - plugins/sub-agents/lib/spawn-plan.test.ts
tags: [sub-agents, security, permissions, modes, intercom]
---

# Sub-agent permission hardening

## Symptom (what triggered this)

A `planner` sub-agent, spawned for a READ-ONLY research task, was observed with
its last tool call being `Edit`, and it had used the `intercom` tools to
broadcast messages to other top-level sessions (real, human-driven peers). Two
distinct bugs:

1. A "read-only" specialist could edit files. "Read-only" was only a sentence
   in the worker's system prompt, never enforced.
2. A worker could reach the peer-to-peer intercom mesh and message sessions it
   has no business contacting.

Both are privilege bugs: a leaf worker had strictly more authority than its role
implied.

## Root cause

### Edit access

`plugins/sub-agents/lib/service.ts` hardcoded the operating mode for EVERY
spawned worker:

```ts
mode: "none",   // <- every worker, regardless of role
```

`mode: "none"` means "no operating mode active" = unrestricted tool access.
Non-interactive agent sessions actually default to `ask` mode
(`src/non-interactive-defaults.ts:99`, `resolveInitialModeId` returns `"ask"`
when a prompt is passed), and `ask` mode denies `Edit`/`Write` at dispatch
(`plugins/ask-mode/manifest.json`: `permissions.deny = ["Edit","Write"]`). But
the sub-agent spawner passed `--mode none` explicitly, OVERRIDING that safe
default for all workers. So the read-only roles (explorer, planner, reviewer,
log-miner) booted writable.

The role system already carried the intent (each read-only specialist's prompt
says "read-only", "never edit"), but nothing enforced it. Prompts are not a
security boundary.

### Intercom access

The intercom plugin (`id: intercom`) is discovered and activated for every
session, including spawned workers. There was no seam telling a worker "you are
a leaf, stay off the peer mesh". Workers inherit the full plugin set of a normal
session.

## The fix

Two independent, minimal changes, each reusing an existing mechanism rather than
inventing a parallel one.

### 1. Read-only roles run in `ask` mode (defense in depth)

- Added an optional `mode?: string` field to `WorkerDefinition`
  (`service.ts`). It documents that read-only specialists set `"ask"` and
  implementers leave it unset.
- The four read-only specialists in `library.ts` (`explorer`, `planner`,
  `reviewer`, `log-miner`) now declare `mode: "ask"`. `worker` and `integrator`
  leave it unset.
- `library.ts`'s `withClause` passes `mode` through when composing the shipped
  library.
- `service.ts` replaced the hardcoded `mode: "none"` with
  `mode: def?.mode ?? "none"`: a definition's mode wins, else the writable
  default for implementers and inline workers.

This reuses the existing, tested mode-permission system. A drifting read-only
worker that calls `Edit` is now refused at dispatch by the same gate that powers
interactive ASK mode, not merely discouraged by its prompt.

### 2. Intercom disabled for every worker

- `spawn-plan.ts` gained `SUBAGENT_DISABLED_PLUGINS = ["intercom"]` and a pure
  `mergeDisabledPlugins(inherited)` helper that unions the lead's own
  `MINIMAL_AGENT_DISABLE_PLUGINS` value with the worker-only set, deduped and
  order-stable.
- `buildSpawnPlan` stamps `MINIMAL_AGENT_DISABLE_PLUGINS` into the child env
  (spread LAST so an `extraEnv` entry can't clobber the contract). The agent
  boot already consumes that env var via `resolvePluginEnabledOverrides`
  (`src/plugin-enable-resolution.ts`), so the worker simply never activates
  intercom.
- `service.ts` / `handler-deps.ts` thread the lead's existing disable list
  (`ctx.env.MINIMAL_AGENT_DISABLE_PLUGINS`) into the plan as
  `inheritedDisabledPlugins`, so a user's own disables are preserved, not
  dropped.

This reuses the existing plugin enable/disable seam. Workers coordinate through
the in-fleet `SubAgentsMailbox` (intended for spawned workers); intercom stays
reserved for top-level peer sessions.

## Why this layer

- Mode permissions are already the dispatch-time tool gate
  (`src/modes.ts`, `ModeManager.isToolAllowed`). Putting role-based read-only
  enforcement there means one tested code path, not a second allow-list.
- The plugin-disable env is already the supported way to turn a plugin off per
  process. Disabling intercom for workers needs no core change, just the right
  env on the spawned child.
- Both changes are data/config on the spawn, keeping the worker process itself
  identical to a normal agent (no special "worker mode" branch to maintain).

## Caveats / follow-ups

- `ask` mode denies only `Edit` and `Write`. It does NOT deny `Bash`, so a
  read-only worker could still mutate the tree via `bash -c '... > file'`. If
  full read-only enforcement is wanted, add a stricter mode (e.g. `readonly`)
  that also denies `Bash` writes, or a Bash predicate. Out of scope here; this
  change closes the direct Edit/Write hole the incident exposed.
- Mode is referenced by id; an unknown id is a silent no-op (worker runs
  unrestricted). The ids used here (`ask`) ship in `plugins/ask-mode`, so they
  resolve. A future role referencing a non-shipped mode would silently fail
  open: worth a startup assert if more roles adopt modes.
- Inline workers (no named definition) default to writable (`none`), matching
  prior behavior for the general-purpose `worker`. Only the named read-only
  specialists are locked down.

## Verification

- `bun test plugins/sub-agents`: 240 pass / 0 fail.
- New tests:
  - `library.test.ts`: read-only specialists carry `mode: "ask"`; implementers
    do not.
  - `service.test.ts`: a read-only definition launches with `--mode ask`; an
    implementer and an inline worker launch with `--mode none`.
  - `spawn-plan.test.ts`: `mergeDisabledPlugins` unions/dedups correctly; every
    worker's env disables `intercom`; the disable contract survives an `extraEnv`
    collision.
- Full gate: see the accompanying provider/Sonnet-5 change; `bun run check`
  green across the touched plugins.
