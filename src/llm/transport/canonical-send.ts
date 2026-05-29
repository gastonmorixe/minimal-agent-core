/**
 * Provider-neutral transport that satisfies the legacy `Agent.sendFn`
 * contract by routing through the canonical `run()` orchestrator, wrapped
 * in the provider-neutral resilience middleware.
 *
 * Signature-compatible with `client.ts`'s `sendMessage`:
 *
 *   (opts: SendOptions) => AsyncGenerator<string, StreamedResponse>
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
 * - **bridge**: canonical events → legacy `(yield string, return
 *   StreamedResponse)` + lifecycle callbacks.
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

import { readCredentials } from "../../auth.ts"
import type { SendOptions, StreamedResponse } from "../../client/types.ts"
import { diag } from "../../diagnostic-bus.ts"
import { rebroadcastQuotaForSessionUpdate } from "../../quota-broadcast.ts"
import { addSessionUsage } from "../../session-tokens.ts"
import {
  canonicalEventsToLegacyStream,
  legacyAuthToProviderAuth,
  sendOptionsToCanonical,
} from "../adapter-legacy.ts"
import type { RunContext } from "../provider.ts"
import { run } from "../run.ts"

import { type AuthRefreshState, withAuthRefresh } from "./auth-refresh.ts"
import { withRetry } from "./retry.ts"
import { withStreamWatchdog } from "./watchdog.ts"

/**
 * Stream a request through the canonical layer + resilience middleware
 * while presenting the legacy `sendMessage` surface.
 *
 * @param opts Legacy send options (auth, messages, model, tools, callbacks…).
 * @yields Text deltas (the legacy string channel), plus retry stall markers.
 * @returns The final {@link StreamedResponse} once the stream completes.
 */
export async function* canonicalSendFn(
  opts: SendOptions,
): AsyncGenerator<string, StreamedResponse, undefined> {
  const req = sendOptionsToCanonical(opts)
  // Shared, mutable auth: auth-refresh updates `.token` in place so a
  // refreshed token is picked up by the next attempt within this send.
  const authState: AuthRefreshState = { auth: legacyAuthToProviderAuth(opts.auth) }

  // One attempt = run() guarded by the watchdog, bridged to the legacy
  // string/StreamedResponse contract + lifecycle callbacks.
  const makeWatchdoggedAttempt = (): AsyncGenerator<string, StreamedResponse, undefined> => {
    const events = withStreamWatchdog(
      (signal) => {
        const ctx: RunContext = {
          auth: authState.auth,
          sessionId: "",
          networkClient: opts.networkClient,
        }
        return run({ ...req, signal }, { context: ctx })
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
    return canonicalEventsToLegacyStream(events, {
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
      onUsage: (u) => {
        addSessionUsage({
          input_tokens: u.inputTokens,
          output_tokens: u.outputTokens,
          cache_read_input_tokens: u.cacheReadTokens,
          cache_creation_input_tokens: u.cacheCreationTokens,
        })
        rebroadcastQuotaForSessionUpdate()
      },
    })
  }

  // auth-refresh wraps the attempt (keychain-first peer adoption is the
  // Anthropic multi-process race fix, injected as a provider-neutral hook).
  const makeAuthRefreshedAttempt = () =>
    withAuthRefresh(makeWatchdoggedAttempt, authState, {
      peerToken: () => readCredentials()?.claudeAiOauth?.accessToken,
    })

  // retry is the outermost layer: forever, capped backoff, user-abortable.
  return yield* withRetry(makeAuthRefreshedAttempt, { signal: opts.signal })
}
