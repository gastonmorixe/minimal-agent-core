/**
 * Client module: Messages API with streaming, pretty debug logging, and 401 retry.
 *
 * Updated to match CLI v2.1.118 traffic (captured 2026-04-25):
 *   - Block-based message content (text, thinking, tool_use, tool_result)
 *   - Adaptive thinking with redacted thinking + signatures
 *   - Effort parameter (output_config.effort)
 *   - Per-request-type beta flags
 *   - 64K max_tokens default (was 8192)
 *   - SSE parsing for signature_delta and input_json_delta
 */

import { randomUUID } from "node:crypto"

import { type AuthResult, readCredentials } from "./auth.ts"
import { type CacheUsage, formatCacheLine, getCacheDetector, snapshotRequest } from "./cache.ts"
import {
  c,
  debugBody,
  debugHeader,
  debugHeaders,
  debugKV,
  debugResponse,
  extractToolHint,
  formatBytes,
  isDebug,
  isShowHiddenChars,
  isVerbose,
  truncate,
} from "./client/debug.ts"
// Wire-format types live in `src/client/types.ts`; debug/ratelimit/status
// helpers in `src/client/debug.ts`. Imported here for internal use and
// re-exported below so external consumers can still
// `import { Message, ContentBlock, ... } from "./client.ts"`.
import type {
  BlockCacheControl,
  ContentBlock,
  Message,
  ModelInfo,
  SendOptions,
  StreamEvent,
  StreamedResponse,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "./client/types.ts"
import { has1mContext, normalizeModelForAPI } from "./client/types.ts"
import { diag, markErrorAsDiagEmitted } from "./diagnostic-bus.ts"
import { API_URL, buildHeaders, DEFAULT_MODEL, SYSTEM_PROMPT } from "./headers.ts"
import { buildMetadata, getSessionId } from "./metadata.ts"
import {
  defaultNetworkClient,
  type NetworkClient,
  networkActivityObserver,
} from "./network/index.ts"
import { broadcastResponseRateLimits, rebroadcastQuotaForSessionUpdate } from "./quota-broadcast.ts"
import { abortableSleep } from "./retry.ts"
import { addSessionUsage } from "./session-tokens.ts"
import { GLOBAL_STATUS_BUS } from "./status.ts"

export type {
  BlockCacheControl,
  ContentBlock,
  Message,
  ModelInfo,
  SendOptions,
  StreamedResponse,
  TextBlock,
  ThinkingBlock,
  ToolResultBlock,
  ToolUseBlock,
}
export { has1mContext, isDebug, isShowHiddenChars, isVerbose, normalizeModelForAPI }

// ---------------------------------------------------------------------------
// Streaming response parser
// ---------------------------------------------------------------------------

/**
 * Parse a Server-Sent Events stream into typed event objects.
 *
 * The Anthropic streaming API uses standard SSE format:
 *   event: <type>\n
 *   data: <json>\n\n
 *
 * We only look at `data:` lines since the event type is also in the JSON.
 * The stream ends with `data: [DONE]` (not standard SSE, but conventional).
 *
 * Uses a line-buffered approach: we accumulate bytes until we see newlines,
 * then process complete lines. This handles partial chunks from the network
 * correctly (a single SSE event may arrive across multiple TCP segments).
 *
 * @yields Parsed stream events from complete SSE `data:` lines.
 */
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncIterable<StreamEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? "" // keep incomplete last line in buffer

      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const data = line.slice(6).trim()
          if (data === "[DONE]") return
          try {
            yield JSON.parse(data) as StreamEvent
          } catch {
            // skip malformed events : shouldn't happen but defensive
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// sendMessage : streaming, returns async iterable of text chunks
// ---------------------------------------------------------------------------

/**
 * Send a message to the Messages API and yield streamed text chunks.
 *
 * The core HTTP layer. Builds the request body matching v2.1.91 wire format,
 * POSTs to `/v1/messages?beta=true`, parses the SSE response, and yields
 * text chunks via async generator. The full structured response (with
 * thinking and tool_use blocks) is available as the generator's return value.
 *
 * **Behaviors replicated from the real CLI:**
 * - Per-request-type beta flags (via {@link SendOptions.requestType})
 * - Adaptive thinking for non-haiku models
 * - Effort parameter (`output_config.effort: "high"`) for non-haiku
 * - Model-specific gating (no thinking/effort for haiku, no context-1m for sonnet)
 * - 401 retry with token refresh (mirrors CLI's `onAuth401` pattern)
 * - SSE parsing for `text_delta`, `signature_delta`, `input_json_delta`
 *
 * **Two ways to get the result:**
 * 1. Iterate the generator for live text chunks (use this for streaming UI)
 * 2. Await the return value for the full {@link StreamedResponse} with all blocks
 *
 * @param opts - Request options. See {@link SendOptions} for all fields.
 * @yields Text chunks from `text_delta` SSE events as they arrive
 * @returns Final {@link StreamedResponse} after stream completes
 *
 * @example
 * ```ts
 * // Streaming text only:
 * for await (const chunk of sendMessage({ auth, messages })) {
 *   process.stdout.write(chunk);
 * }
 *
 * // Get full structured response:
 * const result = await sendMessageFull({ auth, messages });
 * for (const block of result.blocks) {
 *   if (block.type === "tool_use") console.log("called:", block.name);
 * }
 * ```
 *
 * @throws Error if the API returns a non-2xx status (after 401 retry)
 */
/**
 * Single-attempt request lifecycle: POST + auth refresh + (streaming)
 * SSE consumption + StreamedResponse return. The {@link sendMessage}
 * public export wraps this in a retry coordinator (see further down)
 * that re-invokes a fresh attempt when:
 *
 *   - The throw came from an SSE `event: error` of a transient kind
 *     (`overloaded_error`, `api_error`) — tagged via `streamErrorType`
 *     in `case "error":` above.
 *   - Nothing has been yielded to the consumer yet (re-streaming
 *     after partial text reached the UI would duplicate output).
 *   - The attempt count + total wall-clock budget are not exhausted.
 *
 * Splitting the wrapper from the attempt keeps the existing
 * read-modify-write body of one HTTP request unmodified, so the diff
 * is small and the per-attempt streaming state (blocks, accumulators,
 * fullText, currentBlock, …) resets naturally on each new
 * `sendMessageOnce` call.
 */
// Exported (not just module-internal) so tests can exercise one
// request lifecycle in isolation from the retry coordinator — see
// `src/client.test.ts > SSE error event handling`. Production code
// should always call {@link sendMessage} so retries fire.
export async function* sendMessageOnce(
  opts: SendOptions,
): AsyncGenerator<string, StreamedResponse, undefined> {
  const {
    auth,
    messages,
    system = SYSTEM_PROMPT,
    model: rawModel = DEFAULT_MODEL,
    maxTokens = 64000,
    stream = true,
    requestType = "conversation",
    thinking = { type: "adaptive" as const },
    outputConfig = { effort: "medium" },
    tools,
    temperature,
    contextManagement,
    onThinkingStart,
    onThinkingDelta,
    onThinkingStop,
    onTextStop,
    networkClient = defaultNetworkClient,
    signal,
    streamIdleTimeoutMs = 30_000,
    attemptHardTimeoutMs = 30 * 60_000,
    responseHeadersTimeoutMs = 120_000,
    speed,
  } = opts

  // Strip client-side [1m] suffix : API activation is via beta flag
  const model = normalizeModelForAPI(rawModel)

  const sessionId = getSessionId()
  // Pass rawModel so buildBetaFlags sees [1m] and adds context-1m flag.
  // The 5th arg is the optional feature-gated beta set : right now we only
  // surface `speed === "fast"` from the caller (fast-mode-2026-02-01 beta).
  const headers = buildHeaders(auth, sessionId, requestType, rawModel, {
    speedFast: speed === "fast",
  })
  const metadata = buildMetadata(auth)

  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    stream,
    system,
    messages,
    metadata,
  }

  // Thinking: only for models that support it (not haiku)
  // v2.1.91 capture: opus sends thinking:{type:"adaptive"}, haiku does not
  const isHaiku = model.includes("haiku")
  if (thinking && !isHaiku) {
    body.thinking = thinking
  }

  // Output config: effort and/or structured format
  // v2.1.91: effort only sent for models that support it (not haiku)
  if (outputConfig && !isHaiku) {
    body.output_config = outputConfig
  } else if (outputConfig?.format) {
    // Structured output format can be sent even for haiku (used in title gen)
    body.output_config = { format: outputConfig.format }
  }

  // Tools: include if provided
  if (tools && tools.length > 0) {
    body.tools = tools
  }

  // Temperature: only sent explicitly when set (title gen uses 1)
  if (temperature != null) {
    body.temperature = temperature
  }

  // Speed mode: opt-in `speed:"fast"` for the 2026-02-01 fast-mode beta.
  // The beta flag itself lives in headers.ts; here we only set the body
  // field. Capability gating ("does this model support fast?") happens
  // upstream — the agent only forwards the option when the model entry
  // declares `speedFast: true`.
  if (speed === "fast") {
    body.speed = "fast"
  }

  // Context management: live 2.1.118 conversation requests carry
  //   { edits: [{ type: "clear_thinking_20251015", keep: "all" }] }
  // at the top level. Gated by the context-management-2025-06-27 beta.
  // The clear_thinking strategy requires thinking to be enabled, which is the
  // same predicate as `!isHaiku` (haiku has no thinking, so we never set
  // body.thinking for it above). Using !isHaiku here keeps the gate aligned
  // with the thinking gate above and easier to reason about.
  // Pass contextManagement: null to opt out; omit to use the conversation
  // default; pass a custom object to override.
  if (contextManagement === undefined) {
    if (requestType === "conversation" && !isHaiku) {
      body.context_management = {
        edits: [{ type: "clear_thinking_20251015", keep: "all" }],
      }
    }
  } else if (contextManagement !== null) {
    body.context_management = contextManagement
  }

  debugHeader(`POST ${API_URL}`)
  debugKV("model", model)
  debugKV("stream", String(stream))
  debugKV("max_tokens", String(maxTokens))
  debugKV("request_type", requestType)
  if (thinking) debugKV("thinking", JSON.stringify(thinking))
  if (outputConfig) debugKV("output_config", JSON.stringify(outputConfig))
  debugHeaders(headers)
  debugBody(body as Record<string, unknown>)

  const requestStatus = GLOBAL_STATUS_BUS.create("Sending request", {
    notificationId: "network.request",
    category: "network",
  })

  // Bind the status handle to the network activity observer BEFORE firing
  // the request. The observer auto-fills `status.activity.sentBytes` /
  // `recvBytes` / `target.host` / `target.protocol` / `lastChunkAt` from
  // the transport's per-chunk callbacks, so renderers (LiveAreaStatusController,
  // StatusRenderer) can show live ↑/↓ bytes and the "⋯ stalled" state when
  // the model goes quiet mid-stream. Without this attach, every chunk falls
  // through the observer's trackers Map and gets discarded; the label would
  // freeze at whatever the last input_json_delta snapshotted (the
  // "Calling Write: streaming input (10 B) (30s)" bug). We pre-generate a
  // request id so we can attach BEFORE the request fires — networkClient
  // auto-uuids if no id is passed, but then we'd have no way to bind.
  const reqId = randomUUID()
  networkActivityObserver.attach(reqId, requestStatus)

  const reqSnapshot = snapshotRequest(body, model)
  const detector = getCacheDetector()

  const serializedBody = JSON.stringify(body)

  // ------------------------------------------------------------------
  // Per-attempt abort controller. Composes the caller's optional signal
  // (user Ctrl-C, agent.run() abort) with our internal stream watchdog
  // (see watchdogTimer below). The composed signal is what the transport
  // sees; either source aborting tears down the request immediately.
  //
  // Hoisted above doRequest so the closure captures `attemptSignal`
  // instead of the raw `signal`. That way every retry attempt — both
  // the initial POST and the 401-refresh retry inside doRequest — uses
  // the same watchdog-armed signal.
  // ------------------------------------------------------------------
  const attemptAbort = new AbortController()
  const attemptSignal = signal
    ? AbortSignal.any([signal, attemptAbort.signal])
    : attemptAbort.signal

  try {
    // ------------------------------------------------------------------
    // Pre-response (upload + time-to-first-byte) guard.
    //
    // The streaming watchdog further down only arms once we begin reading
    // the SSE *body*. The send + wait-for-response-headers phase was
    // unguarded: a stalled upload, or a server that accepts the POST but
    // never returns response headers, hangs `await networkClient.request()`
    // forever with nothing to abort it and nothing for the retry loop to
    // catch. Root cause of the 13h hang observed 2026-05-28 (session
    // b00e2d52): a ~2.3MB POST sat in "Sending request" with no watchdog.
    //
    // We arm a one-shot deadline around EACH request() call (the initial
    // POST and the 401-refresh retry both go through `doRequest`). It is
    // cleared the moment response headers arrive (request() resolves). On
    // trip we fire `attemptAbort` (already wired into the transport
    // signal; the transport rejects synchronously AND evicts the wedged
    // HTTP/2 session) and convert the resulting AbortError into a tagged,
    // retryable `stream_idle` so the outer `sendMessage` loop recovers on
    // a fresh connection. A user-initiated `signal` abort is left
    // untagged so it still propagates as a real cancel.
    // ------------------------------------------------------------------
    let preResponseTimedOut = false
    const doRequest = async (token: string) => {
      const h = { ...headers }
      if (h.authorization) h.authorization = `Bearer ${token}`
      else if (h["x-api-key"]) h["x-api-key"] = token

      preResponseTimedOut = false
      const ttfbGuard = setTimeout(() => {
        if (attemptAbort.signal.aborted) return
        preResponseTimedOut = true
        attemptAbort.abort()
      }, responseHeadersTimeoutMs)
      if (typeof ttfbGuard.unref === "function") ttfbGuard.unref()

      try {
        return await networkClient.request({
          id: reqId,
          label: "messages.send",
          method: "POST",
          url: API_URL,
          headers: h,
          body: serializedBody,
          signal: attemptSignal,
        })
      } catch (err) {
        // Our deadline fired (not a user cancel): surface a tagged,
        // retryable error so the harness retries instead of treating the
        // transport AbortError as a terminal cancellation.
        if (preResponseTimedOut && !signal?.aborted) {
          const elapsedS = (responseHeadersTimeoutMs / 1000).toFixed(0)
          diag.warn(
            "api.stream-stalled",
            `no response headers within ${elapsedS}s — aborting (request stalled before first byte)`,
            {
              "error-type": "stream_idle",
              "elapsed-ms": responseHeadersTimeoutMs,
              phase: "pre-response",
            },
          )
          const tagged = markErrorAsDiagEmitted(
            new Error(`Anthropic request stalled before response headers (${elapsedS}s)`),
          ) as Error & { streamErrorType?: string }
          tagged.streamErrorType = "stream_idle"
          throw tagged
        }
        throw err
      } finally {
        clearTimeout(ttfbGuard)
      }
    }

    let response = await doRequest(auth.token)
    requestStatus.update(stream ? "Waiting for response" : "Reading response")

    debugResponse(response.status, response.headers)

    // 401 retry with token refresh : mirrors onAuth401 pattern (L751090-751112).
    // Goal: when the access token expires during a long-running session,
    // refresh transparently and continue without forcing the user to
    // restart anything. Surface the refresh in the status bar, then
    // resume the same in-flight turn.
    //
    // Multi-process race mitigation (May 2026): when many agent processes
    // share one keychain entry, server-side refresh-token rotation makes
    // each refresh invalidate the access tokens cached by every OTHER
    // process. They each 401 on their next request, refresh, invalidate
    // the previous one, and the cycle never settles. Net-dbg trace from
    // session c0ab6ba6: 24/105 requests in a single 5-minute window
    // returned 401, with 22 refreshes (one outright `invalid_grant` :
    // refresh token already burned by another agent).
    //
    // Fix: on 401, re-read the keychain BEFORE calling auth.refresh().
    // If another process has already written a fresher access token, use
    // that directly : no oauth round-trip, no rotation, no race. Only
    // refresh if the keychain still has the same token we just got 401
    // on (i.e. WE are the freshest cache holder, the token genuinely
    // expired). Collapses N concurrent refreshes per "true expiry" event
    // into 1.
    if (response.status === 401 && auth.refresh) {
      debugHeader(c.yellow("401 : token expired"))

      // Step 1: keychain-first. Cheap (`security find-generic-password`),
      // synchronous, no network. Fail-quiet on any read error : fall
      // through to the refresh path.
      let recovered = false
      try {
        const fresh = readCredentials()
        const freshToken = fresh?.claudeAiOauth?.accessToken
        if (freshToken && freshToken !== auth.token) {
          requestStatus.update("Auth refreshed elsewhere, retrying...", {
            notificationId: "auth.refresh",
            category: "auth",
          })
          diag.info(
            "auth.refresh",
            "peer-process rotated token; retrying with fresh keychain value",
          )
          auth.token = freshToken
          response = await doRequest(freshToken)
          if (response.ok) {
            recovered = true
            diag.notice("auth.refresh", "recovered via peer-process token refresh", {
              recovery: "true",
            })
            requestStatus.update(stream ? "Waiting for response" : "Reading response", {
              notificationId: "network.request",
              category: "network",
            })
          }
        }
      } catch {
        // Keychain read failures are non-fatal; the refresh path below
        // is the authoritative recovery anyway.
      }

      // Step 2: still 401 (or keychain had no fresher token) → do our
      // own refresh.
      if (!recovered && response.status === 401) {
        requestStatus.update("Auth token expired, refreshing...", {
          notificationId: "auth.refresh",
          category: "auth",
        })
        diag.info("auth.refresh", "access token expired (401); refreshing")
        try {
          const refreshed = await auth.refresh()
          // Persist on the AuthResult so subsequent turns reuse the new
          // token without paying another 401+refresh round-trip.
          auth.token = refreshed.token
          requestStatus.update("Auth refreshed, resuming...", {
            notificationId: "auth.refresh",
            category: "auth",
          })
          response = await doRequest(refreshed.token)
          requestStatus.update(stream ? "Waiting for response" : "Reading response", {
            notificationId: "network.request",
            category: "network",
          })
          if (response.status === 401) {
            diag.error(
              "auth.refresh",
              "401 persists after token refresh; keychain credentials are stale",
            )
            throw new Error(
              "401 after token refresh. The keychain credentials are stale : " +
                "run `minimal-agent --login` (or `claude`) to re-login.",
            )
          }
          diag.notice("auth.refresh", "token refreshed cleanly", { recovery: "true" })
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e)
          diag.error("auth.refresh", `refresh failed: ${m}`, {
            "invalid-grant": m.includes("invalid_grant") ? "true" : "false",
          })
          throw new Error(`Token refresh failed: ${e instanceof Error ? e.message : String(e)}`, {
            cause: e,
          })
        }
      }
    }

    if (!response.ok) {
      const errorBody = await response.text()
      if (isDebug()) {
        debugHeader(c.red(`Error ${response.status}`))
        console.error(`  ${truncate(errorBody, 500)}`)
      }
      throw new Error(`API ${response.status}: ${errorBody}`)
    }

    // Cache + broadcast the rate-limit snapshot from THIS response.
    // The `quota-status` plugin's live-area slot subscribes to
    // `quota.headersReceived` (via its manifest's `refreshOn`) so the
    // footer updates within milliseconds of every successful API call :
    // no waiting for the 5-min heartbeat.
    broadcastResponseRateLimits(response.headers)

    // Non-streaming path (used in tests)
    if (!stream) {
      const raw = await response.text()
      const data = JSON.parse(raw) as {
        content: Array<{ type: string; text?: string }>
      }
      const text = data.content.find((c) => c.type === "text")?.text ?? ""
      yield text
      return {
        blocks: data.content as ContentBlock[],
        text,
        stopReason: "end_turn",
      }
    }

    // Streaming path : parse SSE and collect all content blocks
    if (!response.body) throw new Error("No response body for stream")

    const blocks: ContentBlock[] = []
    let currentBlock: Partial<ContentBlock> | null = null
    let fullText = ""
    let stopReason: string | null = null
    // stop_details (opus-4-7+): populated on stop_reason:"refusal" and
    // potentially other categorized stops the server may add. We
    // preserve verbatim and surface on StreamedResponse.stopDetails so
    // the host can route on the category without parsing prose.
    let stopDetails: { type: string; message?: string } | null = null
    let sawStreamEvent = false

    // Accumulators for the current block being streamed
    let thinkingSig = ""
    let toolJsonParts = ""

    // Per-block status tracking. We keep these around so input_json_delta
    // events (which don't repeat the tool name) can rebuild a useful label.
    let activeToolName = ""
    let lastStatusUpdateAt = 0
    let lastStatusBytes = 0
    const STATUS_THROTTLE_MS = 100
    const STATUS_THROTTLE_BYTES = 2048

    // Layer 4: per-block output-token estimate (chars/3.5 heuristic). The
    // Anthropic SSE stream doesn't include `output_tokens` until the final
    // `message_delta`, so to give the user a live `~215 tok · 84 tok/s`
    // segment in the activity infix we estimate from delta text/JSON length.
    // Reset on every content_block_start so each block (text, tool_use)
    // counts its own contribution — the activity-infix renderer composes
    // them per-block, not per-turn. The final `message_delta.usage.
    // output_tokens` (when present) overwrites the estimate so the trailing
    // glance lands on the truth.
    let outputChars = 0
    let lastTokenPublishAt = 0
    const TOKENS_PER_CHAR = 1 / 3.5 // ≈0.286 tok/char, matches our cache.ts heuristic

    // ------------------------------------------------------------------
    // Stream watchdog (per-attempt, paired with attemptAbort above).
    //
    // We want to detect:
    //   (a) idle: server stopped sending events but stream/connection
    //       didn't formally close. Observed 2026-05-25 in the wild:
    //       partial `thinking` block with no `signature_delta`, no
    //       `content_block_stop`, no `message_stop`, no `error`. Bun's
    //       HTTP/2 client doesn't surface this because TCP is alive
    //       and HTTP/2 PING frames keep flowing on the connection.
    //   (b) hard limit: an attempt that exceeds `attemptHardTimeoutMs`
    //       (default 30 min). Catches pathological hangs that never
    //       even reach idle (slow trickle of irrelevant frames).
    //
    // Both fire `attemptAbort.abort()` which tears down the underlying
    // request and unblocks `parseSSE`'s `for await`. We then throw a
    // tagged error from below; the outer `sendMessage` retries forever
    // (capped 5min backoff) per the harness-runs-forever principle.
    // ------------------------------------------------------------------
    let lastEventAt = Date.now()
    let messageStopReceived = false
    let watchdogAbortReason: "stream_idle" | "attempt_too_long" | null = null
    const attemptStartedAt = Date.now()
    const watchdogTimer = setInterval(() => {
      if (messageStopReceived || attemptAbort.signal.aborted) return
      const idleMs = Date.now() - lastEventAt
      const elapsedMs = Date.now() - attemptStartedAt
      if (idleMs >= streamIdleTimeoutMs) {
        watchdogAbortReason = "stream_idle"
        attemptAbort.abort()
      } else if (elapsedMs >= attemptHardTimeoutMs) {
        watchdogAbortReason = "attempt_too_long"
        attemptAbort.abort()
      }
    }, 1000)
    // Unref so the timer never blocks process exit (e.g. a test that
    // forgets to clean up still terminates). Bun + Node both honor this.
    if (typeof watchdogTimer.unref === "function") watchdogTimer.unref()

    try {
      for await (const event of parseSSE(response.body)) {
        lastEventAt = Date.now()
        if (!sawStreamEvent) {
          sawStreamEvent = true
          // Generic fallback : overridden by the per-block-type labels below
          // as soon as we see a content_block_start. Without this fallback, a
          // stream that begins with something unexpected would still show the
          // pre-stream label ("Waiting for response") indefinitely.
          requestStatus.update("Receiving stream")
        }
        switch (event.type) {
          case "error": {
            // Anthropic returns mid-stream errors as `event: error` over
            // HTTP 200 (overloaded_error, api_error, invalid_request_error,
            // …). Before this case existed the event fell through the
            // switch silently: the SSE stream closed, sendMessage
            // returned an empty { blocks: [], text: "", stopReason: null },
            // and the agent loop (agent.ts ~L1017) treated the empty
            // blocks as a natural end-of-turn — no scrollback, no
            // warning, no retry. See `~/.minimal-agent/.net-dbg/.../*-04-res-body.txt`
            // for the wire shape.
            //
            // We `diag.error(...)` first so all decoupled sinks
            // (FileLogSink, TuiDiagnosticSurface footer, the persistent
            // ScrollbackDiagnosticSink) render the failure in their own
            // surfaces. Then we throw a tagged Error so the agent's
            // outer turnError catch sees a real exception (and skips its
            // bare `error <msg>` fallback line — see
            // `isErrorDiagEmitted` in `diagnostic-bus.ts`).
            const errObj = (event as { error?: { type?: string; message?: string } }).error ?? {}
            const errType = errObj.type ?? "unknown_error"
            const errMessage = errObj.message ?? "stream error"
            const requestId = (event as { request_id?: string }).request_id
            diag.error("api.stream-error", `${errType}: ${errMessage}`, {
              "error-type": errType,
              ...(requestId ? { "request-id": requestId } : {}),
            })
            // Tag the error with the stream-error type so the retry
            // classifier (Stage B, below) can decide retryability without
            // parsing the message string. The marker survives normal
            // exception propagation; it never leaks into serialized
            // payloads (the property is intentionally enumerable since
            // it's stable user-facing metadata).
            const streamErr = markErrorAsDiagEmitted(
              new Error(`Anthropic stream error: ${errType} — ${errMessage}`),
            ) as Error & { streamErrorType?: string }
            streamErr.streamErrorType = errType
            throw streamErr
          }

          case "message_start": {
            // Anthropic returns the full `usage` payload right at message_start,
            // since cache lookup happens during prefill : before any output
            // tokens are generated. Use this to (a) print the per-turn cache
            // line under --debug and (b) feed the always-on anomaly detector.
            const usage = event.message?.usage as CacheUsage | undefined
            if (usage) {
              if (isDebug()) console.error(formatCacheLine(usage))
              detector.observe(usage, reqSnapshot)
              addSessionUsage(usage)
              // The earlier broadcast (right after response headers
              // arrived) updated the rate-limit cache and re-fired the
              // `quota-status` slot — but `addSessionUsage` had not run
              // yet, so that render had stale session totals. Re-emit
              // here, using the still-fresh cache, so the footer's
              // `✦ <N> tok` segment reflects THIS turn instead of
              // lagging by one.
              rebroadcastQuotaForSessionUpdate()
            }
            requestStatus.update("Receiving stream")
            break
          }

          case "content_block_start": {
            const cb = event.content_block
            if (!cb) break

            if (cb.type === "thinking") {
              const initialThinking = cb.thinking ?? ""
              currentBlock = {
                type: "thinking",
                thinking: initialThinking,
                signature: cb.signature ?? "",
              }
              thinkingSig = cb.signature ?? ""
              // Token estimate setup, symmetric with text + tool_use branches:
              // count thinking_delta characters into outputChars so the
              // activity infix shows `~N tok · M tok/s` during "Thinking" too
              // (not just during "Writing response"). Without this, long
              // adaptive-thinking blocks (a minute+ of silence on the wire
              // can be 10k+ tokens of hidden reasoning) showed bytes/host
              // but no token signal — user couldn't tell if the model was
              // generating slowly or stuck.
              outputChars = initialThinking.length
              lastTokenPublishAt = 0 // first delta always publishes
              requestStatus.update("Thinking")
              await onThinkingStart?.()
              if (initialThinking) await onThinkingDelta?.(initialThinking)
            } else if (cb.type === "tool_use") {
              currentBlock = {
                type: "tool_use",
                id: cb.id ?? "",
                name: cb.name ?? "",
                input: cb.input ?? {},
                caller: cb.caller,
              }
              toolJsonParts = ""
              activeToolName = cb.name ?? "tool"
              lastStatusBytes = 0
              lastStatusUpdateAt = Date.now()
              outputChars = 0
              // Reset to 0 (not Date.now()) so the FIRST delta of this
              // block always passes the throttle gate — gives the user
              // immediate first-token feedback instead of waiting for the
              // 100ms throttle window to elapse.
              lastTokenPublishAt = 0
              requestStatus.update(`Calling ${activeToolName}: streaming input`)
            } else if (cb.type === "text") {
              currentBlock = { type: "text", text: cb.text ?? "" }
              outputChars = 0
              lastTokenPublishAt = 0 // see comment above
              requestStatus.update("Writing response")
            }
            break
          }

          case "content_block_delta": {
            const d = event.delta
            if (!d) break

            if (d.type === "text_delta" && d.text) {
              if (currentBlock?.type === "text") {
                ;(currentBlock as TextBlock).text += d.text
              }
              fullText += d.text
              yield d.text
              outputChars += d.text.length
              // Throttled recvTokens publish. Mirrors the input_json_delta
              // throttle: at most ~10 emits/sec to the bus. The activity-infix
              // renderer pairs this with entryStartedAt to compute tok/s.
              // Without this, "Writing response" would show no live token
              // counter — the user couldn't tell a slow stream from a stuck
              // one. We don't update the label (the label stays "Writing
              // response" — the count goes into structured activity).
              const now = Date.now()
              if (now - lastTokenPublishAt >= STATUS_THROTTLE_MS) {
                lastTokenPublishAt = now
                requestStatus.updateActivity({
                  recvTokens: Math.round(outputChars * TOKENS_PER_CHAR),
                })
              }
            } else if (d.type === "thinking_delta" && d.thinking) {
              if (currentBlock?.type === "thinking") {
                ;(currentBlock as ThinkingBlock).thinking += d.thinking
              }
              await onThinkingDelta?.(d.thinking)
              outputChars += d.thinking.length
              // Same throttled recvTokens publish as text_delta — the
              // estimate isn't a billed count (Anthropic's thinking tokens
              // are also output_tokens, billed identically, so the ~3.5
              // chars/token heuristic applies symmetrically). Without this
              // mirror, "Thinking" status row shows everything BUT the
              // token signal — defeats the whole point of Layer 4 for the
              // longest visible phase of a turn.
              const now = Date.now()
              if (now - lastTokenPublishAt >= STATUS_THROTTLE_MS) {
                lastTokenPublishAt = now
                requestStatus.updateActivity({
                  recvTokens: Math.round(outputChars * TOKENS_PER_CHAR),
                })
              }
            } else if (d.type === "signature_delta" && d.signature) {
              thinkingSig += d.signature
              if (currentBlock?.type === "thinking") {
                ;(currentBlock as ThinkingBlock).signature = thinkingSig
              }
            } else if (d.type === "input_json_delta" && d.partial_json != null) {
              toolJsonParts += d.partial_json
              outputChars = toolJsonParts.length
              // Throttled status update : every ~2KB of accumulated JSON or
              // every ~100ms, whichever fires first. Without throttling we'd
              // re-render the spinner line on every delta (potentially hundreds
              // per second for a fast tool block).
              const now = Date.now()
              const grewEnough = toolJsonParts.length - lastStatusBytes >= STATUS_THROTTLE_BYTES
              const elapsedEnough = now - lastStatusUpdateAt >= STATUS_THROTTLE_MS
              if (grewEnough || elapsedEnough) {
                lastStatusBytes = toolJsonParts.length
                lastStatusUpdateAt = now
                lastTokenPublishAt = now
                const hint = extractToolHint(activeToolName, toolJsonParts)
                const size = formatBytes(toolJsonParts.length)
                const label = hint
                  ? `Calling ${activeToolName}: ${hint} (${size})`
                  : `Calling ${activeToolName}: streaming input (${size})`
                // Update the label AND the structured token estimate in one
                // shot. The renderer picks up both on the next paint.
                requestStatus.update(label, {
                  activity: { recvTokens: Math.round(outputChars * TOKENS_PER_CHAR) },
                })
              }
            }
            break
          }

          case "content_block_stop": {
            if (currentBlock) {
              const stoppedThinking = currentBlock.type === "thinking"
              const stoppedText = currentBlock.type === "text"
              const stoppedToolUse = currentBlock.type === "tool_use"
              // Finalize tool_use: parse accumulated JSON into input
              if (currentBlock.type === "tool_use" && toolJsonParts) {
                try {
                  ;(currentBlock as ToolUseBlock).input = JSON.parse(toolJsonParts)
                } catch {
                  // partial JSON : keep what we have
                  ;(currentBlock as ToolUseBlock).input = { _raw: toolJsonParts }
                }
              }
              blocks.push(currentBlock as ContentBlock)
              if (stoppedThinking) await onThinkingStop?.()
              // Fire onTextStop AFTER the block is pushed onto `blocks`, so
              // a handler that walks `blocks[]` sees the just-finished text
              // block. Symmetric with `onThinkingStop`. See the option's
              // doc-comment for why hosts care about this seam.
              if (stoppedText) await onTextStop?.()
              if (stoppedToolUse && activeToolName) {
                requestStatus.update(`Calling ${activeToolName}: dispatching`)
              }
            }
            currentBlock = null
            toolJsonParts = ""
            thinkingSig = ""
            activeToolName = ""
            break
          }

          case "message_delta": {
            if (event.delta?.stop_reason) {
              stopReason = event.delta.stop_reason
            }
            // stop_details: opaque categorization the server may attach
            // to refusal / pause / context-window-exceeded stops. We
            // pass through verbatim — the host decides what to do with
            // `{type, message?}`. New in opus-4-7+ (see
            // private/research/2026-05-28-llm-providers/02-wire-snapshots.md).
            const sd = (
              event.delta as unknown as {
                stop_details?: { type?: string; message?: string } | null
              }
            )?.stop_details
            if (sd && typeof sd.type === "string") {
              stopDetails =
                sd.message !== undefined
                  ? { type: sd.type, message: sd.message }
                  : { type: sd.type }
            }
            // Anthropic sometimes ships the final `output_tokens` count in a
            // `message_delta` near the end of the stream. When present, it's
            // the authoritative number — swap our chars/3.5 estimate for the
            // truth so the last visible token count lands on the billed
            // value. The status row clears very shortly after this (the SSE
            // loop is wrapping up), so the user often won't even see the
            // swap — but when they do, it's accurate.
            const finalOut = (event as { usage?: { output_tokens?: number } }).usage?.output_tokens
            if (typeof finalOut === "number" && finalOut > 0) {
              requestStatus.updateActivity({ recvTokens: finalOut })
            }
            break
          }

          // Terminator. Servers SHOULD send this; the absence of it is what
          // the stream-idle watchdog above guards against.
          case "message_stop": {
            messageStopReceived = true
            break
          }
        }
      }
    } finally {
      clearInterval(watchdogTimer)
    }

    // If the stream closed without `message_stop` it's either:
    //   1. Our watchdog tripped (idle / hard-timeout): `watchdogAbortReason`
    //      is set and `attemptAbort.signal.aborted` is true.
    //   2. The server closed the response body cleanly but never sent the
    //      terminator. Same observable shape as (1) from our POV, but the
    //      cause is the upstream truncation we tracked down on 2026-05-25.
    // Either case → throw a tagged retryable error so the outer
    // `sendMessage` re-tries. The harness keeps going.
    if (!messageStopReceived) {
      type AbortCode = "stream_idle" | "attempt_too_long" | "stream_truncated"
      const code: AbortCode = (watchdogAbortReason ?? "stream_truncated") as AbortCode
      const requestId = response.headers.get("request-id") ?? response.headers.get("x-request-id")
      const cfRay = response.headers.get("cf-ray")
      const idleMs = Date.now() - lastEventAt
      const elapsedMs = Date.now() - attemptStartedAt
      const message =
        code === "stream_idle"
          ? `no SSE event received for ${(idleMs / 1000).toFixed(1)}s — aborting (request stalled mid-stream, no message_stop)`
          : code === "attempt_too_long"
            ? `attempt exceeded ${(elapsedMs / 1000).toFixed(0)}s — aborting`
            : `stream ended without message_stop after ${(elapsedMs / 1000).toFixed(1)}s (server truncated the SSE response)`

      diag.warn("api.stream-stalled", message, {
        "error-type": code,
        ...(requestId ? { "request-id": requestId } : {}),
        ...(cfRay ? { "cf-ray": cfRay } : {}),
        "idle-ms": idleMs,
        "elapsed-ms": elapsedMs,
        "blocks-received": blocks.length,
      })

      const err = markErrorAsDiagEmitted(
        new Error(`Anthropic stream ${code}: ${message}`),
      ) as Error & { streamErrorType?: string }
      err.streamErrorType = code
      throw err
    }

    return { blocks, text: fullText, stopReason, stopDetails }
  } finally {
    requestStatus.clear()
    networkActivityObserver.detach(reqId)
  }
}

