/**
 * Provider-neutral transport that satisfies the legacy `Agent.sendFn`
 * contract by routing through the canonical `run()` orchestrator, wrapped
 * in the provider-neutral resilience middleware.
 *
 * Signature-compatible with `client.ts`'s `sendMessage`:
 *
 * `(opts: SendOptions) => AsyncGenerator<string, StreamedResponse>`
 *
 * so it is a drop-in for `Agent`'s injectable transport. The difference is
 * WHERE the request goes: `sendMessage` always hits Anthropic;
 * `canonicalSendFn` resolves `opts.model` through the registry and
 * dispatches to whichever provider adapter owns it. That is what makes
 * `--model gpt-5.5` reach OpenAI through the agent loop.
 *
 * # Middleware onion (Phase 2)
 *
 *   withRetry( withAuthRefresh( withStreamWatchdog( run() ) → bridge ) )
 *
 * - **watchdog** (innermost): idle / hard-timeout / truncation guard over
 *   one attempt's canonical event stream; throws tagged errors.
 * - **bridge**: canonical events → legacy shape
 *   (`yield string` / `return StreamedResponse`) + lifecycle callbacks.
 * - **auth-refresh**: on 401, keychain-first peer adoption then network
 *   refresh, retry once; provider-neutral via `ProviderAuth.refresh`.
 * - **retry** (outermost): retry tagged transient/hard errors forever with
 *   capped jittered backoff (the harness principle), user-abortable.
 *
 * The shared `authState` is mutated in place by auth-refresh so a refreshed
 * token survives across retries within a single send.
 *
 * `client.ts` is NOT touched: the legacy Anthropic path keeps its own inline
 * copies of this infrastructure.
 *
 * @module llm/transport/canonical-send
 */

import { randomUUID } from "node:crypto"

import { readCredentials } from "../../auth.ts"
import { resolveStoredProviderAuth } from "../../auth-strategies.ts"
import { debugRequestOptions } from "../../client/debug.ts"
import { diag } from "../../diagnostic-bus.ts"
import {
  defaultNetworkClient,
  NetworkClient,
  networkActivityObserver,
} from "../../network/index.ts"
import { rebroadcastQuotaForSessionUpdate } from "../../quota-broadcast.ts"
import { addSessionUsage } from "../../session-tokens.ts"
import { GLOBAL_STATUS_BUS } from "../../status.ts"
import {
  canonicalEventsToLegacyStream,
  legacyAuthToProviderAuth,
  sendOptionsToCanonical,
} from "../adapter-legacy.ts"
import type { CanonicalEvent } from "../canonical-events.ts"
import { resolveModel } from "../model-registry.ts"
import type { ProviderAuth, RunContext } from "../provider.ts"
import { run } from "../run.ts"

import { type AuthRefreshState, withAuthRefresh } from "./auth-refresh.ts"
import { withRetry } from "./retry.ts"
import type { SendOptions, StreamedResponse } from "./types.ts"
import { withStreamWatchdog } from "./watchdog.ts"

/**
 * Intercept the canonical event stream to drive the status-label lifecycle.
 *
 * The legacy `client.ts` updates the label through explicit calls after
 * each SSE-parser stage: "Waiting for response" when headers arrive, then
 * "Receiving stream" on the first data chunk. The canonical path never did
 * this, so the initial "Sending request" label persisted even once response
 * bytes were flowing in — the ↑/↓ arrow would correctly flip to ↓ but the
 * label stayed misleading.
 *
 * This wrapper fires label transitions at the corresponding canonical-event
 * boundaries:
 *
 *   - `message_start` → `"Receiving stream"` (response content has begun)
 *
 * Additional transitions ("Thinking", "Writing response") are handled by
 * the client.ts SSE parser for the legacy Anthropic path; they are not
 * reproduced here because the canonical event bridge delegates those
 * lifecycle callbacks to the caller's own hooks.
 */
async function* updateLabelsFromEvents(
  events: AsyncIterable<CanonicalEvent>,
  statusHandle: { update(label: string): void },
): AsyncGenerator<CanonicalEvent> {
  for await (const ev of events) {
    if (ev.type === "message_start") {
      statusHandle.update("Receiving stream")
    }
    yield ev
  }
}

