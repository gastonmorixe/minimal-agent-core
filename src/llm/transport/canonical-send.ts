/**
 * Provider-neutral transport that satisfies the `AgentCore` `sendFn`
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
 * # Middleware onion
 *
 *   canonicalAttemptFn = withAuthRefresh( withStreamWatchdog( run() ) → bridge )
 *   canonicalSendFn    = withRetry( canonicalAttemptFn )
 *
 * - **watchdog** (innermost): idle / hard-timeout / truncation guard over
 *   one attempt's canonical event stream; throws tagged errors.
 * - **bridge**: canonical events → legacy shape
 *   (`yield string` / `return StreamedResponse`) + lifecycle callbacks.
 * - **auth-refresh**: on 401, store-first peer adoption then network
 *   refresh, retry once; provider-neutral via `ProviderAuth.refresh`.
 * - **retry**: only in {@link canonicalSendFn}, for side calls outside the
 *   agent loop. The agent loop sends with {@link canonicalAttemptFn} and
 *   decides retries itself from the error class (`AgentCore.run`).
 *
 * The `authState` is mutated in place by auth-refresh so a refreshed token
 * is used by the next request inside the same attempt.
 *
 * `client.ts` is NOT touched: the legacy Anthropic path keeps its own inline
 * copies of this infrastructure.
 *
 * @module llm/transport/canonical-send
 */

import { randomUUID } from "node:crypto"

import { authResultToProviderAuth } from "../../auth/auth.ts"
import { providerPeerToken, resolveStoredProviderAuth } from "../../auth/auth-strategies.ts"
import { NOOP_PLUGIN_EVENTS } from "../../bus/plugin-events-port.ts"
import type { StatusHandle } from "../../bus/status.ts"
import { type LiveStatus, NOOP_STATUS_PORT } from "../../bus/status-port.ts"
import { processDiagnostics } from "../../diagnostics/hub.ts"
import { currentSessionScope } from "../../infra/session-scope.ts"
import {
  defaultNetworkClient,
  NetworkClient,
  type NetworkRequestInput,
  networkActivityObserver,
  withRequestDiagnostics,
} from "../../network/index.ts"
import {
  rebroadcastQuotaForSessionUpdate,
  signalQuotaRefresh,
} from "../../quota/quota-broadcast.ts"
import { getSessionId } from "../../session/session-id.ts"
import { addSessionEstimatedUsage, addSessionUsage } from "../../session/session-tokens.ts"
import type { CanonicalEvent } from "../canonical-events.ts"
import { sendOptionsToCanonical } from "../codec/request-codec.ts"
import { assembleStreamedResponse } from "../codec/stream-assembler.ts"
import { hasBilledTokens } from "../codec/usage-record.ts"
import { resolveModel } from "../model-registry.ts"
import type { ProviderAuth, RunContext } from "../provider.ts"
import { run } from "../run.ts"
import { lookupTokenEstimator } from "../token-estimate.ts"

import { type AuthRefreshState, withAuthRefresh } from "./auth-refresh.ts"
import { createBlockStatusPublisher } from "./block-status-publisher.ts"
import { preStreamStreakKey, preStreamStreaks } from "./pre-stream-streak.ts"
import { processRequestInspector, requestSnapshot } from "./request-inspector.ts"
import { withRetry } from "./retry.ts"
import { resolveStreamTimeouts } from "./stream-timeouts.ts"
import type { SendOptions, StreamedResponse } from "./types.ts"
import { type WatchdogPhaseControl, withStreamWatchdog } from "./watchdog.ts"

/**
 * Intercept the canonical event stream to drive the status-phase lifecycle.
 *
 * This wrapper moves the phase at the corresponding canonical-event
 * boundary: `message_start` → `receiving` (response content has begun).
 * Core writes a phase code only (spec S23); a label, if any, is the host's
 * job (the `StatusPort` implementation owns that).
 */