// ---------------------------------------------------------------------------
// sendMessage : retry coordinator around sendMessageOnce
// ---------------------------------------------------------------------------

/**
 * Stream-level error types we retry. EVERY entry here is retried
 * indefinitely (the outer loop has no max-attempts, no deadline) — this
 * set just decides the BACKOFF CURVE, not whether to give up.
 *
 *   - `overloaded_error` / `api_error`: Anthropic emits these as
 *     `event: error` SSE frames over HTTP 200 (see the `case "error":`
 *     arm in `sendMessageOnce`). Transient capacity / dispatcher.
 *   - `stream_idle` / `stream_truncated` / `attempt_too_long`:
 *     synthesized by our stream watchdog (see `sendMessageOnce`) when
 *     the server stops sending events without a `message_stop`
 *     terminator. Observed 2026-05-25 as the actual root cause of
 *     hour-long agent hangs.
 *
 * "Hard" error types (validation, auth, not-found) get a SLOWER curve
 * (`SLOW_RETRY_TYPES` below) so a code-level bug doesn't burn through
 * retries — but they still retry, because a human might fix the
 * config while the harness waits patiently.
 */
const RETRYABLE_STREAM_ERROR_TYPES: ReadonlySet<string> = new Set([
  "overloaded_error",
  "api_error",
  "stream_idle",
  "stream_truncated",
  "attempt_too_long",
])

