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
 * - **auth-refresh**: on 401, store-first peer adoption then network
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

import { providerPeerToken, resolveStoredProviderAuth } from "../../auth/auth-strategies.ts"
import { diag } from "../../bus/diagnostic-bus.ts"
import { GLOBAL_STATUS_BUS, type StatusHandle } from "../../bus/status.ts"
import {
  defaultNetworkClient,
  NetworkClient,
  type NetworkRequestInput,
  networkActivityObserver,
} from "../../network/index.ts"
import {
  rebroadcastQuotaForSessionUpdate,
  signalQuotaRefresh,
} from "../../quota/quota-broadcast.ts"
import { addSessionUsage } from "../../session/session-tokens.ts"
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
import { debugRequestOptions } from "./debug.ts"
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
 * Resolve the credential for the request's PROVIDER from minimal-agent's own
 * provider auth store, keyed by the model's provider (not the host's single
 * session). This is the fix for the bug where every provider was handed one
 * provider's OAuth token (so a request to a second provider 401'd).
 *
 * Every provider, including the one that ships an OAuth/plan login, resolves
 * uniformly through {@link resolveStoredProviderAuth}: it reads the provider
 * plugin's own credential (via its `oauthLogin`/`apiKeyAuth` strategy) and
 * wires a `refresh` callback when the strategy declares `refreshCredential`, so
 * the transport's 401 recovery works the same for all of them. Missing
 * credentials THROW (no silent fallback to env/config or another provider's
 * token).
 *
 * An unresolvable model id defers to the caller-supplied credential so `run()`
 * raises its own "unknown model" error rather than this masking it.
 */
function resolveProviderAuth(opts: SendOptions): ProviderAuth {
  if (opts.auth.type === "provider") return opts.auth.auth
  const providerId = resolveRequestProviderId(opts)
  if (!providerId) return legacyAuthToProviderAuth(opts.auth)
  return resolveStoredProviderAuth(providerId, opts.model ?? "", opts.credentialName)
}

/**
 * The provider id for this request: the explicitly selected provider, else the
 * model registry's mapping. Returns `undefined` for an unresolvable model id
 * (the caller then falls back to the supplied credential).
 */
