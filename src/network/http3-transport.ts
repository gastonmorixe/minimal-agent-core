/**
 * HTTP/3 transport using Bun's experimental QUIC `fetch` client.
 *
 * Requires Bun ≥ 1.3.14 (May 13, 2026), where `protocol: "http3"`
 * was added as a per-request opt-in to the global `fetch()`. Older
 * runtimes silently drop the option and fall through to HTTP/1.1 —
 * for defensive use, gate the transport on the `--experimental-http3-fetch`
 * runtime flag or the {@link Http3NegotiationCache}.
 *
 * Unlike the {@link Http2Transport} (which pools `node:http2` sessions
 * per origin), this transport delegates connection pooling to Bun's
 * fetch implementation. Bun shares a single QUIC connection per origin
 * across concurrent fetches, multiplexes streams, and reuses it for
 * subsequent requests within its internal idle window.
 *
 * ## Failure modes
 *
 * When an origin doesn't speak QUIC (no UDP/443 listener, no
 * Alt-Svc), Bun throws an error whose message contains
 * `HTTP3HandshakeFailed`. The {@link http3OpportunisticPolicy}
 * classifies these as `"handshake"` failures and routes to the cache
 * so subsequent requests skip the h3 attempt for an hour.
 *
 * Networks that block UDP/443 (corporate firewalls, captive portals)
 * present as the same handshake-failure error — the cache TTL is
 * intentionally short (1h) so the agent self-heals when the laptop
 * moves to a friendlier network.
 *
 * @module network/http3-transport
 */

import { type NetworkRequest, NetworkResponse, type NetworkTransport } from "./types.ts"

/**
 * HTTP/3 transport over Bun's experimental QUIC fetch.
 *
 * @example
 *   const transport = new Http3Transport()
 *   const client = new NetworkClient(\{
 *     primary: new Http2Transport(),
 *     transports: new Map([["http3", transport]]),
 *     policies: [http3OpportunisticPolicy(new Http3NegotiationCache())],
 *   \})
 */
export class Http3Transport implements NetworkTransport {
  readonly id = "http3"

  async request(req: NetworkRequest): Promise<NetworkResponse> {
    const init = buildInit(req)
    const response = await fetch(req.url, init as RequestInit)
    return new NetworkResponse({
      status: response.status,
      headers: response.headers,
      body: response.body,
      transport: {
        id: this.id,
        protocol: "h3",
        origin: safeOrigin(req.url),
        reused: undefined, // Bun doesn't expose connection reuse on the response.
        fallbackUsed: false,
      },
    })
  }
}

/**
 * Internal: shape the `fetch()` init from a {@link NetworkRequest}.
 * Exported for unit testing.
 */
export function buildInit(req: NetworkRequest): RequestInit & { protocol: "http3" } {
  return {
    method: req.method,
    headers: req.headers,
    body: toFetchBody(req.body),
    signal: req.signal,
    // Bun-specific. Cast at the call site silences TS strict mode
    // (RequestInit doesn't declare `protocol`).
    protocol: "http3",
  }
}

/**
 * Convert our request body shape (`string | Uint8Array | undefined`)
 * into something `fetch` accepts as `BodyInit`. Uint8Array bodies
 * are copied into a fresh ArrayBuffer to detach from any caller-held
 * view that might be mutated mid-flight.
 */
function toFetchBody(body: NetworkRequest["body"]): BodyInit | undefined {
  if (body == null || typeof body === "string") return body
  const copy = new ArrayBuffer(body.byteLength)
  new Uint8Array(copy).set(body)
  return copy
}

/**
 * URL parsing that doesn't throw — bad URLs return undefined.
 */
function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin
  } catch {
    return undefined
  }
}

/**
 * Best-effort detection of HTTP/3 handshake failures so callers
 * (e.g. {@link http3OpportunisticPolicy}) can classify them as
 * structural "origin doesn't speak h3" failures rather than
 * transient network errors.
 *
 * Patterns matched (case-insensitive):
 *  - `HTTP3HandshakeFailed`  (Bun ≥ 1.3.14 error name / message)
 *  - `QUIC connect ... failed`
 *  - `quic_handshake_failed`
 *  - `ECONNREFUSED` *combined with* a clearly-UDP context
 *  - `ENETUNREACH`
 *  - `EHOSTUNREACH`
 *
 * @returns true when the error looks like a structural h3 refusal.
 */
export function isHttp3HandshakeError(err: unknown): boolean {
  if (!err) return false
  const msg = errorMessage(err)
  if (!msg) return false
  return /HTTP3HandshakeFailed|QUIC.*(connect|handshake).*fail|quic_handshake_failed|ENETUNREACH|EHOSTUNREACH/i.test(
    msg,
  )
}

/**
 * Internal: extract a string message from an unknown error-shaped
 * value. Walks `cause` chains one level deep since Bun often wraps
 * the underlying QUIC error in a `TypeError("fetch failed", { cause })`.
 */
function errorMessage(err: unknown): string {
  if (typeof err === "string") return err
  if (err instanceof Error) {
    const own = err.message ?? ""
    const cause = err.cause
    if (cause && typeof cause === "object" && "message" in cause) {
      return `${own} ${(cause as Error).message}`
    }
    return own
  }
  try {
    return String(err)
  } catch {
    return ""
  }
}