/**
 * Slow-curve retry types. These ARE retried (the harness never gives
 * up unprompted), but the per-attempt backoff starts at 30s instead of
 * 200ms because a single attempt is unlikely to flip these without an
 * out-of-band fix (rotating a token, fixing a config, etc).
 */
const SLOW_RETRY_TYPES: ReadonlySet<string> = new Set([
  "invalid_request_error",
  "permission_error",
  "not_found_error",
])

/**
 * Retry timing.
 *
 * Harness principle: the agent loop retries until the model is done,
 * the user aborts, or the process is killed. Never bounded by attempt
 * count or wall-clock — long-running tasks run for hours, days, weeks.
 *
 *   - Fast curve (transient): 0.2s → 0.5 → 1 → 2 → 5 → 10 → 20 → 30 →
 *     60 → 120 → 300s (cap, forever).
 *   - Slow curve (hard): 30s → 60 → 120 → 300s (cap, forever).
 *
 * Cap of 5 min keeps the diag log honest (≈12 retries/hour) without
 * burning cycles.
 */
const RETRY_FAST_BASE_DELAY_MS = 200
const RETRY_SLOW_BASE_DELAY_MS = 30_000
const RETRY_MAX_DELAY_MS = 5 * 60_000

/**
 * How often to emit the "still retrying" scrollback warning. Set so
 * that at the 5-min cap the user sees one warning per hour — enough
 * to know the agent is alive and waiting, not so many that an outage
 * fills scrollback.
 */
