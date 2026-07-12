---
project: "Terminal-less Grok Responses stream recovery"
title: "Never-give-up terminal-less recovery + thinking-aware stream idle"
type: fix
status: shipped
working-dir: "/Users/gaston/Projects/minimal-agent"
created-at: "2026-07-12T13:34:39-0400"
updated-at: "2026-07-12T16:40:00-0400"
commits:
  - id: "15c295c"
    summary: "salvage complete tools; never re-POST after completed tools"
  - id: "cbcf119"
    summary: "partial-text salvage + one local agent continuation"
  - id: "dc020a2"
    summary: "thinking-aware idle + forever pre-effect terminal-less retry"
  - id: "d8d1c40"
    summary: "docs(changelog) Unreleased entry"
incidents:
  - session: "523dba62-9dec-4cfe-938d-0955f882ef9a"
    class: "post-tool unlimited slow-curve body replay"
  - session: "113921b7-a4a6-4624-863f-e2b4e0fddb69"
    class: "reasoning-only ~33s idle → failTurn hard stop"
agents:
  - id: "ba7cd4f2"
    role: "lead investigator and reviewer"
  - id: "97596567"
    role: "implementer (Steven) — post-tool salvage"
  - id: "ce0e0589"
    role: "finisher — 15c295c"
  - id: "842604fe"
    role: "partial-text salvage — cbcf119"
  - id: "f61fc420"
    role: "thinking-idle + never-give-up policy (Adrian)"
  - id: "106c4c8c"
    role: "finisher — typecheck + dc020a2"
related:
  - "private/retry-fix/PROGRESS.md"
  - "private/retry-fix/PLAN.md"
  - "docs/CHANGELOG.md"
scope:
  - "src/llm/transport/watchdog.ts"
  - "src/llm/transport/attempt-progress.ts"
  - "src/llm/transport/retry.ts"
  - "src/llm/adapter-legacy.ts"
  - "src/agent/agent.ts"
  - "src/sdk/agent-core.ts"
---

# Never-give-up terminal-less recovery + thinking-aware stream idle

**Status:** shipped (`dc020a2` on `dev-private`; restart agent to pick up binary)  
**Type:** fix (transport / retry / Grok · OpenAI Responses)  
**Research log:** [`private/retry-fix/PROGRESS.md`](../../private/retry-fix/PROGRESS.md)

## Problem

Grok high-effort reasoning streams that paused more than ~30s mid-think were
idle-aborted by the provider-neutral watchdog, then mis-tagged as
`stream_closed_without_terminal` when the aborted body drained without a
terminal SSE event. After `15c295c` / `cbcf119`, pre-effect closes still took
**one** near-zero transport retry and **`failTurn`**, hard-stopping the agent
with:

```text
error OpenAI Responses stream closed without a terminal event (truncated)
```

Live shape (session `113921b7`): ~33s elapsed, `saw-reasoning: true`,
`completedToolCalls: 0`, `delay-ms: 48`, then `api.retry-terminal-less-stop`
failTurn. That violated the harness principle that multi-day agentic runs must
outlive transient transport EOF without a human re-prompt.

Earlier incident class (session `523dba62`): unlimited 30s-curve **identical
body** replay after completed tools — fixed in `15c295c` (must not regress).

## What shipped

### Watchdog (`src/llm/transport/watchdog.ts`)

- While a thinking/reasoning block is open, idle budget is **5 minutes**
  (`DEFAULT_THINKING_IDLE_TIMEOUT_MS`), not the ordinary 30s
  `streamIdleTimeoutMs`. After `thinking_stop`, ordinary idle applies again.
- If the watchdog has already set an abort reason (`stream_idle` /
  `attempt_too_long`), it **throws that tagged error and does not yield** further
  events — synthetic adapter `stream_closed_without_terminal` on quiet drain
  cannot replace a real idle classification. Idle stalls stay on the forever
  **fast** retry curve.

### Pre-effect terminal-less policy (`attempt-progress.ts` + `retry.ts`)

- **No completed tools** (empty or mid-reasoning / mid-stream with no closed
  tool_use): retry **forever** with polite capped exponential backoff (max
  5 min). Empty closes use a short base; midstream (saw reasoning or text)
  uses a multi-second base with a **≥1s floor** so the first retry cannot
  collapse to `after 0.0s` thrash. Only AbortSignal (Esc) stops the loop —
  no `failTurn` budget.
- **≥1 completed tool**: still **never re-POST** the same request body
  (`continueTurn` / bridge salvage). Side-effect safety boundary from `15c295c`.
- Partial-text salvage and one local agent continuation from `cbcf119` are
  unchanged (bridge returns `end_turn` with preserved text when `sawText`
  without throwing into `withRetry`).

Diag curves: `terminal-less-empty` and `terminal-less-midstream` (replacing
one-shot `terminal-less-bounded` + pre-effect `api.retry-terminal-less-stop`
fail path).

### Commits

| Commit | Role |
| --- | --- |
| `15c295c` | Post-tool salvage; remove terminal-less from slow forever curve |
| `cbcf119` | Mid-text salvage + `MAX_INTERRUPTED_TURN_CONTINUATIONS=1` |
| `dc020a2` | Thinking-aware idle + forever pre-effect retry |
| `d8d1c40` | CHANGELOG Unreleased note |

## Tests

```text
bun test \
  src/llm/transport/attempt-progress.test.ts \
  src/llm/transport/retry.test.ts \
  src/llm/transport/watchdog.test.ts \
  src/llm/transport/terminal-less-recovery.integration.test.ts \
  src/llm/adapter-legacy-salvage.test.ts \
  src/agent/agent.stream-interrupted.test.ts
# green (targeted matrix ~68 pass)
bun run typecheck  # exit 0 at ship (106c4c8c)
```

## Do not regress

- Reintroduce `failTurn` after N pre-effect terminal-less retries
- Put `stream_closed_without_terminal` back on slow forever when tools completed
- Claim `freshConnection` / H2 origin eviction works (always `false`)
