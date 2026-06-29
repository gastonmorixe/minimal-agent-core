# OpenAI Responses: response-id capture + previous_response_id store guard

Date: 2026-06-28
Author: Nancy (session fee2204b), continuing Mariana's (6e980f91) investigation
Status: applied (foundation + defensive guard); stateful resend deliberately out of scope

## Incident

Session 870bda04 (John) ran `--provider openai --model gpt-5.5 --effort xhigh` on
the `openai-responses` surface under ChatGPT-Codex OAuth. Net logs showed every
request resending the full transcript with no `previous_response_id`, input
growing monotonically until `context_length_exceeded`.

Net-debug proof (52 requests, one dir):

- endpoint `https://chatgpt.com/backend-api/codex/responses`, `ChatGPT-Account-ID`
  header, Bearer token => OAuth/Codex path.
- every body: `store: false`, `previous_response_id` ABSENT, `reasoning.effort: xhigh`.
- `input` array grew 197 -> 345 items, body 654 KB -> 1.10 MB across the run.

## Root cause

`previous_response_id` stateful mode was dead code end-to-end:

1. `response.id` IS emitted by the stream translator as `message_start.messageId`
   (`plugins/llm-openai/responses/response-stream.ts`).
2. It was DROPPED at the canonical->legacy bridge: `StreamedResponse` had no field
   for it, and `canonicalEventsToLegacyStream` read `message_start` only for
   usage/status. The id never reached the agent.
3. The agent loop (`src/agent.ts`) is append-only full-resend by design and never
   reads a prior id or sets `CanonicalRequest.previousResponseId`.
4. `previousResponseId` was therefore never assigned in production (only in two
   test files). `request-body.ts` maps it and `validate.ts` gates it, but nothing
   upstream populated it.
5. OAuth makes it doubly impossible: the adapter forces `store: false`, and
   `previous_response_id` requires `store: true` server-side.

Full-resend is the intended cross-provider architecture (Anthropic behaves
identically). So this was an UNFINISHED optimization that LOOKED wired, not a
regression.

## Why a full stateful-resend fix was NOT done here

- The reported session is OAuth/`store:false`. `previous_response_id` cannot work
  there at all, so wiring it would not have fixed the incident.
- Closing the loop (delta-resend keyed off the response id) is a large, risky
  change to the core append-only agent loop, only viable on `store:true` (API-key)
  requests, and demands history-invalidation discipline (any compaction, fork,
  preflight repair, or edit must clear the pointer or the server chain desyncs).
  That belongs in its own change with its own test plan, not bolted on under an
  incident.

## What this change does

1. Capture the response id instead of dropping it.
   - `src/llm/transport/types.ts`: add `StreamedResponse.responseId?: string`.
   - `src/llm/adapter-legacy.ts`: `canonicalEventsToLegacyStream` records
     `message_start.messageId` and returns it on `responseId`.
   This is the missing foundation a future stateful-resend implementation needs,
   and the assertion whose absence let the bug hide.

2. Defensive invariant guard in the adapter.
   - `plugins/llm-openai/adapter.ts`: on the Responses surface, if
     `body.store !== true` and `previous_response_id` is set, strip it (with a
     debug note). Covers OAuth (`store:false` forced) and the default-`store:false`
     API-key path. Prevents shipping a request that would 400 / silently desync.

The agent loop is unchanged: it still sends full history every turn. No behavior
change for any current user; the only observable difference is that a stray
`previous_response_id` (which nothing sets today) can no longer ride a
`store:false` request.

## Confirmed against the real Codex source (Eric, session 0066e1d9)

Eric traced OpenAI's own `codex-rs` client. It confirms the `store` behavior from
the authoritative source, removing the earlier "inferred from our adapter" caveat:

```rust
// codex-rs/core/src/client.rs:883
store: provider.is_azure_responses_endpoint(),
```

`store` is `true` ONLY for Azure OpenAI endpoints. For BOTH the ChatGPT backend
(OAuth) AND the public `api.openai.com` API-key path, the reference client sends
`store: false`. So in OpenAI's real-world design, `previous_response_id` stateful
mode is effectively Azure-only, not "API-key in general". Other relevant facts
from his trace:

- Only one wire surface exists in current Codex: the Responses API. Chat
  Completions was removed (`WireApi` has a single `Responses` variant).
- Base URL split: Codex-backend auth (Chatgpt / ChatgptAuthTokens / AgentIdentity
  / PersonalAccessToken) -> `chatgpt.com/backend-api/codex`; ApiKey / Bedrock ->
  `api.openai.com/v1`. Both POST `<base>/responses`.
- ChatGPT OAuth may upgrade to an Agent Identity (`AgentAssertion` JWT) after a
  first-turn bootstrap, falling back to `Bearer` on failure. Doesn't change the
  `store` story.

## Tests

- `src/llm/adapter-legacy-usage.test.ts`: `responseId` is surfaced from
  `message_start`; undefined when no id present.
- `plugins/llm-openai/openai.test.ts` (request routing): `previous_response_id`
  dropped on OAuth/`store:false`; dropped on default API-key `store:false`; KEPT
  when `vendor.openai.store=true` (proves the legitimate stateful path still works).

Verification: `bun test plugins/llm-openai/openai.test.ts src/llm/adapter-legacy-usage.test.ts`
=> 46 pass. `bun test src/llm/` => 179 pass / 1 skip. `bun run typecheck` => exit 0.
`oxlint` touched files => 0 warnings / 0 errors.

## Follow-up (not done)

Reality check first (per Eric's `codex-rs` trace): `store:true` only happens on
Azure endpoints in the reference client. So `previous_response_id` stateful resend
is an Azure-only optimization in practice, NOT something the common API-key or
OAuth user gets. Weigh that before investing in it.

If server-side history is wanted (Azure `store:true`, or a deliberate opt-in via
`vendor.openai.store=true`):

- Thread `responseId` from `StreamedResponse` into the agent, store it per turn.
- On the next send, set `previousResponseId` AND send only delta messages
  (new tool_results + new user turn) instead of full history.
- Gate on `store===true` (the only state where the server kept the prior turn).
  In the reference client that means Azure; we additionally expose
  `vendor.openai.store` as an explicit opt-in. Do NOT gate on `auth.kind` alone:
  API-key does NOT imply `store:true`.
- Clear the stored id on ANY history mutation (compaction, fork, preflight repair,
  edit) to avoid desyncing the server chain.
- For the common `store:false` cases (OAuth/ChatGPT backend AND plain API-key),
  `previous_response_id` is unavailable. The only token win there is keeping
  encrypted reasoning across turns via `include:["reasoning.encrypted_content"]`,
  not `previous_response_id`.
