/**
 * Automatic h2-unsupported fallback policy.
 *
 * SPEC-NET-001: `opencode.ai` serves HTTP/1.1 only (no `h2` ALPN). The
 * default client's primary transport is `Http2Transport`, which fails that
 * connect with `h2 is not supported`. Fetch fallback exists but is off by
 * default (`MINIMAL_AGENT_ALLOW_FETCH_FALLBACK`), so the raw transport error
 * reached the user on the very first request, every time.
 *
 * This policy pairs with {@link Http2FallbackCache} to fix that
 * specifically-diagnosed failure mode, independent of the
 * `allowFetchFallback` knob (a different, broader fallback switch — see
 * `NetworkClient.shouldFallback`):
 *
 *   wrap:
 *     - A request routes to h2 as usual (no protocol pin, or a pin the
 *       cache already satisfies). If the transport throws an
 *       h2-protocol-negotiation failure ({@link isHttp2UnsupportedError}),
 *       record the origin as h1-only, then retry the SAME request once
 *       with `protocol: "http/1.1"` so this exact request is still served
 *       (not just learned-and-thrown). A request pinned `protocol: "h2"`
 *       explicitly is never retried — that keeps the Cursor Connect rule
 *       (`NetworkClient.shouldFallback`'s same carve-out). Likewise a
 *       request that opts out with `allowFetchFallback: false`.
 *
 *   onRequest:
 *     - Cache already says this origin is h1-only, and the caller pinned no
 *       protocol → pin `protocol: "http/1.1"` up front. The retry-on-error
 *       path above only ever has to run ONCE per origin; every later
 *       request skips h2 entirely instead of repeating the same failure
 *       (the "forever-retry trap" the diagnostic report calls out).
 *
 * Requires a `"http/1.1"` entry in the client's `transports` map (the fetch
 * transport) — without one, `transportFor` falls through to `primary` and
 * both the pin and the retry override are no-ops.
 *
 * @see Http2FallbackCache
 * @see isHttp2UnsupportedError
 * @module network/policies/h2-fallback
 */

import { Http2FallbackCache } from "../http2-fallback-cache.ts"
import { isHttp2UnsupportedError } from "../http2-transport.ts"
import type { NetworkPolicy, NetworkRequest, NetworkResponse } from "../types.ts"

/** Tunables for {@link http2FallbackPolicy}. */
export interface H2FallbackOptions {
  /**
   * Shared cache instance. Required — pass the SAME cache to any other
   * surface that wants to observe or seed learned verdicts.
   */
  cache: Http2FallbackCache
  /**
   * Optional observer for diagnostics: receives a one-line summary each
   * time the policy learns an origin is h1-only or routes around it.
   */
  onDecision?: (event: H2FallbackDecisionEvent) => void
}

/** Diagnostic event emitted by {@link H2FallbackOptions.onDecision}. */
export interface H2FallbackDecisionEvent {
  origin: string
  /** `"learned"` on the first failure, `"skip-h2"` on a cache-hit pin. */
  kind: "learned" | "skip-h2"
}

/**
 * Build the automatic h2-unsupported-fallback policy.
 *
 * @example
 *   const cache = new Http2FallbackCache()
 *   const client = new NetworkClient(\{
 *     primary: new Http2Transport(),
 *     transports: new Map([["http/1.1", new FetchTransport()]]),
 *     policies: [http2FallbackPolicy(\{ cache \})],
 *   \})
 */
export function http2FallbackPolicy(opts: H2FallbackOptions): NetworkPolicy {
  const { cache, onDecision } = opts
  return {
    id: "h2-fallback",

    onRequest(req: NetworkRequest): NetworkRequest | undefined {
      if (req.protocol) return undefined // respect any existing pin (incl. "h2")
      const origin = safeOrigin(req.url)
      if (!origin || !cache.isH1Only(origin)) return undefined
      onDecision?.({ origin, kind: "skip-h2" })
      return { ...req, protocol: "http/1.1" }
    },

    async wrap(
      req: NetworkRequest,
      run: (override?: NetworkRequest) => Promise<NetworkResponse>,
    ): Promise<NetworkResponse> {
      try {
        return await run()
      } catch (err) {
        const origin = safeOrigin(req.url)
        if (
          !origin ||
          req.protocol === "h2" || // explicit pin: never fall back (Cursor Connect)
          req.allowFetchFallback === false || // explicit opt-out: never fall back
          !isHttp2UnsupportedError(err)
        ) {
          throw err
        }
        cache.markH1Only(origin)
        onDecision?.({ origin, kind: "learned" })
        const served = await run({ ...req, protocol: "http/1.1" })
        // Telemetry: this IS a fallback, and the outer `NetworkClient` branch
        // (the only other place that sets `fallbackUsed`) never sees it —
        // we swallowed the h2 error and the http/1.1 retry succeeded. Without
        // this line a genuine h2→http/1.1 downgrade reported
        // `fallbackUsed:false` (IMPROVEMENTS.md item 1).
        //
        // Set on the RESPONSE rather than from the client: `fire()` cannot
        // tell a policy re-pin apart from a caller's own pin or from this
        // policy's upfront cache-hit pin in `onRequest` (neither of which is a
        // fallback). Marking the response it produced is the only place that
        // knows an attempt was actually discarded.
        served.transport.fallbackUsed = true
        return served
      }
    },
  }
}

/** URL parsing that doesn't throw. */
function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}
