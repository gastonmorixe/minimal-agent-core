# Agent transport canonicalization (multi-provider dispatch)

**Date:** 2026-05-28 · **Branch:** `dev-private`

## What this does

The agent loop now dispatches each request to the provider that owns the
model. Before this, `Agent.send`/`Agent.run` always went through the
legacy Anthropic-only `client.ts` `sendMessage`, so `--model gpt-5.5` was
listed and registered but, at runtime, would have hit `api.anthropic.com`.
Now a model resolved to OpenAI reaches `api.openai.com`, OpenRouter reaches
`openrouter.ai`, and Anthropic stays exactly where it was.

The change is staged to be near-zero-risk: **Anthropic keeps the legacy
transport untouched**, and only non-Anthropic models route through the new
canonical path.

## How it works

A new default `Agent.sendFn` (`selectedTransport`, in
`src/llm/transport/select-transport.ts`) picks the transport per request by
the model's registered `providerId`:

- **Anthropic** → legacy `client.ts` `sendMessage` (its battle-tested
  retry / stream-watchdog / 401-keychain-race infra, unchanged).
- **everything else** → `canonicalSendFn`, which routes through the
  canonical `run()` orchestrator and the provider plugins.

Reversible via `MINIMAL_AGENT_CANONICAL_TRANSPORT`:

| value | behavior |
| --- | --- |
| unset / `auto` | provider-conditional (the default above) |
| `all` | every model (incl. Anthropic) through the canonical path |
| `off` | every model through legacy `sendMessage` (emergency revert) |

### Authentication (per-provider)

The host has ONE session credential: the Anthropic OAuth login. It must
never be sent to another vendor. `canonicalSendFn` resolves the credential
by the model's registered `providerId` (`resolveProviderAuth`):

| provider | credential |
| --- | --- |
| `anthropic` | the OAuth session (keeps the keychain-first / peer-token 401 recovery) |
| `openai` | `OPENAI_API_KEY` |
| `openrouter` | `OPENROUTER_KEY` |

If the required env var is missing, the transport throws a clear error
naming the variable and never hits the network: there is no silent
fallback to the Anthropic token. So **to use `--model gpt-5.5` you must
export `OPENAI_API_KEY`** (and `OPENROUTER_KEY` for OpenRouter models).

### The canonical transport

`canonicalSendFn` is signature-compatible with `sendMessage`
(`(SendOptions) => AsyncGenerator<string, StreamedResponse>`) so it is a
drop-in behind the existing `sendFn` seam. Internally it is an onion of
provider-neutral middleware wrapping `run()`:

```
withRetry( withAuthRefresh( withStreamWatchdog( run() ) -> bridge ) )
```

- `src/llm/transport/watchdog.ts` : idle / hard-timeout / truncation guard
  over one attempt's canonical event stream, throwing errors tagged with
  the same `streamErrorType` strings as the legacy client
  (`stream_idle` / `attempt_too_long` / `stream_truncated`).
- `src/llm/transport/auth-refresh.ts` : 401 recovery via
  `ProviderAuth.refresh`, with keychain-first peer-token adoption (the
  multi-process refresh-token rotation race fix) injected as a hook so the
  middleware stays provider-neutral.
- `src/llm/transport/retry.ts` : the retry coordinator. Same fast/slow
  curves, capped full-jitter backoff, sustained-retry heartbeat, visible
  `↳ stream stalled` marker, and `api.retry*` diag as `sendMessage`.
  Unbounded by design (the harness principle): retries forever, capped
  backoff, user-abortable via `signal`.
- the bridge (`adapter-legacy.ts`) translates canonical events back to the
  legacy `(yield string, return StreamedResponse)` + lifecycle callbacks
  (`onThinking*`, `onTextStop`) + a usage hook wired to `addSessionUsage` +
  `rebroadcastQuotaForSessionUpdate` (the same buses the legacy client
  feeds). The network activity observer needs no wiring: the canonical path
  reuses the same `NetworkClient`.

`client.ts` is not modified. The retry/watchdog constants are duplicated in
the transport modules (rather than exported from `client.ts`) to honor the
"do not touch the legacy retry/watchdog/401 infra" constraint; the Phase-0
characterization tests (legacy) plus the transport unit tests (canonical)
guard against drift.

## Why `canonicalSendFn` can be trusted

- **Byte-identical happy path.** A representative thinking → text →
  tool_use response produces the exact same text-channel yields, lifecycle
  callback order, and `StreamedResponse` through `canonicalSendFn` as
  through the legacy `sendMessage` (pinned by a Phase-0 golden and the
  canonical equivalence test).
- **Real-wire parity.** The full canonical stack consumes the real
  2026-05-28 Opus 4.8 capture (`conversation-opus48.res-body.sse`)
  end-to-end and hits `api.anthropic.com`.
- **Resilience wired end-to-end.** A truncated stream trips the watchdog
  and recovers via retry, proven through `canonicalSendFn`.
- **The payoff, proven through the agent.** A real `Agent.run` turn with
  `--model gpt-5.5` (no injected `sendFn`) lands on
  `https://api.openai.com/v1/responses` authenticated with `OPENAI_API_KEY`,
  NOT the Anthropic session token (asserted against a sentinel); a missing
  `OPENAI_API_KEY` throws a clear error and never reaches the network; an
  Anthropic model still lands on `api.anthropic.com` with the OAuth session.

## Also in this batch

- **Surface column** in `--list-models` / `providers models`, with dynamic
  column widths so long ids/names and `openai-chat-completions` align.
- **Surface rename** `openai-chat` → `openai-chat-completions` (names the
  real Chat Completions API and parallels `openai-responses`; the bare
  `openai-completions` would have pointed at OpenAI's deprecated
  `/v1/completions`).
- **Decoupling (design-patterns audit).** The Anthropic `/bootstrap`
  startup probe moved out of `src/index.ts main()` into a
  `ProviderPlugin.onStartupProbe` lifecycle hook, so the entrypoint names
  no provider (DIP / OCP). `main()` now iterates `listProviderPlugins()`.

## Deferred (documented, not done)

- **Anthropic on canonical by default.** Currently `auto` keeps Anthropic
  on legacy. Flip to canonical-for-all after the canonical path bakes in
  production for OpenAI. The `all` mode + the gated live e2e exist to
  exercise it now.
- **Canonical rate-limit header broadcast.** `broadcastResponseRateLimits`
  reads Anthropic response headers, which canonical events do not carry;
  the legacy path still owns the footer's rate-limit segment.
- **OpenRouter shared wire codec.** `llm-openrouter` reuses
  `llm-openai`'s wire layer (DRY, plugin-to-plugin). Extracting a shared
  `openai-chat-completions` codec is deferred until a third
  OpenAI-compatible vendor exists (YAGNI on n=2).