/**
 * Resolve the credential for the request's PROVIDER, not the host's single
 * Anthropic session. This is the fix for the bug where every provider was
 * handed the Anthropic OAuth token (so gpt-5.5 reached OpenAI but 401'd):
 *
 * - anthropic  → the legacy `AuthResult` (OAuth keychain; keeps the
 *   keychain-first / peer-token 401 recovery wired in `canonicalSendFn`).
 * - openai/openrouter/etc. → minimal-agent's own provider auth store.
 * - missing credentials → THROW (no silent fallback to env/config or the
 *   Anthropic token).
 *
 * An unresolvable model id defers to the legacy credential so `run()` raises
 * its own "unknown model" error rather than this masking it (that path never
 * reaches a real non-Anthropic endpoint).
 */
function resolveProviderAuth(opts: SendOptions): ProviderAuth {
  const modelId = opts.model ?? ""
  let providerId: string | undefined = opts.selectedProviderId
  // When no provider was explicitly selected, derive it from model registry.
  if (!providerId) {
    try {
      providerId = resolveModel(modelId).providerId
    } catch {
      return legacyAuthToProviderAuth(opts.auth)
    }
  }
  switch (providerId) {
    case "anthropic":
      return legacyAuthToProviderAuth(opts.auth)
    default:
      return resolveStoredProviderAuth(providerId, modelId)
  }
}

/**
 * Stream a request through the canonical layer + resilience middleware
 * while presenting the legacy `sendMessage` surface.
 *
 * @param opts - Legacy send options (auth, messages, model, tools, callbacks…).
 * @yields Text deltas (the legacy string channel), plus retry stall markers.
 * @returns The final {@link StreamedResponse} once the stream completes.
 */
