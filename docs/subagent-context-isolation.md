# Sub-agent context isolation

Sub-agents do **not** share the lead's conversation context by default. Each worker is a separate `minimal-agent` process with its own session id and context window. The lead picks isolation per spawn via `SubAgentsSpawnAgent`.

## Who decides

The **lead** chooses isolation in the spawn tool call. The worker cannot pick its own isolation mode.

```text
SubAgentsSpawnAgent({
  task: "...",
  agent: "explorer",   // or system: "..."
  isolation: "fresh",  // or "fork"; omit for default
})
```

Other per-spawn knobs the lead also owns: `agent` / `system`, `model`, `effort`, `label`, `taskId`, `expectArtifacts`, `budget`.

## Isolation tiers

| Mode | Default? | Worker context | Implementation |
|------|----------|----------------|----------------|
| **`fresh`** | yes | Clean context: task + worker system prompt (+ result protocol) only | New session, pinned with `--session-id <childSid>` |
| **`fork`** | no | Inherits the lead's full conversation history; shares the lead's prompt cache | Child launched with `--resume <leadSid> --session-id <childSid>` |

### `fresh` (default)

Use for almost all delegation. The worker only knows what you put in `task` (and its specialist/`system` preamble). That keeps verbose work out of your context and forces a self-contained brief.

Best for:

- codebase search / exploration
- independent implementation units with a clear file allowlist
- log mining, test runs, doc fetches
- any unit where re-explaining the background is cheaper than shipping the whole transcript

### `fork`

Use when the side task needs conversation background you do not want to restate: prior decisions, long design threads, or a handoff that depends on earlier turns.

Trade-offs:

- larger worker context (and cost) from the first turn
- worker sees the lead history, including noise and intermediate wrong turns
- still a separate process and session; it does not write back into the lead transcript mid-run

## What is shared vs not

Regardless of isolation:

| Shared | Not shared (by default) |
|--------|-------------------------|
| Machine, cwd (unless scratch workspace), files on disk | Lead transcript (`fresh`) |
| Tools available to that worker's role/mode | Lead's in-context reasoning / token budget |
| Optional fleet **mailbox** (`SubAgentsMailbox`) | Automatic live sync of the worker's full tool transcript back into the lead |
| Optional linked Task id (`taskId`) | Nesting: workers cannot spawn workers |

What comes back to the lead:

1. Between-turn fleet digests (status one-liners)
2. On demand: `SubAgentsAgentResult` — the **bounded** distilled deliverable (not the full worker transcript)
3. Optionally: `SubAgentsAgentOutput` / status for activity tails

Worker verbosity stays in the worker session. Only summaries and artifact paths cross back.

## Mental model

> A sub-agent is a backgrounded `minimal-agent` process with its own session id, addressed by a handle, supervised by a heartbeat.

- **`fresh`**: compress context; put everything the worker needs in `task`.
- **`fork`**: share history when the brief would otherwise be huge or lossy.
- Either way, the lead plans, reviews, owns git/gate; the worker executes one unit.

## Related docs

- Plugin lead prompt (runtime guidance): `ma-sub-agents-plugin/PROMPT.md` (sibling plugins repo)
- Ship notes: [docs/changes/2026-05-30-sub-agents.md](./changes/2026-05-30-sub-agents.md)
- Model inheritance: [docs/changes/2026-06-04-subagent-model-inheritance.md](./changes/2026-06-04-subagent-model-inheritance.md)
- Manager playbook (manual orchestration patterns): [docs/sub-agents-prompt.md](./sub-agents-prompt.md)
- Permission / intercom hardening: [docs/2026-06-30-190307-subagent-permission-hardening.md](./2026-06-30-190307-subagent-permission-hardening.md)