function resolveRequestProviderId(opts: SendOptions): string | undefined {
  if (opts.selectedProviderId) return opts.selectedProviderId
  try {
    return resolveModel(opts.model ?? "").providerId
  } catch {
    return undefined
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
  // The model's provider, used to scope both the credential lookup and the
  // store-first peer-token recovery to THIS request's provider (not the
  // host's single session). Undefined only for an unresolvable model id, where
  // resolveProviderAuth falls back to the caller-supplied credential.
  const providerId = resolveRequestProviderId(opts)
  // Shared, mutable auth keyed by the model's provider: each provider resolves
  // its own credential through the provider auth store. auth-refresh updates
  // `.token` in place so a refreshed token is picked up by the next attempt
  // within this send.
  const initialAuth = resolveProviderAuth(opts)
  const authState: AuthRefreshState = { auth: initialAuth }

  // ------------------------------------------------------------------
  // Realtime activity binding (status-line ↑/↓ bytes infix).
  //
  // Wire ids are PER REQUEST, not per send. A provider may start side traffic
  // (Grok's OAuth billing GET is the observed case) while its response stream
  // is open. Reusing one id lets that probe overwrite the stream's net-dbg and
  // activity trackers. Each watchdog attempt therefore creates a fresh
  // stream-only client below; side requests keep NetworkClient's own UUIDs.
  const requestStatus = GLOBAL_STATUS_BUS.create("Sending request", {
    notificationId: "network.request",
    category: "network",
  })
  const baseClient = (opts.networkClient ?? defaultNetworkClient) as NetworkClient

  // One attempt = run() guarded by the watchdog, bridged to the legacy
  // string/StreamedResponse contract + lifecycle callbacks.
  const makeWatchdoggedAttempt = (): AsyncGenerator<string, StreamedResponse, undefined> => {
    // Phase control is filled by withStreamWatchdog via onBindPhaseControl
    // before makeStream runs; network lifecycle hooks call into it.
    let phaseCtl: {
      markHeadersReceived: () => void
      markBodyActivity: () => void
    } | null = null

    let detachAttemptActivity = (): void => {}
    const events = withStreamWatchdog(
      (signal) => {
        const attemptClient = bindPrimaryStreamRequest(baseClient, {
          statusHandle: requestStatus,
          onHeaders: () => phaseCtl?.markHeadersReceived(),
          onBodyChunk: () => phaseCtl?.markBodyActivity(),
        })
        detachAttemptActivity = attemptClient.detach
        const ctx: RunContext = {
          auth: authState.auth,
          sessionId: "",
          networkClient: attemptClient.client,
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
        // Pre-stream / TTFB budget (default 120s). Without this the watchdog
        // falsely charged multi-MB upload to mid-stream 30s idle (MA-882492).
        responseHeadersTimeoutMs: opts.responseHeadersTimeoutMs,
        signal: opts.signal,
        onBindPhaseControl: (ctl) => {
          phaseCtl = ctl
        },
        onStall: ({ reason, idleMs, elapsedMs, stallPhase, stallSubPhase }) => {
          // Mirror the legacy scrollback surface so a stalled canonical
          // attempt reads identically to a stalled legacy one. Phase is also
          // on the thrown error for retry.ts (diag alone is not enough).
          diag.warn("api.stream-stalled", `stream ${reason}`, {
            "error-type": reason,
            "idle-ms": idleMs,
            "elapsed-ms": elapsedMs,
            phase: stallPhase,
            ...(stallSubPhase ? { "stall-sub-phase": stallSubPhase } : {}),
          })
        },
      },
    )
    const labelledEvents = updateLabelsFromEvents(
      finalizeEvents(events, () => detachAttemptActivity()),
      requestStatus,
    )
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

  // auth-refresh wraps the attempt. Store-first peer adoption (the
  // multi-process token-rotation race fix) is injected as a provider-neutral
  // hook: it re-reads THIS request's provider's stored OAuth token, so a peer
  // process's rotation is adopted before falling back to a network refresh.
  const makeAuthRefreshedAttempt = () =>
    withAuthRefresh(makeWatchdoggedAttempt, authState, {
      peerToken: providerId
        ? () => providerPeerToken(providerId, undefined, opts.credentialName)
        : undefined,
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
    // Poke the `quota-status` footer to repaint THIS turn. The provider adapter
    // cached its own fresh rate-limit headers during run() (setAnthropicRateLimits
    // / setOpenAIRateLimits — each provider owns its cache in its sibling repo,
    // which core cannot reach). The footer slot ignores the event payload: on
    // `quota.headersReceived` it re-fires and re-reads the active provider's cache
    // via fetchSessionInfo. So a payload-less signal is enough, and this stays
    // fully provider-neutral. Without it the footer only refreshes on its 5-minute
    // heartbeat (rebroadcastQuotaForSessionUpdate is gated on the now-always-empty
    // CORE cache), which is why the 5h/7d windows vanished after the plugin move.
    // Fired unconditionally (even on a usage-less stream) so an early/aborted turn
    // that still cached headers repaints too.
    signalQuotaRefresh()
    return finalStream
  } finally {
    requestStatus.clear()
  }
}

const KNOWN_NON_STREAM_LABELS = new Set([
  "grok.billing",
  "grok.quota.probe",
  "grok.oauth.device.code",
  "grok.oauth.device.poll",
  "grok.oauth.refresh",
  "openai.oauth.device.usercode",
  "openai.oauth.device.poll",
  "openai.oauth.device.exchange",
  "openai.oauth.refresh",
  "anthropic.oauth.refresh",
])

function isPrimaryStreamRequest(input: NetworkRequestInput): boolean {
  if (KNOWN_NON_STREAM_LABELS.has(input.label)) return false
  if (input.policyTags?.includes("llm-stream")) return true
  return input.method === "POST"
}

function isStreamingResponse(input: NetworkRequestInput, contentType: string): boolean {
  if (input.policyTags?.includes("llm-stream")) return true
  const ct = contentType.toLowerCase()
  return (
    ct.includes("text/event-stream") ||
    ct.includes("application/x-ndjson") ||
    ct.includes("application/ndjson") ||
    ct.includes("application/connect+")
  )
}

/**
 * Bind one exact LLM stream request for an attempt.
 *
 * Every request gets a unique wire id. Only the first stream-eligible POST gets
 * the status tracker and watchdog lifecycle taps; concurrent billing/auth/quota
 * traffic keeps an independent id and cannot reset the stream watchdog or
 * overwrite its net-dbg handle. Request-local lifecycle callbacks run inside
 * NetworkClient.tapResponse at the same raw-chunk boundary as observers.
 *
 * Activity attach must happen at reservation (before headers): the upload-phase
 * "Sending request" row needs onRequest → ↑/host immediately. Waiting until
 * onResponse left that row empty for long TTFB, even though receiving later
 * painted correctly once onChunk fired.
 */
export function bindPrimaryStreamRequest(
  client: NetworkClient,
  hooks: {
    statusHandle: StatusHandle
    onHeaders?: () => void
    onBodyChunk?: () => void
  },
): { client: NetworkClient; detach: () => void } {
  const wrapper: NetworkClient = Object.create(client)
  /** Wire id of the claimed stream (activity attach target). */
  let primaryId: string | undefined
  /** First stream-eligible POST reserved until headers classify it. */
  let reservedId: string | undefined

  wrapper.request = (input) => {
    const id = input.id ?? randomUUID()
    // Only one candidate may hold lifecycle/activity at a time. Side probes
    // (billing, quota, OAuth) keep independent UUIDs and never mark body activity.
    if (primaryId === undefined && reservedId === undefined && isPrimaryStreamRequest(input)) {
      reservedId = id
      // Attach before the wire call so NetworkClient.onRequest can paint upload
      // activity (↑ N · host). Detach below if headers prove this was not a stream.
      networkActivityObserver.attach(id, hooks.statusHandle)
      let claimed = false
      return client.request({
        ...input,
        id,
        lifecycle: {
          ...input.lifecycle,
          onResponse: (response) => {
            input.lifecycle?.onResponse?.(response)
            if (!isStreamingResponse(input, response.headers.get("content-type") ?? "")) {
              // Auth/JSON POST was first — free the reservation for the real stream.
              if (reservedId === id) {
                networkActivityObserver.detach(id)
                reservedId = undefined
              }
              return
            }
            claimed = true
            primaryId = id
            reservedId = undefined
            hooks.onHeaders?.()
          },
          onBodyChunk: (chunk, response) => {
            input.lifecycle?.onBodyChunk?.(chunk, response)
            if (claimed) hooks.onBodyChunk?.()
          },
        },
      })
    }
    return client.request({ ...input, id })
  }

  return {
    client: wrapper,
    detach: () => {
      if (primaryId !== undefined) networkActivityObserver.detach(primaryId)
      else if (reservedId !== undefined) networkActivityObserver.detach(reservedId)
    },
  }
}

/** Back-compatible lifecycle helper for focused tests and wire probes. */
export function bindRequestLifecycle(
  client: NetworkClient,
  hooks: {
    onHeaders?: () => void
    onBodyChunk?: () => void
  },
): NetworkClient {
  const wrapper: NetworkClient = Object.create(client)
  wrapper.request = (input) =>
    client.request({
      ...input,
      lifecycle: {
        ...input.lifecycle,
        onResponse: (response) => {
          input.lifecycle?.onResponse?.(response)
          hooks.onHeaders?.()
        },
        onBodyChunk: (chunk, response) => {
          input.lifecycle?.onBodyChunk?.(chunk, response)
          hooks.onBodyChunk?.()
        },
      },
    })
  return wrapper
}

async function* finalizeEvents(
  events: AsyncIterable<CanonicalEvent>,
  finalize: () => void,
): AsyncIterable<CanonicalEvent> {
  try {
    yield* events
  } finally {
    finalize()
  }
}