export async function* canonicalSendFn(
  opts: SendOptions,
): AsyncGenerator<string, StreamedResponse, undefined> {
  // `--debug` / `--verbose` request dump. The legacy `sendMessage` printed
  // this inline; the canonical path must do it too or `--debug` goes silent
  // for normal conversations (which all route through here post-flip).
  debugRequestOptions(opts)

  const req = sendOptionsToCanonical(opts)
  // Shared, mutable auth keyed by the model's PROVIDER (not the host's
  // Anthropic session): OpenAI/OpenRouter get their own API key, Anthropic
  // keeps the OAuth credential. auth-refresh updates `.token` in place so a
  // refreshed token is picked up by the next attempt within this send.
  const authState: AuthRefreshState = { auth: resolveProviderAuth(opts) }

  // ------------------------------------------------------------------
  // Realtime activity binding (the status-line ↑/↓ bytes infix).
  //
  // The network client's `networkActivityObserver` accumulates sent/recv
  // bytes per request and pushes them onto the bound `StatusHandle`, which
  // the status renderer reads to draw the "↑ N · ↓ N" infix on the
  // "· Thinking (3s)" line. That observer keys its trackers by the
  // request's `id` (see network/activity-observer.ts `onChunk(req)` →
  // `trackers.get(req.id)`). The LEGACY transport (client.ts) bound it by
  // pre-generating a `reqId`, calling `attach(reqId, handle)`, then firing
  // `networkClient.request({ id: reqId, ... })` so the wire request carried
  // the SAME id. When the default transport flipped to this canonical path,
  // the provider adapter (a plugin) issues `networkClient.request()` WITHOUT
  // an id, so the client auto-uuids and nothing matched the pre-attached
  // handle — the infix went empty.
  //
  // We restore the exact legacy contract with the smallest provider-neutral
  // change: pre-generate `reqId`, attach the handle, and hand the adapter a
  // thin wrapper around the real client that stamps `id: reqId` onto every
  // request that doesn't already carry one. The adapter stays untouched and
  // provider-agnostic; the id correlation happens at the client boundary,
  // using the same `NetworkRequestInput.id` field the legacy path used (no
  // new global). Retries reuse the one `reqId` across sequential attempts,
  // exactly as the legacy outer finally did. `attach()` is a documented
  // no-op when the singleton observer isn't wired into the client in play
  // (e.g. test-injected clients), so this is inert there.
  const requestStatus = GLOBAL_STATUS_BUS.create("Sending request", {
    notificationId: "network.request",
    category: "network",
  })
  const reqId = randomUUID()
  networkActivityObserver.attach(reqId, requestStatus)
  const baseClient = (opts.networkClient ?? defaultNetworkClient) as NetworkClient
  const boundClient = bindRequestId(baseClient, reqId)

  // One attempt = run() guarded by the watchdog, bridged to the legacy
  // string/StreamedResponse contract + lifecycle callbacks.
  const makeWatchdoggedAttempt = (): AsyncGenerator<string, StreamedResponse, undefined> => {
    const events = withStreamWatchdog(
      (signal) => {
        const ctx: RunContext = {
          auth: authState.auth,
          sessionId: "",
          networkClient: boundClient,
        }
        // acceptDegrade: when the adapter can offer a cheaper-but-valid
        // variant (e.g. fast-mode requested on a model with no fast tier →
        // same request without `speed`), take it instead of dying. The
        // degrade path yields a non-retryable StreamErrorEvent describing
        // the downgrade first, which the agent surfaces as a notice. This
        // matches the legacy transport's behavior for the same combos.
        return run({ ...req, signal }, { context: ctx, acceptDegrade: true })
      },
      {
        streamIdleTimeoutMs: opts.streamIdleTimeoutMs,
        attemptHardTimeoutMs: opts.attemptHardTimeoutMs,
        signal: opts.signal,
        onStall: ({ reason, idleMs, elapsedMs }) => {
          // Mirror the legacy scrollback surface so a stalled canonical
          // attempt reads identically to a stalled legacy one.
          diag.warn("api.stream-stalled", `stream ${reason}`, {
            "error-type": reason,
            "idle-ms": idleMs,
            "elapsed-ms": elapsedMs,
          })
        },
      },
    )
    const labelledEvents = updateLabelsFromEvents(events, requestStatus)
    return canonicalEventsToLegacyStream(labelledEvents, {
      onThinkingStart: opts.onThinkingStart,
      onThinkingDelta: opts.onThinkingDelta,
      onThinkingStop: opts.onThinkingStop,
      onTextStop: opts.onTextStop,
      // Usage/quota broadcast on the same buses as the legacy client:
      // record the turn's footprint and re-render the quota footer. The
      // network observer is already shared via opts.networkClient, so
      // onRequest/onResponse fire without extra wiring here. (Anthropic
      // rate-limit *header* broadcast — broadcastResponseRateLimits — needs
      // the raw response headers, which canonical events don't carry; that
      // stays on the legacy path until Phase 3 threads it through.)
    })
  }

  // auth-refresh wraps the attempt (keychain-first peer adoption is the
  // Anthropic multi-process race fix, injected as a provider-neutral hook).
  const makeAuthRefreshedAttempt = () =>
    withAuthRefresh(makeWatchdoggedAttempt, authState, {
      peerToken: () => readCredentials()?.claudeAiOauth?.accessToken,
    })

  // retry is the outermost layer: forever, capped backoff, user-abortable.
  // The status handle stays bound for the WHOLE send (across retries) and is
  // torn down in finally, mirroring the legacy client's outer try/finally.
  try {
    const finalStream = yield* withRetry(makeAuthRefreshedAttempt, { signal: opts.signal })
    if (finalStream.usage) {
      addSessionUsage({
        input_tokens: finalStream.usage.input_tokens ?? 0,
        output_tokens: finalStream.usage.output_tokens ?? 0,
        cache_read_input_tokens: finalStream.usage.cache_read_input_tokens ?? 0,
        cache_creation_input_tokens: finalStream.usage.cache_creation_input_tokens ?? 0,
      })
      rebroadcastQuotaForSessionUpdate()
    }
    return finalStream
  } finally {
    requestStatus.clear()
    networkActivityObserver.detach(reqId)
  }
}

/**
 * Wrap a {@link NetworkClient} so every `request()` it issues carries the
 * given `id` (unless the caller already supplied one). This is how the
 * canonical path correlates the provider adapter's wire request with the
 * `networkActivityObserver` tracker bound to `reqId` — the adapter never
 * sees the id, the correlation lives entirely at this client boundary.
 *
 * Returns a thin prototype-delegating shim: only `request` is overridden,
 * everything else falls through to the real client, so transport selection,
 * fallback, policies, and the observer fan-out are unchanged.
 */
function bindRequestId(client: NetworkClient, id: string): NetworkClient {
  const wrapper: NetworkClient = Object.create(client)
  wrapper.request = (input) => client.request({ id, ...input })
  return wrapper
}
