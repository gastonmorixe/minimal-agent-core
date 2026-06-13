/**
 * Transient transport-error classifier.
 *
 * The forever-retry loops (`sendMessage` in `client.ts` and its canonical
 * twin `withRetry` in `llm/transport/retry.ts`) decide retryability from an
 * error's `streamErrorType` tag. That tag is attached to in-stream
 * `event: error` frames, failed HTTP statuses, and the stream watchdog's idle /
 * truncation trips. None of those cover a failure that happens BEFORE a
 * response exists: a TCP connect timeout, a reset socket, a DNS blip, an
 * HTTP/2 GOAWAY mid-dial. Those throw a plain, untagged `Error` straight out
 * of the transport, so the retry loop treated them as a genuine bug and
 * propagated — stopping the agent.
 *
 * That was the hole behind:
 *
 *     error  HTTP/2 connect timeout for https://api.anthropic.com
 *
 * which killed a turn after two clean `stream_idle` retries (2026-06-01).
 * Connect-phase failures are exactly as transient as stream-phase ones; the
 * harness must retry them forever too.
 *
 * This module recognizes the connection-level failures that should feed the
 * forever-retry loop and tags them with {@link TRANSIENT_NETWORK_STREAM_ERROR_TYPE}.
 * A user abort (`AbortError`) is deliberately NOT transient — it must
 * propagate as a real cancel — so it is excluded even when its message would
 * otherwise match.
 *
 * @module network/transient-error
 */

/**
 * `streamErrorType` tag for a connection-level transient failure. Lives in
 * the FAST retry curve (a fresh dial usually recovers in well under a
 * second), so both retry coordinators classify it like `overloaded_error`.
 */
export const TRANSIENT_NETWORK_STREAM_ERROR_TYPE = "network_error"

/**
 * `error.code` values (Node/libuv errno + Node http2 + undici) that mean
 * "the connection itself failed transiently". Matched case-sensitively
 * against `err.code` walking the `cause` chain.
 */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  // libuv / POSIX socket + DNS
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "EADDRNOTAVAIL",
  "EPROTO",
  "ENOTFOUND", // DNS: name did not resolve (often a transient resolver hiccup)
  "EAI_AGAIN", // DNS: temporary failure in name resolution
  // Node http2 session/stream teardown
  "ERR_HTTP2_GOAWAY_SESSION",
  "ERR_HTTP2_INVALID_SESSION",
  "ERR_HTTP2_STREAM_CANCEL",
  "ERR_HTTP2_STREAM_ERROR",
  "ERR_HTTP2_SESSION_ERROR",
  "ERR_SOCKET_CONNECTION_TIMEOUT",
  // undici (Bun fetch fallback)
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
])

/**
 * Substrings matched (case-insensitively) against the error message + one
 * level of `cause` message. These cover errors whose `code` is absent or
 * non-standard — notably our own transport's thrown strings
 * (`HTTP/2 connect timeout`, `HTTP/2 session closed before connect`,
 * `HTTP/2 ALPN negotiation failed`) and the common runtime phrasings
 * (`socket hang up`, undici's `other side closed` / `terminated`, Bun's
 * `fetch failed`).
 */
const TRANSIENT_MESSAGE_PATTERN =
  /\b(ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|ENETUNREACH|ENETDOWN|ENETRESET|EHOSTUNREACH|EHOSTDOWN|EADDRNOTAVAIL|EPROTO|ENOTFOUND|EAI_AGAIN)\b|socket hang up|connect timeout|connection timeout|session closed before connect|alpn negotiation failed|client network socket disconnected|other side closed|fetch failed|network (request )?failed|connection reset|connection closed|goaway|stream (was )?(closed|cancelled|canceled)|premature close|terminated/i

/** True iff `err` (or a wrapped DOMException) is a user/abort cancellation. */
function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false
  const name = (err as { name?: unknown }).name
  if (name === "AbortError" || name === "TimeoutError") return true
  const code = (err as { code?: unknown }).code
  return code === "ABORT_ERR"
}

/**
 * Walk `err.cause` up to `maxDepth` levels, invoking `visit` on each node
 * (including the root). Stops early when `visit` returns `true`.
 */
function someInCauseChain(err: unknown, visit: (node: object) => boolean, maxDepth = 5): boolean {
  let node = err
  for (let depth = 0; depth <= maxDepth; depth++) {
    if (!node || typeof node !== "object") return false
    if (visit(node)) return true
    node = (node as { cause?: unknown }).cause
  }
  return false
}

/** Collect the message text of the error + its cause chain into one string. */
function chainMessage(err: unknown): string {
  const parts: string[] = []
  someInCauseChain(err, (node) => {
    const msg = (node as { message?: unknown }).message
    if (typeof msg === "string" && msg.length > 0) parts.push(msg)
    const code = (node as { code?: unknown }).code
    if (typeof code === "string" && code.length > 0) parts.push(code)
    return false // visit every level
  })
  if (parts.length === 0 && typeof err === "string") parts.push(err)
  return parts.join(" ")
}

/**
 * Classify whether `err` is a transient CONNECTION-level failure that the
 * forever-retry loop should swallow and retry (vs. a genuine bug that must
 * propagate).
 *
 * Returns `false` for:
 *  - user aborts / cancellation (`AbortError`, `ABORT_ERR`),
 *  - anything that already carries a `streamErrorType` tag (the existing
 *    classifier owns those — we must not double-classify and override an
 *    explicit `retryable: false`),
 *  - errors with no recognizable transient signal.
 *
 * @param err - The thrown value from a send attempt.
 * @returns true when the error is a retryable transient transport failure.
 */
export function isTransientNetworkError(err: unknown): boolean {
  if (isAbortError(err)) return false
  // An already-tagged error is owned by the stream-error classifier; leave it
  // alone so a deterministic `retryable: false` verdict still wins.
  if (typeof (err as { streamErrorType?: unknown } | null)?.streamErrorType === "string") {
    return false
  }

  // Strongest signal: a known errno / http2 / undici code anywhere in the
  // cause chain.
  const codeHit = someInCauseChain(err, (node) => {
    const code = (node as { code?: unknown }).code
    return typeof code === "string" && TRANSIENT_ERROR_CODES.has(code)
  })
  if (codeHit) return true

  // Fallback: match the combined message text (covers our transport's thrown
  // strings and runtimes that omit `code`).
  const msg = chainMessage(err)
  return msg.length > 0 && TRANSIENT_MESSAGE_PATTERN.test(msg)
}

/**
 * If `err` is a transient transport failure, tag it with
 * {@link TRANSIENT_NETWORK_STREAM_ERROR_TYPE} so the retry coordinator
 * classifies it as retryable, then return it. A non-transient error is returned
 * unchanged.
 *
 * The error object is tagged IN PLACE (the tag is an additive property and the
 * object is already on its way out of the transport). Callers in `client.ts`
 * and `retry.ts` rely on the returned reference being the same object, so the
 * stack and cause chain stay intact for diagnostics.
 *
 * @param err - The thrown value from a send attempt.
 * @returns `err`, tagged in place when transient.
 */
export function tagTransientNetworkError(err: unknown): unknown {
  if (err && typeof err === "object" && isTransientNetworkError(err)) {
    ;(err as { streamErrorType?: string }).streamErrorType = TRANSIENT_NETWORK_STREAM_ERROR_TYPE
  }
  return err
}
