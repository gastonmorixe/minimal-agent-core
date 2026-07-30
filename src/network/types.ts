export type NetworkMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

export type NetworkProtocol = "http/1.1" | "h2" | "h3" | "ws" | "webrtc"

export interface NetworkTransportInfo {
  id: string
  protocol?: NetworkProtocol
  origin?: string
  reused?: boolean
  fallbackUsed?: boolean
}

export interface NetworkCaptureOptions {
  requestBody?: string | null
  responseBody?: boolean
}

export interface NetworkRequestLifecycle {
  /** Response headers became available for this exact wire request. */
  onResponse?: (response: NetworkResponse) => void
  /** A non-empty response-body chunk crossed the NetworkClient tap. */
  onBodyChunk?: (chunk: Uint8Array, response: NetworkResponse) => void
  /** The response body closed normally. */
  onEnd?: (response: NetworkResponse) => void
  /** The request or response body failed. */
  onError?: (error: unknown) => void
}

export interface NetworkRequest {
  id: string
  label: string
  method: NetworkMethod
  url: string
  headers?: Record<string, string>
  body?: string | Uint8Array
  signal?: AbortSignal
  timeoutMs?: number
  allowFetchFallback?: boolean
  capture?: NetworkCaptureOptions
  transportHint?: string
  /**
   * Optional per-request protocol pin. When set, the
   * {@link NetworkClient} routes to the matching transport in its
   * `transports` map instead of `primary`. Falls back to `primary`
   * when no matching transport is registered.
   *
   * - `"h2"`     → Http2Transport
   * - `"h3"`     → Http3Transport (requires Bun ≥ 1.3.14)
   * - `"http/1.1"` → FetchTransport
   *
   * Caller-set values are sticky: policies will not overwrite an
   * explicit pin. Unset (`undefined`) lets opportunistic policies
   * (e.g. {@link http3OpportunisticPolicy}) negotiate per origin.
   */
  protocol?: NetworkProtocol
  /**
   * Free-form labels a {@link NetworkPolicy} can match on. Opaque to
   * the network layer itself; conventional tags include the origin
   * shorthand (`"anthropic"`, `"github"`), the calling plugin
   * (`"plugin:web-search"`), or a workload class (`"interactive"`,
   * `"background"`). Defaults to an empty array.
   */
  policyTags?: ReadonlyArray<string>
  /**
   * Request-local lifecycle taps. Unlike global observers, these belong to one
   * exact wire request, so a concurrent quota/auth probe cannot impersonate an
   * LLM stream. The client invokes body activity at the same tap boundary used
   * by net-dbg and the activity observer.
   */
  lifecycle?: NetworkRequestLifecycle
  /**
   * When true, keep the HTTP/2 request stream writable after the initial
   * `body` write so callers can send more bytes via
   * {@link NetworkResponse.writeRequestBody} (Connect bidi).
   */
  keepRequestOpen?: boolean
}

/**
 * Pre/post-flight middleware around each {@link NetworkClient.request}.
 *
 * A policy can rewrite the outgoing request (`onRequest`), peek at or
 * substitute the response (`onResponse`), or take full control of the
 * request lifecycle (`wrap`). Policies run in registration order; the
 * first to throw rejects the request.
 *
 * Currently used by:
 *
 *  - {@link http3OpportunisticPolicy} — pins `protocol:"h3"` for
 *    origins that previously advertised Alt-Svc, downgrades to h2 on
 *    handshake failure, updates the per-origin cache from response
 *    headers.
 *
 * Future policies (sketched in
 * `docs/changes/2026-05-19-design-network-layer-v2.md`):
 *
 *  - `authRefreshPolicy` — collapses the 401-retry maze currently
 *    inlined in `src/client.ts`.
 *  - `rateLimitPolicy` — per-origin token bucket.
 *  - `originAllowlistPolicy` — plugin sandboxing.
 *
 * @see NetworkClient
 */
