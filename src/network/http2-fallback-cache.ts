/**
 * Per-origin "this origin doesn't speak h2" cache.
 *
 * SPEC-NET-001 diagnosed `error h2 is not supported` against
 * `opencode.ai`: the origin's ALPN never selects `h2`, `node:http2`'s
 * `connect()` raises a connect-phase `error` event for it, and — because the
 * fetch fallback is off by default — that raw error reached the user on
 * every single request.
 *
 * `session.alpnProtocol` is NOT a usable signal here: on Bun 1.4.4 it reads
 * `"h2"` even on a session whose connect already failed with
 * `h2 is not supported` (see `isHttp2UnsupportedError` in
 * `./http2-transport.ts`). The only trustworthy signal is the connect-phase
 * `error` event itself, which {@link http2FallbackPolicy} classifies.
 *
 * This cache exists so a learned verdict survives past the first failed
 * request: once an origin is known not to speak h2, every later request to
 * it skips the h2 attempt entirely instead of repeating the same failure
 * (the "forever-retry trap" the diagnostic report warns against). There is
 * no TTL — an origin's ALPN support doesn't flap the way a captive portal's
 * UDP filtering does (contrast {@link Http3NegotiationCache}), so once
 * proven unsupported for the process it stays that way. A `MAX_SIZE` cap
 * still bounds pathological growth (many distinct h1-only origins in one
 * process), evicting the oldest entry first.
 *
 * The cache is process-local, matching `Http3NegotiationCache` and the
 * report's own "for the session" scope: no on-disk persistence, so a
 * restart pays at most one more failed request per origin to relearn it.
 *
 * @module network/http2-fallback-cache
 */

/** Tunables for {@link Http2FallbackCache}. */
export interface Http2FallbackCacheOptions {
  /** Max distinct origins remembered. Defaults to 1000. */
  maxSize?: number
}

const DEFAULT_MAX_SIZE = 1000

/**
 * Origin → "h1-only" verdict set, learned from connect-phase h2 failures.
 *
 * @example
 *   const cache = new Http2FallbackCache()
 *   cache.isH1Only("https://opencode.ai")   // false
 *   cache.markH1Only("https://opencode.ai")
 *   cache.isH1Only("https://opencode.ai")   // true
 */
export class Http2FallbackCache {
  private readonly origins = new Set<string>()
  private readonly maxSize: number

  constructor(opts: Http2FallbackCacheOptions = {}) {
    this.maxSize = opts.maxSize ?? DEFAULT_MAX_SIZE
  }

  /**
   * True once `markH1Only` has recorded this origin as not speaking h2.
   *
   * @param origin - Origin-ish string, normalized via `new URL(...).origin`.
   *                 Malformed input reads as `false`.
   */
  isH1Only(origin: string): boolean {
    const key = normalize(origin)
    return key !== null && this.origins.has(key)
  }

  /**
   * Record that `origin` failed h2 connect-phase negotiation. Idempotent.
   * Malformed input is a no-op.
   */
  markH1Only(origin: string): void {
    const key = normalize(origin)
    if (!key) return
    this.origins.add(key)
    if (this.origins.size > this.maxSize) {
      const oldest = this.origins.values().next().value
      if (oldest !== undefined) this.origins.delete(oldest)
    }
  }

  /** Empty the cache. Returns the number of entries removed. */
  clear(): number {
    const n = this.origins.size
    this.origins.clear()
    return n
  }

  /** Test helper: current entry count. */
  size(): number {
    return this.origins.size
  }
}

/**
 * Normalize an origin-ish string to the canonical form the cache keys on.
 * Wraps URL parsing in a try/catch so callers can pass arbitrary strings
 * without worrying about throwing.
 */
function normalize(origin: string): string | null {
  try {
    return new URL(origin).origin
  } catch {
    return null
  }
}