async function* updatePhaseFromEvents(
  events: AsyncIterable<CanonicalEvent>,
  markReceiving: () => void,
): AsyncGenerator<CanonicalEvent> {
  for await (const ev of events) {
    if (ev.type === "message_start") markReceiving()
    yield ev
  }
}

/**
 * Move `live` to `receiving` at most once. Called on the first body byte of
 * the claimed stream and on `message_start`, whichever comes first.
 *
 * The first byte is the earlier fact: some providers send framing frames for
 * seconds before `message_start` (Cursor holds it back until the first content
 * event), and the row read "Sending request ↓ 39 KB" the whole time. A send
 * that reuses an open wire has no fresh request to tap, so `message_start`
 * still covers it.
 */
function receivingMarker(live: LiveStatus): () => void {
  let done = false
  return () => {
    if (done) return
    done = true
    live.update({ phase: "receiving" })
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
 *
 * The `MINIMAL_AGENT_TEST_AUTH=1` seam (test env only) also defers to the
 * caller-supplied credential: startup (`resolveStartupAuth`)
 * hand back a synthetic test token under it without reading the store, so the
 * send must not then demand a real stored credential for the provider.
 */
function resolveProviderAuth(opts: SendOptions): ProviderAuth {
  if (opts.auth.type === "provider") return opts.auth.auth
  if (isTestAuthSeam()) return authResultToProviderAuth(opts.auth)
  const providerId = resolveRequestProviderId(opts)
  if (!providerId) return authResultToProviderAuth(opts.auth)
  return resolveStoredProviderAuth(providerId, opts.model ?? "", opts.credentialName)
}

/** `MINIMAL_AGENT_TEST_AUTH=1` under a test runtime (same gate as `resolveStartupAuth`). */
function isTestAuthSeam(): boolean {
  if (process.env.MINIMAL_AGENT_TEST_AUTH !== "1") return false
  return process.env.NODE_ENV === "test" || process.env.BUN_ENV === "test"
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
 * Stream a request through the canonical layer and retry transient errors
 * forever (side calls outside the agent loop, such as plugin `llm.complete`).
 *
 * @param opts - Legacy send options (auth, messages, model, tools, callbacks…).
 * @yields Text deltas (the legacy string channel).
 * @returns The final {@link StreamedResponse} once the stream completes.
 */
export async function* canonicalSendFn(
  opts: SendOptions,
): AsyncGenerator<string, StreamedResponse, undefined> {
  return yield* withRetry(() => canonicalAttemptFn(opts), {
    ...(opts.signal ? { signal: opts.signal } : {}),
    ...(opts.diagnostics ? { diagnostics: opts.diagnostics } : {}),
  })
}

/**
 * Stream ONE attempt of a request through the canonical layer (auth refresh,
 * watchdog, bridge) while presenting the legacy `sendMessage` surface. It does
 * not retry: a failure throws with its error class, and the caller decides.
 * This is the agent loop's default transport.
 *
 * @param opts - Legacy send options (auth, messages, model, tools, callbacks…).
 * @yields Text deltas (the legacy string channel).
 * @returns The final {@link StreamedResponse} once the stream completes.
 */
export async function* canonicalAttemptFn(
  opts: SendOptions,
): AsyncGenerator<string, StreamedResponse, undefined> {
  // The caller's handle (AgentCore passes its session scope). Stall and auth
  // diagnostics go here, and every network request of the attempt carries it.
  const diagnostics = opts.diagnostics ?? processDiagnostics()
  // The model's provider, used to scope both the credential lookup and the
  // store-first peer-token recovery to THIS request's provider (not the
  // host's single session). Undefined only for an unresolvable model id, where
  // resolveProviderAuth falls back to the caller-supplied credential.
  const providerId = resolveRequestProviderId(opts)
  // The (provider, model) token estimator, or undefined. Core has no ratio:
  // with none, there is no live token rate and no usage estimate.
  const liveEstimator = lookupTokenEstimator(opts.model, providerId)
  // Typed `llm.requestWillSend` event (the data behind a host's `--debug`
  // request dump). Zero cost with no subscriber: one `hasSubscribers()`
  // check, and the event is built only inside the thunk. Core formats no
  // debug text and reads no DEBUG/VERBOSE env. The event carries the
  // request's diagnostics handle, so a subscriber can report on the session
  // scope of the request.
  // The event is published at the wire call of the primary stream request
  // (so it carries the final headers and body), at most once per call. With
  // no wire request (a failure before the wire), it is published in the
  // `finally` below, without headers and body.
  const inspector = opts.requestInspector ?? processRequestInspector()
  let inspected = false
  // No subscriber: no closure (zero cost).
  const publishRequest = !inspector.hasSubscribers()
    ? undefined
    : (wire?: NetworkRequestInput): void => {
        if (inspected) return
        inspected = true
        inspector.publish(
          () => ({
            sessionId: diagnostics.sessionId,
            ts: (diagnostics.now ?? Date.now)(),
            request: requestSnapshot(opts, wire, providerId),
            diagnostics,
          }),
          diagnostics,
        )
      }

  const req = sendOptionsToCanonical(opts)
  // Shared, mutable auth keyed by the model's provider: each provider resolves
  // its own credential through the provider auth store. auth-refresh updates
  // `.token` in place so a refreshed token is picked up by the next attempt
  // within this send.
  const initialAuth = resolveProviderAuth(opts)
  const authState: AuthRefreshState = { auth: initialAuth }

  // ------------------------------------------------------------------
  // Realtime activity binding (status-line ↑/↓ bytes infix).
  //
  // The live status comes from the injected `statusPort` (spec S23); with
  // none, `live` reports nowhere and this send is silent on the status
  // channel. `requestStatus` is a thin `StatusHandle`-shaped adapter over
  // `live`, kept only so `bindPrimaryStreamRequest` / `networkActivityObserver`
  // (byte-counter plumbing) stay unchanged: it forwards `updateActivity` /
  // `clear` and never sets a label.
  //
  // Wire ids are PER REQUEST, not per send. A provider may start side traffic
  // (Grok's OAuth billing GET is the observed case) while its response stream
  // is open. Reusing one id lets that probe overwrite the stream's net-dbg and
  // activity trackers. Each watchdog attempt therefore creates a fresh
  // stream-only client below; side requests keep NetworkClient's own UUIDs.
  const live = (opts.statusPort ?? NOOP_STATUS_PORT).open({ phase: "sending" })
  const requestStatus: StatusHandle = {
    update: () => {},
    updateActivity: (partial) => live.updateActivity(partial),
    clear: () => live.clear(),
  }
  const baseClient = (opts.networkClient ?? defaultNetworkClient) as NetworkClient
  // Watchdog limits: explicit SendOptions > env > default (silent block 90 s
  // after an in-block keepalive ping, else 300 s; pre-headers 60 s remote /
  // 120 s local URL, doubled for each pre-stream retry up to 240 s; 120 s
  // after the headers arrive).
  const timeouts = resolveStreamTimeouts({
    explicit: {
      streamIdleTimeoutMs: opts.streamIdleTimeoutMs,
      responseHeadersTimeoutMs: opts.responseHeadersTimeoutMs,
    },
    env: process.env,
    diagnostics,
  })
  // Pre-stream retries of this send target. The agent loop calls this
  // function once for each attempt, so the count lives in the transport
  // (pre-stream-streak.ts), keyed like the provider conversation below.
  const streakKey = preStreamStreakKey(
    currentSessionScope()?.sid ?? getSessionId(),
    providerId,
    opts.model,
  )

  // One attempt = run() guarded by the watchdog, bridged to the legacy
  // string/StreamedResponse contract + lifecycle callbacks.
  const makeWatchdoggedAttempt = (): AsyncGenerator<string, StreamedResponse, undefined> => {
    // Phase control is filled by withStreamWatchdog via onBindPhaseControl
    // before makeStream runs; network lifecycle hooks call into it.
    let phaseCtl: WatchdogPhaseControl | null = null
    // Read once for each attempt: stalls of earlier attempts grow the budget.
    const retries = preStreamStreaks.get(streakKey)
    let answered = false

    let detachAttemptActivity = (): void => {}
    const blockStatus = createBlockStatusPublisher(live)
    const markReceiving = receivingMarker(live)
    const events = withStreamWatchdog(
      (signal) => {
        const attemptClient = bindPrimaryStreamRequest(
          withRequestDiagnostics(baseClient, diagnostics),
          {
            statusHandle: requestStatus,
            // The request URL is the local/remote fact for pre-stream; it
            // is known here, before the wire call.
            onRequest: (input) => {
              publishRequest?.(input)
              const fact = { url: input.url, retries }
              phaseCtl?.setResponseHeadersTimeoutMs(timeouts.responseHeadersTimeoutMs(fact))
              phaseCtl?.setHeadersWaitBodyTimeoutMs(timeouts.headersWaitBodyTimeoutMs(fact))
            },
            onHeaders: () => phaseCtl?.markHeadersReceived(),
            onBodyChunk: () => {
              phaseCtl?.markBodyActivity()
              markReceiving()
              if (!answered) {
                // The endpoint answered: the next send starts at the base budget.
                answered = true
                preStreamStreaks.clear(streakKey)
              }
            },
          },
        )
        detachAttemptActivity = attemptClient.detach
        const ctx: RunContext = {
          auth: authState.auth,
          // Bidi providers (Cursor) key open tool-exec streams by sessionId.
          // Empty string forced a new UUID every round → never continued.
          // A scoped session (many sessions in one process) uses its own id,
          // so two sessions never share one provider conversation.
          sessionId: currentSessionScope()?.sid ?? getSessionId(),
          networkClient: attemptClient.client,
        }
        // acceptDegrade: when the adapter can offer a cheaper-but-valid
        // variant (e.g. fast-mode requested on a model with no fast tier →
        // same request without `speed`), take it instead of dying. The
        // degrade path yields a non-retryable StreamErrorEvent describing
        // the downgrade first, which the agent surfaces as a notice. This
        // matches the legacy transport's behavior for the same combos.
        return run({ ...req, signal }, { context: ctx, acceptDegrade: true, diagnostics })
      },
      {
        streamIdleTimeoutMs: timeouts.streamIdleTimeoutMs,
        silentBlockIdleTimeoutMs: timeouts.silentBlockIdleTimeoutMs,
        keepaliveSilentBlockIdleTimeoutMs: timeouts.keepaliveSilentBlockIdleTimeoutMs,
        attemptHardTimeoutMs: opts.attemptHardTimeoutMs,
        // Pre-stream / TTFB budget (remote 60s at start). Without this the
        // watchdog falsely charged multi-MB upload to mid-stream 30s idle
        // (MA-882492). Refined by the request URL in onRequest above.
        responseHeadersTimeoutMs: timeouts.responseHeadersTimeoutMs({ retries }),
        headersWaitBodyTimeoutMs: timeouts.headersWaitBodyTimeoutMs({ retries }),
        signal: opts.signal,
        onBindPhaseControl: (ctl) => {
          phaseCtl = ctl
          blockStatus.attemptStarted()
        },
        // Block facts (phase, tool, last content, idle budget) for the host's
        // status row, from the same tracker the watchdog budgets on.
        onBlockState: blockStatus.onBlockState,
        onStall: ({ reason, idleMs, elapsedMs, stallPhase, stallSubPhase, budgetMs }) => {
          if (reason === "stream_idle" && stallPhase === "pre-stream") {
            preStreamStreaks.stalled(streakKey)
          }
          // Mirror the legacy scrollback surface so a stalled canonical
          // attempt reads identically to a stalled legacy one. Phase is also
          // on the thrown error for retry.ts (diag alone is not enough).
          diagnostics.warn("api.stream-stalled", `stream ${reason}`, {
            "error-type": reason,
            "idle-ms": idleMs,
            "elapsed-ms": elapsedMs,
            "budget-ms": budgetMs,
            phase: stallPhase,
            ...(stallSubPhase ? { "stall-sub-phase": stallSubPhase } : {}),
          })
        },
      },
    )
    const phasedEvents = updatePhaseFromEvents(
      finalizeEvents(events, () => detachAttemptActivity()),
      markReceiving,
    )
    return assembleStreamedResponse(phasedEvents, {
      onThinkingDelta: opts.onThinkingDelta,
      onBlockEdge: opts.onBlockEdge,
      // Live-output telemetry (spec S28): forwarded from the per-send
      // `pluginEvents` port, never read from a global pointer here.
      pluginEvents: opts.pluginEvents,
      // The token rate comes only from the (provider, model) estimator.
      // No estimator: no rate (core has no chars ratio).
      ...(liveEstimator ? { estimateTokens: liveEstimator } : {}),
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
      diagnostics,
    })

  // Quota refresh events go to the send's `pluginEvents` port (spec S28).
  const quotaEvents = opts.pluginEvents ?? NOOP_PLUGIN_EVENTS

  // The status handle stays bound for the whole attempt and is torn down in
  // finally, mirroring the legacy client's outer try/finally.
  try {
    const finalStream = yield* makeAuthRefreshedAttempt()
    // Fold the full usage record (thinking and cache TTL split included)
    // into the session totals and repaint the quota footer.
    if (hasBilledTokens(finalStream.usage)) {
      addSessionUsage(finalStream.usage)
      rebroadcastQuotaForSessionUpdate(quotaEvents)
    } else {
      // Provider did not report billed usage (ollama/cursor/generic).
      // Estimate from transcript text so the live context bar reflects
      // reality instead of sitting at 0% for the whole session. Only the
      // (provider, model) estimator gives the count: with none, skip the
      // estimate (the bar keeps its last real value; core has no ratio).
      const estimator =
        opts.model === undefined
          ? lookupTokenEstimator(process.env.MINIMAL_AGENT_MODEL, providerId)
          : liveEstimator
      const transcriptText = !estimator
        ? ""
        : finalStream.text +
          "\n" +
          finalStream.blocks
            .map((b) => {
              if (b.type === "text") return b.text
              if (b.type === "thinking") return b.thinking
              if (b.type === "tool_use") {
                try {
                  return JSON.stringify(b.input)
                } catch {
                  return ""
                }
              }
              return ""
            })
            .join("\n")
      if (estimator && transcriptText.trim().length > 0) {
        addSessionEstimatedUsage(estimator(transcriptText))
        rebroadcastQuotaForSessionUpdate(quotaEvents)
      }
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
    signalQuotaRefresh(quotaEvents)
    return finalStream
  } finally {
    requestStatus.clear()
    if (!inspected) publishRequest?.()
  }
}

/**
 * Provider-neutral side-probe labels that must never own stream lifecycle.
 * Match dotted suffixes so plugins keep free naming (`*.billing`, `*.oauth.*`)
 * without embedding vendor tokens in core.
 */
function isNonStreamSideProbeLabel(label: string): boolean {
  const lower = label.toLowerCase()
  return (
    lower.endsWith(".billing") ||
    lower.includes(".billing.") ||
    lower.endsWith(".quota.probe") ||
    lower.includes(".quota.probe.") ||
    lower.includes(".oauth.") ||
    lower.endsWith(".oauth") ||
    // Non-stream POST helpers that can share the attempt client (e.g. compact).
    lower.endsWith(".compact")
  )
}

function isPrimaryStreamRequest(input: NetworkRequestInput): boolean {
  if (isNonStreamSideProbeLabel(input.label)) return false
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
    /** Called once when the primary stream request is reserved, before the wire call. */
    onRequest?: (input: NetworkRequestInput) => void
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
      hooks.onRequest?.(input)
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
