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
import { resolveModel } from "../model-registry.ts"
import type { ProviderAuth, RunContext } from "../provider.ts"
import { run } from "../run.ts"

import { type AuthRefreshState, withAuthRefresh } from "./auth-refresh.ts"
import { withRetry } from "./retry.ts"
import { withStreamWatchdog } from "./watchdog.ts"

/** Read an API key from the environment, or throw an actionable error. */
function apiKeyFromEnv(envVar: string, providerId: string, modelId: string): ProviderAuth {
  const key = process.env[envVar]
  if (!key || key.trim().length === 0) {
    throw new Error(
      `canonical transport: ${envVar} is not set, but model "${modelId}" resolves to ` +
        `provider "${providerId}", which authenticates with its own API key (NOT the ` +
        `Anthropic session). Export ${envVar} and retry.`,
    )
  }
  return { kind: "api-key", key }
}

/**
 * Resolve the credential for the request's PROVIDER, not the host's single
 * Anthropic session. This is the fix for the bug where every provider was
 * handed the Anthropic OAuth token (so gpt-5.5 reached OpenAI but 401'd):
 *
 * - anthropic  → the legacy `AuthResult` (OAuth keychain; keeps the
 *   keychain-first / peer-token 401 recovery wired in `canonicalSendFn`).
 * - openai     → `OPENAI_API_KEY`.
 * - openrouter → `OPENROUTER_KEY`.
 * - missing key → THROW (no silent fallback to the Anthropic token).
 *
 * An unresolvable model id defers to the legacy credential so `run()` raises
 * its own "unknown model" error rather than this masking it (that path never
 * reaches a real non-Anthropic endpoint).
 */
function resolveProviderAuth(opts: SendOptions): ProviderAuth {
  let providerId: string
  try {
    providerId = resolveModel(opts.model ?? "").providerId
  } catch {
    return legacyAuthToProviderAuth(opts.auth)
  }
  const modelId = opts.model ?? ""
  switch (providerId) {
    case "anthropic":
      return legacyAuthToProviderAuth(opts.auth)
    case "openai":
      return apiKeyFromEnv("OPENAI_API_KEY", providerId, modelId)
    case "openrouter":
      return apiKeyFromEnv("OPENROUTER_KEY", providerId, modelId)
    default:
      throw new Error(
        `canonical transport: no credential strategy for provider "${providerId}" ` +
          `(model "${modelId}"). Add one in src/llm/transport/canonical-send.ts:resolveProviderAuth.`,
      )
  }
}

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
  // Shared, mutable auth keyed by the model's PROVIDER (not the host's
  // Anthropic session): OpenAI/OpenRouter get their own API key, Anthropic
  // keeps the OAuth credential. auth-refresh updates `.token` in place so a
  // refreshed token is picked up by the next attempt within this send.
  const authState: AuthRefreshState = { auth: resolveProviderAuth(opts) }

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
