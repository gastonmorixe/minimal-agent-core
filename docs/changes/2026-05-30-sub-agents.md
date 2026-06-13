# Sub-agents (delegation) — 2026-05-30

A new embedded plugin, `plugins/sub-agents/`, plus four small generic core
seams. It lets the lead agent spawn background `minimal-agent` workers, steer
them, review their work, and fold results back, without the agent core ever
learning the word "sub-agent". Full research + design lives in
`private/subagent-research-and-plan/` (`README.md`, `DESIGN.md`, `TUI.md`,
`PLAN.md`, `research/`).

## What shipped

### The mental model

> A sub-agent is a backgrounded `minimal-agent` process with its own session
> id, addressed by a handle, supervised by a heartbeat, surfaced as a task.

A worker is a real headless agent (`minimal-agent --session-id <uuid> --mode
none --no-header --prompt …`). It runs concurrently; the lead gets an immediate
handle. A 1-second `liveAreaSlot` supervisor reaps exits, paints a live fleet
widget, and injects each finished worker's distilled result between turns via
the existing `prompt.inject` port. The lead reads a worker's deliverable on
demand. Worker verbosity stays in the worker's own context; only bounded
summaries cross back (the "filesystem artifact" result-sentinel pattern).

### Model-facing tools

Seven: `SpawnAgent` (delegate, returns a handle immediately), `ListAgents`,
`AgentStatus`, `AgentOutput` (tail a worker's live activity), `AgentResult`
(pull the distilled deliverable), `Mailbox` (sibling coordination), `StopAgent`.
Plus a 1s `fleet_supervisor` live-area slot and a per-turn `<ma::agent::subagents>`
digest. Five built-in specialists: `explorer`, `planner`, `worker`, `reviewer`,
`integrator`. Disable with `MINIMAL_AGENT_DISABLE_SUBAGENTS=1`.

### Collaboration + live state

- **Live progress.** The supervisor reads each running worker's own transcript
  to show real tool count / billed tokens / current activity in the widget and
  the per-turn digest (not zeros).
- **Tasks linkage.** `SpawnAgent({taskId})` links a worker to a Task-tool todo;
  when the worker finishes the todo is ticked `done` (or `canceled` with a
  reason on failure), via a `subagent.taskUpdate` bus event the `tasks` plugin
  subscribes to. The two plugins never import each other; they meet on the bus.
- **Sibling mailbox.** A shared, durable, opt-in board (`Mailbox` post/read) so
  parallel workers can claim files / flag blockers without clobbering.
- **Isolation tiers.** `fresh` (clean context) and `fork` (inherit the lead's
  conversation + share its prompt cache) — fork rides `--resume <leadSid>
  --session-id <childSid>`, so the agent's own resume path forks the lead's
  history into the child with no extra core machinery.

### Guardrails

Self-enforced caps (the `subagent.willSpawn` chain channel is the external-veto
seam): a nesting ban (workers can't spawn workers, via a depth env marker), a
concurrency cap, a total-spawn cap, an optional type allowlist, and per-worker
budgets (turns / deadline). The lead owns git and the full gate; workers default
to no-commit + targeted tests.

## Core seams added (all generic, sub-agent-agnostic)

1. **`--session-id <uuid>`** (`src/metadata.ts`, `src/index.ts`): pin a run's
   session id so a supervising parent knows a child's sid up front. Deliberately
   does NOT auto-adopt the ambient `MINIMAL_AGENT_SESSION_ID` env var (it leaks
   into every spawned child and would collide session files); the explicit flag
   is the only seed.
2. **Generic per-turn attachment registry** (`src/agent.ts`, `src/index.ts`):
   a `turnAttachments: Array<{toAttachment()}>` extension point, injected after
   the named tasks/short-term producers. The sub-agents fleet digest rides it;
   the agent core stays agnostic.
3. **Multi-row live-area slots** (`src/ui/status/live-area-scheduler.ts`): a slot value is
   split on `\n`, so one slot can paint N rows (the fleet widget). Single-line
   slots are unaffected.
4. **`subagent.*` hook channels** (`src/plugins/hooks/channels.ts`):
   `willSpawn` (chain), `didSpawn` / `didReport` / `didExit` (broadcast). The
   core emits none of them; a delegation plugin does.

## Architecture (per the design-patterns review)

Functional core + imperative shell, the same split `tasks`/`schedule` use. The
supervisor is a pure reducer `(fleet, probes, now) → (fleet', effects[])`; all
OS interaction (`Bun.spawn`, pid liveness, sentinel read) is injected so the
logic is unit-testable without launching a process. Discriminated-union worker
status (illegal states unrepresentable), `Result` for fallible ops, branded ids,
a Repository store, a Strategy for isolation tiers, a Service Layer orchestrator.

## Tests

36 files, ~2300 LOC source, ~80 tests: the whole pure core (types, store,
spawn-plan, guard, supervisor, render, widget, attachment, service), a load test
(registers cleanly with no warnings), and an end-to-end integration test that
spawns a REAL child process (a fake worker writing a result sentinel) and proves
the spawn → run → reap → done → report loop with no network. `bun run check`
green at 4165 pass / 0 fail.

## Scale + presence (Phase 7)

- **Configurable caps** for fleets at the extreme: `MINIMAL_AGENT_SUBAGENT_MAX_CONCURRENT`
  (8), `_MAX_TOTAL` (64), `_MAX_DEPTH` (1, the nesting ban), `_TOKEN_BUDGET`
  (200k, the widget's GOLD cost line), `_MODEL` (default worker model).
- **Presence mesh.** The lead's supervisor publishes per-lead presence files
  under `~/.minimal-agent/presence/<leadSid>.jsonl` (a row for itself + each
  worker) every tick; a pure reader merges the directory (latest row per sid)
  and derives liveness. Realizes the reserved `presence.jsonl` agent-mesh
  without core lifecycle hooks (which aren't emitted yet) and covers headless
  workers (their lead reports them). Opt out with `MINIMAL_AGENT_SUBAGENT_NO_PRESENCE=1`.
- **Perf.** The supervisor re-parses a worker's transcript only when its mtime
  changed, so a 100-worker fleet polled every second doesn't re-parse 100 idle
  files per tick.

## Cut / deferred

- **`SendAgent` (push-to-worker): cut.** A pushed message only helps if the
  worker polls its inbox, and a headless `--prompt` worker doesn't. Functional
  steering is `StopAgent` + a corrected `SpawnAgent`. Revisit with a worker-side
  inbox watcher.
- **Core lifecycle emits** (`agent.didStart` / `turn.didEnd` / `agent.willStop`)
  are declared but not emitted; wiring them would let presence be produced by
  each agent independently (and unlocks other lifecycle plugins). Left for a
  separate, generic core change.