const RETRY_SUSTAINED_WARN_EVERY = 12

/**
 * Send a message to the Messages API. Retries indefinitely on
 * transient + slow-curve errors.
 *
 * # Harness principle
 *
 * The agent loop must run as long as the model needs to run — minutes,
 * hours, days, weeks. The harness never bounds attempts, never bounds
 * total wall-clock, never asks the user what to do. It just keeps
 * retrying with capped exponential backoff (5min ceiling) and surfaces
 * the situation through `diag.*` so a human checking in sees clearly
 * what's happening.
 *
 * # Behavior
 *
 *   1. Drains `sendMessageOnce` one attempt's worth.
 *   2. On a retryable throw (see `RETRYABLE_STREAM_ERROR_TYPES` and
 *      `SLOW_RETRY_TYPES`), backoff and try again. Forever.
 *   3. If we had already yielded text deltas to the caller before the
 *      failure, we emit a visible `↳ retrying after stall …` marker
 *      into the stream so scrollback shows where attempt N ended and
 *      attempt N+1 begins. We still retry — the user perceives a
 *      labeled boundary, not silent duplication.
 *   4. Permanent errors (non-retryable type) re-throw to the caller.
 *      Currently this only catches errors that don't carry a
 *      `streamErrorType` tag at all (programmer bugs, kernel-level
 *      failures, etc).
 *
 * # Scrollback surface (rendered by `ScrollbackDiagnosticSink`)
 *
 *   - `⚠ warn  api.stream-stalled · HH:MM:SS` — fired by sendMessageOnce
 *     when the watchdog trips (idle / truncated / attempt_too_long).
 *   - `⚠ warn  api.retry · HH:MM:SS` — fired here on each retry attempt.
 *   - `⚠ warn  api.retry-sustained · HH:MM:SS` — fired every
 *     `RETRY_SUSTAINED_WARN_EVERY` retries; tells the user the harness
 *     is alive and patient.
 *   - `⚠ warn  api.retry-success · HH:MM:SS` — fired once when an
 *     attempt finally succeeds after at least one retry. Tells the user
 *     "the stall is over, we're back" before the new content streams.
 *
 * @yields Streamed text deltas from the in-flight attempt, plus the
 *   `↳ retrying …` marker when retrying mid-yield.
 */