export interface NetworkPolicy {
  /** Stable identifier for diagnostics / removal. */
  readonly id: string
  /**
   * Pre-flight. Receives the (possibly rewritten by an earlier policy)
   * request. Return a modified request to thread it onward, return
   * `undefined`/`void` to pass through unchanged, or throw to reject.
   */
  onRequest?(
    req: NetworkRequest,
  ): Promise<NetworkRequest | undefined | void> | NetworkRequest | undefined | void
  /**
   * Post-flight. Receives the request and the transport's raw response
   * along with a `retry()` callback for replaying with a (possibly
   * different) request. Returning a {@link NetworkResponse} substitutes
   * it; returning `undefined`/`void` passes the original response on
   * to the next policy and ultimately to the caller.
   *
   * Note: `retry()` runs the WHOLE transport pipeline again (transports
   * are re-selected from `next.protocol`), but does NOT re-invoke the
   * policy chain — that prevents infinite loops. If you need a fresh
   * policy pass, use `wrap()` instead.
   */
  onResponse?(
    req: NetworkRequest,
    res: NetworkResponse,
    retry: (next: NetworkRequest) => Promise<NetworkResponse>,
  ): Promise<NetworkResponse | undefined | void> | NetworkResponse | undefined | void
  /**
   * Full lifecycle wrap. Receives the (post-`onRequest`) request and
   * a `run(override?)` callback that fires the actual transport. Use
   * when the policy needs both sides (retry-on-error, queue/throttle,
   * error classification). Multiple `wrap()` policies nest in
   * registration order — earlier policies become outer scopes.
   *
   * The `override` argument lets a policy re-fire with a modified
   * request (e.g. h3→h2 downgrade after handshake failure). Transport
   * selection re-evaluates against `override.protocol`; the policy
   * chain does NOT re-run (preventing infinite loops). Same response
   * pipeline as the outer call: `onResponse` policies still fire on
   * the retried response.
   */
  wrap?(
    req: NetworkRequest,
    run: (override?: NetworkRequest) => Promise<NetworkResponse>,
  ): Promise<NetworkResponse>
}

/** Response wrapper shared by all network transports. */
export class NetworkResponse {
  readonly status: number
  readonly headers: Headers
  readonly body: ReadableStream<Uint8Array>
  readonly transport: NetworkTransportInfo
  /** Write more bytes on an open HTTP/2 request stream (Connect bidi). */
  writeRequestBody?: (chunk: Uint8Array) => void
  /** Half-close the HTTP/2 request stream. */
  endRequestBody?: () => void

  constructor(opts: {
    status: number
    headers: Headers | Record<string, string>
    body?: ReadableStream<Uint8Array> | null
    transport: NetworkTransportInfo
  }) {
    this.status = opts.status
    this.headers = opts.headers instanceof Headers ? opts.headers : new Headers(opts.headers)
    this.body = opts.body ?? emptyBody()
    this.transport = opts.transport
  }

  get ok(): boolean {
    return this.status >= 200 && this.status < 300
  }

  async text(): Promise<string> {
    return new Response(this.body).text()
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text())
  }
}

export interface NetworkTransport {
  readonly id: string
  request(req: NetworkRequest): Promise<NetworkResponse>
  preconnect?(origin: string): Promise<void> | void
  close?(): Promise<void> | void
}

export interface NetworkObserver {
  onRequest?(req: NetworkRequest): void
  onResponse?(req: NetworkRequest, res: NetworkResponse): void
  onChunk?(req: NetworkRequest, chunk: Uint8Array, res: NetworkResponse): void
  onEnd?(req: NetworkRequest, res: NetworkResponse): void
  onError?(req: NetworkRequest, error: unknown): void
}

/**
 * Build an empty web stream for responses without a body.
 *
 * @returns Closed byte stream.
 */
export function emptyBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close()
    },
  })
}
