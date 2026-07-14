# Context auto-compact (OpenAI/Codex remote + local fallback)

Date: 2026-07-14
Status: applied (second cut: menu + durable compact + Codex auth fix)

## Problem

Long OpenAI/Codex OAuth sessions full-resend history every turn (`store:false`).
When the transcript exceeds the model window the API returns
`context_length_exceeded`. minimal-agent only rolled the user turn back and
printed advice ("compact / prune / fresh session") with no actual compact path.

## What shipped

### Provider contract

- Optional `ProviderAdapter.compact?` on host (`src/llm/provider.ts`) and
  plugin-api (`ProviderAdapterView`).
- OpenAI implements it via unary `POST /v1/responses/compact` (API key) or
  `POST {chatgpt.com/backend-api/codex}/responses/compact` (OAuth).

### Shared runner (legacy Agent + AgentCore)

- Pure helpers: `src/agent/context-compact.ts`
- Imperative runner: `src/agent/run-compact.ts` (prefer remote, local prune
  fallback). Remote auth is resolved via `resolveStoredProviderAuth` so
  ChatGPT-Codex `baseUrl` + plan headers are preserved (not stripped
  TokenAuthResult).
- Both `Agent.compact` / `Agent.replaceMessages` and
  `AgentCore.compact` / `AgentCore.replaceMessages` call the same runner.
- Local fallback records `remoteError` on stats so `/compact` can show why.

### Host UX

- `/compact` registered as a **host command** in CommandRegistry
  (`src/host/commands/compact.ts` + `registerHostCommand`) so slash-menu
  fuzzy match (`/com`) works. Bound after Agent construction in `src/index.ts`.
- On `context_length_exceeded`: auto-compact once + re-queue pending user text
  (`src/host/context-exceeded-recovery.ts`)
- Disable with `MINIMAL_AGENT_AUTO_COMPACT=0`

### Durable compact (no history delete)

- Session JSONL appends `kind: "compact"` via `SessionStore.appendCompact`
  (replacementMessages + stats). Prior user/assistant/tool_result rows stay.
- `foldRecordsForDisplay` = full transcript (UI / `--resume` replay).
- `foldRecordsForModel(policy)` default `since-last-compact` for model path.
  Policies: `full`, `ignore-last-n`.
- `loadSessionFromText` loads **model** fold by default; callers that need UI
  fidelity use `foldRecordsForDisplay(loaded.records)`.

### Codex auth fix

- `providerAuthToAuthResult` keeps oauth with `baseUrl`/`headers` as
  `type: "provider"` so compact and any non-canonical path do not lose the
  Codex host. Previously plan OAuth was flattened to `type: "oauth"` without
  baseUrl → compact POSTed `api.openai.com` with a plan token → 401 → silent
  local fallback (`✓ compact (local)`).

### Not in this cut

- Proactive threshold compact before send
- Local LLM summarization call (local path is prune + checkpoint stub text)
- Rehydrating encrypted compaction items as first-class Responses input items
  on the next turn (markers carry `enc=` for a follow-up)
- `previous_response_id` stateful resend (still Azure/`store:true` only)
- CLI flag to force `sendPolicy: full` after model switch (API is ready;
  flag wiring pending)

## Tests

- Core: `context-compact.test.ts`, `run-compact.test.ts`,
  `context-compact.e2e.test.ts`, `context-exceeded-recovery.test.ts`,
  `host/commands/compact.test.ts`, `plugins/commands.test.ts` (host register),
  `session-restore.compact.test.ts`, `provider-auth.compact.test.ts`
- Plugin: `responses/compact.test.ts`, `responses/compact.e2e.test.ts`

## Ops

```bash
# manual
/compact

# disable auto recovery
MINIMAL_AGENT_AUTO_COMPACT=0
```

Restart the agent binary after pulling this tree so CommandRegistry +
Codex auth fix are live. If you still see `compact (local)`, the notice now
prints `remote unavailable: …` with the HTTP/auth error.