export async function* sendMessage(
  opts: SendOptions,
): AsyncGenerator<string, StreamedResponse, undefined> {
  let hasYielded = false
  const startedAt = Date.now()
  let lastStreamErrType: string | undefined

  for (let attempt = 1; ; attempt++) {
    try {
      const gen = sendMessageOnce(opts)
      // We can't `yield*` the inner generator because we need to
      // observe each yield to flip `hasYielded` (the retry-marker
      // gate). The manual drain pattern preserves both yield order
      // AND the generator's final return value.
      let result: IteratorResult<string, StreamedResponse>
      while (!(result = await gen.next()).done) {
        hasYielded = true
        yield result.value
      }
      // Recovery message: only fire if we actually retried.
      if (attempt > 1) {
        const totalMs = Date.now() - startedAt
        diag.warn(
          "api.retry-success",
          `recovered after ${attempt - 1} retr${attempt - 1 === 1 ? "y" : "ies"} (${formatElapsedLong(totalMs)} total) — last error ${lastStreamErrType ?? "unknown"}`,
          {
            attempt,
            retries: attempt - 1,
            "elapsed-ms": totalMs,
            "last-error": lastStreamErrType ?? "unknown",
          },
        )
      }
      return result.value
    } catch (err) {
      const streamErrType = (err as Error & { streamErrorType?: string }).streamErrorType
      const elapsedMs = Date.now() - startedAt
      // Harness principle: every tagged stream error is retryable
      // forever. Untagged errors (programmer bugs, kernel panics, OOM)
      // re-throw — those are not "the network is slow today", they're
      // genuine failures that should propagate.
      const retryable =
        streamErrType !== undefined &&
        (RETRYABLE_STREAM_ERROR_TYPES.has(streamErrType) || SLOW_RETRY_TYPES.has(streamErrType))

      if (!retryable) throw err
      lastStreamErrType = streamErrType

      // Slow curve for hard errors (validation, auth, not-found) so a
      // code-level bug doesn't blast the API. Slow base × 2^attempt,
      // capped at 5min. Full-jitter random in [0, ideal) so concurrent
      // agents desynchronize.
      const slow = SLOW_RETRY_TYPES.has(streamErrType)
      const base = slow ? RETRY_SLOW_BASE_DELAY_MS : RETRY_FAST_BASE_DELAY_MS
      // Cap the exponent so 2^N doesn't overflow on attempt 50.
      const cappedExp = Math.min(attempt - 1, 16)
      const ideal = Math.min(RETRY_MAX_DELAY_MS, base * 2 ** cappedExp)
      const delayMs = Math.floor(Math.random() * ideal)
      const nextAttempt = attempt + 1

      diag.warn(
        "api.retry",
        `${streamErrType}: retrying attempt ${nextAttempt} after ${(delayMs / 1000).toFixed(1)}s — ${formatElapsedLong(elapsedMs)} elapsed so far`,
        {
          "error-type": streamErrType,
          attempt: nextAttempt,
          "delay-ms": delayMs,
          "elapsed-ms": elapsedMs,
          curve: slow ? "slow" : "fast",
        },
      )

      // Sustained-retry heartbeat: every Nth retry emit a louder
      // diag warning so a human checking in sees "agent has been
      // waiting patiently for a while". Fires from attempt 12 onward.
      if (attempt > 1 && (attempt - 1) % RETRY_SUSTAINED_WARN_EVERY === 0) {
        diag.warn(
          "api.retry-sustained",
          `still retrying — ${attempt - 1} attempts, stuck for ${formatElapsedLong(elapsedMs)}, last error ${streamErrType}`,
          {
            attempt,
            retries: attempt - 1,
            "elapsed-ms": elapsedMs,
            "last-error": streamErrType,
            curve: slow ? "slow" : "fast",
          },
        )
      }

      // If we already streamed text to the UI, paint a visible
      // boundary in scrollback. Without this the user sees attempt
      // N's partial text + attempt N+1's (possibly divergent) text
      // glued together with no marker. The marker keeps the
      // history honest — the user can see where the model retried.
      if (hasYielded) {
        yield `\n↳ stream stalled — retrying (attempt ${nextAttempt})…\n`
      }

      // Keep the live status row populated during sleep. Without this
      // the user sees the previous attempt's status clear and then a
      // blank bar for up to 5 min.
      const retryStatus = GLOBAL_STATUS_BUS.create(
        `Retrying after ${streamErrType} (attempt ${nextAttempt}) — sleeping ${(delayMs / 1000).toFixed(1)}s…`,
        { notificationId: "network.retry", category: "network" },
      )
      try {
        await abortableSleep(delayMs, opts.signal)
      } finally {
        retryStatus.clear()
      }
      // Fall through to the next loop iteration: a fresh sendMessageOnce
      // with the (possibly refreshed) auth token from the prior attempt.
    }
  }
}

/**
 * Format a millisecond duration as a human-readable elapsed time.
 * `12s`, `1m 47s`, `2h 13m`, `1d 4h`. Used in diag warnings during
 * long retry chains where a numeric ms is unfriendly.
 */
function formatElapsedLong(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const minutes = Math.floor((totalSec % 3600) / 60)
  const seconds = totalSec % 60
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

// ---------------------------------------------------------------------------
// listModels : fetch available models for this user
// ---------------------------------------------------------------------------

/** Endpoint for listing available models. */
const MODELS_URL = "https://api.anthropic.com/v1/models?beta=true"

/**
 * List models available to the authenticated user, plus synthesized
 * `[1m]` context-window variants.
 *
 * Calls `GET /v1/models?beta=true` (matching the Anthropic SDK's `list()`
 * method) to fetch the real model list, then appends `[1m]`-suffixed copies
 * for any model that supports the 1M context window. The suffix is a
 * client-side convention : the API itself doesn't know about it. The
 * `--list-models` CLI flag uses this expanded list so users can pick
 * `claude-opus-4-7[1m]` from the menu and get 1M context automatically.
 *
 * @param auth Authenticated credentials
 * @param networkClient Network client used for the models request.
 * @returns Array of {@link ModelInfo}, with `[1m]` variants appended
 *
 * @see cc-03312026/src/utils/context.ts:modelSupports1M()
 */
export async function listModels(
  auth: AuthResult,
  networkClient: NetworkClient = defaultNetworkClient,
): Promise<ModelInfo[]> {
  const sessionId = getSessionId()
  const headers = buildHeaders(auth, sessionId)

  debugHeader(`GET ${MODELS_URL}`)

  const response = await networkClient.request({
    label: "models.list",
    method: "GET",
    url: MODELS_URL,
    headers,
  })

  debugResponse(response.status, response.headers)

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Models API ${response.status}: ${errorBody}`)
  }

  const data = await response.json<{ data: ModelInfo[] }>()
  const models = data.data

  // Synthesize 1M context variants for models that support it.
  // The CLI uses a client-side [1m] suffix convention : these aren't separate
  // API model IDs. The actual 1M activation happens via the context-1m-2025-08-07
  // beta flag. See cc-03312026/src/utils/context.ts:modelSupports1M().
  //
  // 1M-capable families (as of 2026-05-28 / claude-code 2.1.154):
  //   - Sonnet 4 / 4.5 / 4.6  (sonnet-4 substring match)
  //   - Opus 4.6 / 4.7 / 4.8  (each gated explicitly to avoid catching
  //     older opus-4-0/4-1 ids which were 200k)
  const supports1M = (id: string) =>
    id.includes("claude-sonnet-4") ||
    id.includes("opus-4-6") ||
    id.includes("opus-4-7") ||
    id.includes("opus-4-8")

  const variants: ModelInfo[] = []
  for (const m of models) {
    if (supports1M(m.id)) {
      variants.push({
        ...m,
        id: `${m.id}[1m]`,
        display_name: m.display_name ? `${m.display_name} (1M context)` : `${m.id} (1M context)`,
      })
    }
  }

  return [...models, ...variants]
}

// ---------------------------------------------------------------------------
// sendMessageSync : convenience, collects full response
// ---------------------------------------------------------------------------

/**
 * Send a message and return the concatenated text as a single string.
 *
 * Convenience wrapper around {@link sendMessage} that consumes the entire
 * stream and returns just the text. Use this when you don't care about
 * structured blocks or live streaming : e.g. in tests, or for simple
 * one-shot prompts.
 *
 * @param opts - Same options as {@link sendMessage}
 * @returns Concatenated text from all `text_delta` events
 *
 * @example
 * ```ts
 * const reply = await sendMessageSync({ auth, messages: [...] });
 * console.log(reply);
 * ```
 */
export async function sendMessageSync(opts: SendOptions): Promise<string> {
  let result = ""
  const gen = sendMessage(opts)
  while (true) {
    const { done, value } = await gen.next()
    if (done) break
    result += value
  }
  return result
}

/**
 * Send a message and return the full {@link StreamedResponse} with all blocks.
 *
 * Convenience wrapper around {@link sendMessage} that drains the stream and
 * returns the structured response. Use this when you need access to thinking
 * blocks, tool_use blocks, or the stop reason : not just the text.
 *
 * @param opts - Same options as {@link sendMessage}
 * @returns Full structured response (blocks + text + stopReason)
 *
 * @example
 * ```ts
 * const result = await sendMessageFull({ auth, messages, tools: TOOL_DEFINITIONS });
 * if (result.stopReason === "tool_use") {
 *   const toolCalls = result.blocks.filter(b => b.type === "tool_use");
 *   // ... execute tools and continue
 * }
 * ```
 */
export async function sendMessageFull(opts: SendOptions): Promise<StreamedResponse> {
  const gen = sendMessage(opts)
  let lastReturn: StreamedResponse | undefined
  while (true) {
    const next = await gen.next()
    if (next.done) {
      lastReturn = next.value
      break
    }
  }
  return lastReturn ?? { blocks: [], text: "", stopReason: null }
}

// ---------------------------------------------------------------------------
// Quota check : cheap haiku request to verify account has quota
// ---------------------------------------------------------------------------

/**
 * Send a minimal quota-check request to verify the account has quota.
 *
 * Mirrors the real CLI's startup behavior (capture: fetch-002): a cheap
 * haiku request with `max_tokens: 1` and the literal string `"quota"` as
 * the user message. No system prompt, no tools, no thinking, no
 * output_config : just the bare minimum to round-trip the API and surface
 * a 429/auth error early before the user types anything.
 *
 * Uses the `"quota"` request type which sends only 5 beta flags (no
 * `claude-code-20250219`, no conversation-specific flags).
 *
 * **Catches all errors** and returns false on any failure (including
 * network errors). Use {@link sendMessage} directly if you need the actual
 * error message.
 *
 * @param auth Authenticated credentials
 * @param networkClient Network client used for the quota request.
 * @returns True if the request succeeded (200 OK), false on any error
 */
export type QuotaResult = { ok: false } | { ok: true; rateLimits: Map<string, string> }

/**
 * Absolute upper bound on a single `checkQuota` probe (covers send + TTFB +
 * read). The probe is low-stakes and re-driven by the live-area scheduler /
 * startup, so a tight bound is correct: better a context-only footer for one
 * tick than a wedged probe. Composed with any caller signal (first to fire
 * wins).
 */
const QUOTA_PROBE_TIMEOUT_MS = 15_000

/**
 * Probe the Anthropic API for the current quota / rate-limit state. Returns
 * `{ok: true, rateLimits}` on a 200 (with the parsed `anthropic-ratelimit-*`
 * headers), or `{ok: false}` on any error.
 *
 * Always bounded: an internal {@link QUOTA_PROBE_TIMEOUT_MS} deadline guarantees
 * the probe can't hang even when `signal` is omitted (see `probeSignal` below).
 */
export async function checkQuota(
  auth: AuthResult,
  networkClient: NetworkClient = defaultNetworkClient,
  signal?: AbortSignal,
): Promise<QuotaResult> {
  const sessionId = getSessionId()
  const headers = buildHeaders(auth, sessionId, "quota")
  const metadata = buildMetadata(auth)

  const body = {
    model: "claude-haiku-4-5-20251001",
    max_tokens: 1,
    messages: [{ role: "user", content: "quota" }],
    metadata,
  }

  debugHeader("POST (quota check)")
  debugKV("model", body.model)

  const serializedBody = JSON.stringify(body)
  // Rock-solid bound: the probe ALWAYS has a deadline, even when the caller
  // passes no signal (e.g. the startup-tree row). Without this, a quota probe
  // stalled before response headers (stalled upload / black-holed socket)
  // would hang `doRequest` forever — the same class of bug fixed for the chat
  // path's TTFB guard. The internal timeout aborts the request at the network
  // layer (and the transport's abort escalation evicts a wedged HTTP/2
  // session). When the caller DOES pass a signal (the live-area slot passes
  // `ctx.abort`, driven by `LiveAreaScheduler.timeoutMs`), whichever fires
  // first wins. Either way `doRequest` rejects with an AbortError, `checkQuota`
  // returns `{ ok: false }`, and the footer/startup degrade gracefully.
  const probeSignal: AbortSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(QUOTA_PROBE_TIMEOUT_MS)])
    : AbortSignal.timeout(QUOTA_PROBE_TIMEOUT_MS)
  const doRequest = async (token: string) => {
    const h = { ...headers }
    if (h.authorization) h.authorization = `Bearer ${token}`
    else if (h["x-api-key"]) h["x-api-key"] = token

    return networkClient.request({
      label: "quota.check",
      method: "POST",
      url: API_URL,
      headers: h,
      body: serializedBody,
      signal: probeSignal,
    })
  }

  try {
    let response = await doRequest(auth.token)

    // 401 retry : same multi-process keychain-first mitigation as in
    // `sendMessage` above (see the long comment at the main 401 site).
    // checkQuota fires from the live-area `quota-status` plugin's
    // heartbeat AND on every `quota.headersReceived` event; with 100s of
    // agents, this path is one of the biggest contributors to refresh
    // contention if we don't deduplicate.
    if (response.status === 401 && auth.refresh) {
      let recovered = false
      try {
        const fresh = readCredentials()
        const freshToken = fresh?.claudeAiOauth?.accessToken
        if (freshToken && freshToken !== auth.token) {
          auth.token = freshToken
          response = await doRequest(freshToken)
          if (response.ok) recovered = true
        }
      } catch {
        // best-effort; fall through to refresh
      }
      if (!recovered && response.status === 401) {
        const refreshed = await auth.refresh()
        response = await doRequest(refreshed.token)
        auth.token = refreshed.token
      }
    }

    debugResponse(response.status, response.headers)

    if (!response.ok) {
      const errorBody = await response.text()
      if (isDebug()) {
        debugHeader(c.red(`Quota check failed: ${response.status}`))
        console.error(`  ${errorBody.slice(0, 200)}`)
      }
      return { ok: false }
    }

    // Same broadcast as the main completion path : cache + bus emit.
    // `checkQuota` is called both at startup (when the plugin is
    // disabled) and as the live-area slot's cold-cache fallback, so
    // populating the cache here closes the loop if a later request
    // arrives before any chat completion happens.
    const rateLimits = broadcastResponseRateLimits(response.headers)
    return { ok: true, rateLimits }
  } catch (e) {
    if (isDebug()) {
      console.error(`  quota check error: ${e instanceof Error ? e.message : String(e)}`)
    }
    return { ok: false }
  }
}
