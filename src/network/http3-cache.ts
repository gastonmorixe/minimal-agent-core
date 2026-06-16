/**
 * Per-origin HTTP/3 negotiation cache.
 *
 * The {@link http3OpportunisticPolicy} consults this cache before each
 * request to decide whether to pin `protocol:"h3"` or let the client
 * default to h2. It also writes to the cache as evidence accumulates:
 *
 *  - Response headers carry `Alt-Svc: h3="..."`        → mark `"supported"`
 *  - Transport throws `HTTP3HandshakeFailed`           → mark `"unsupported"`
 *  - Either entry expires after its TTL                → fall back to `"unknown"`
 *
 * Positive TTL defaults to 24 hours (RFC 7838's `ma=86400` convention).
 * Negative TTL is shorter (1 hour) because the reason h3 fails on a
 * given origin is usually environmental (corporate firewall, hotel
 * captive portal) rather than the origin itself, and those conditions
 * change as the laptop moves.
 *
 * The cache is process-local — restarts pay at most one extra h2
 * request per origin to rediscover. There is no on-disk persistence
 * and intentionally so: a stale Alt-Svc cache across sessions has
 * caused real-world breakage in browsers when origins rotate cert
 * pinning or change their CDN.
 *
 * Style mirrors `src/lockfile.ts` and `src/retry.ts`: dependency-free,
 * injectable `now()` for fake-clock tests.
 *
 * @module network/http3-cache
 */

/** Cached verdict for an origin. */
export type Http3Verdict = "supported" | "unsupported" | "unknown"

/** Failure category passed to {@link Http3NegotiationCache.recordFailure}. */
export type Http3FailureKind =
  | "handshake" // HTTP3HandshakeFailed / QUIC handshake refused → cache as unsupported
  | "network" // transient TCP/UDP error → do NOT cache (preserve last verdict)
  | "abort" // caller aborted (AbortSignal) → do NOT cache

interface Entry {
  verdict: "supported" | "unsupported"
  expiresAt: number
}

/** Tunables for {@link Http3NegotiationCache}. */
export interface Http3CacheOptions {
  /**
   * Max TTL for `"supported"` entries learned from Alt-Svc.
   * Defaults to 24h. The server-supplied `ma=` directive is honored
   * up to this cap.
   */
  positiveTtlMs?: number
  /**
   * TTL for `"unsupported"` entries learned from handshake failures.
   * Defaults to 1h. Shorter than positive TTL because the cause is
   * usually environmental and self-heals when the network changes.
   */
  negativeTtlMs?: number
  /** Injectable wall clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number
}

const DEFAULT_POSITIVE_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_NEGATIVE_TTL_MS = 60 * 60 * 1000

/**
 * Origin → verdict map with TTLs and Alt-Svc parsing.
 *
 * @example
 *   const cache = new Http3NegotiationCache()
 *   cache.lookup("https://api.example.com")        // "unknown"
 *   cache.recordAltSvc(
 *     "https://api.example.com",
 *     'h3=":443"; ma=86400, h3-29=":443"; ma=86400',
 *   )
 *   cache.lookup("https://api.example.com")        // "supported"
 */
export class Http3NegotiationCache {
  private readonly map = new Map<string, Entry>()
  private readonly positiveTtlMs: number
  private readonly negativeTtlMs: number
  private readonly now: () => number
  private readonly MAX_SIZE = 1000

  constructor(opts: Http3CacheOptions = {}) {
    this.positiveTtlMs = opts.positiveTtlMs ?? DEFAULT_POSITIVE_TTL_MS
    this.negativeTtlMs = opts.negativeTtlMs ?? DEFAULT_NEGATIVE_TTL_MS
    this.now = opts.now ?? Date.now
  }

  private enforceLimit() {
    if (this.map.size > this.MAX_SIZE) {
      const firstKey = this.map.keys().next().value
      if (firstKey !== undefined) this.map.delete(firstKey)
    }
  }

  /**
   * Look up the current verdict for an origin. Side-effect: lazily
   * evicts expired entries.
   *
   * @param origin - Origin string (e.g. `"https://api.example.com"`).
   *                 Lookups normalize via `new URL(origin).origin` so
   *                 paths and ports collapse correctly.
   * @returns `"supported"`, `"unsupported"`, or `"unknown"`.
   */
  lookup(origin: string): Http3Verdict {
    const key = normalize(origin)
    if (!key) return "unknown"
    const entry = this.map.get(key)
    if (!entry) return "unknown"
    if (entry.expiresAt <= this.now()) {
      this.map.delete(key)
      return "unknown"
    }
    return entry.verdict
  }

  /**
   * Promote an origin to `"supported"` based on an `Alt-Svc`
   * response header. Idempotent — re-recording refreshes the TTL.
   *
   * @param origin - Origin string. Normalized via `new URL`.
   * @param altSvc - Raw `Alt-Svc` header value, or `null` when absent.
   *                 Only entries listing an `h3` (or `h3-XX` draft)
   *                 alternative service are considered. The cache
   *                 ignores other ALPN tokens (`h2`, `h2c`).
   */
  recordAltSvc(origin: string, altSvc: string | null | undefined): void {
    if (!altSvc) return
    const key = normalize(origin)
    if (!key) return
    const advert = parseAltSvc(altSvc)
    if (!advert.h3) return
    const ttlMs = Math.min(
      (advert.maxAgeSec ?? this.positiveTtlMs / 1000) * 1000,
      this.positiveTtlMs,
    )
    this.map.set(key, {
      verdict: "supported",
      expiresAt: this.now() + ttlMs,
    })
    this.enforceLimit()
  }

  /**
   * Record a transport failure. Only `"handshake"` failures are
   * cached as `"unsupported"` — transient `"network"` errors and
   * caller-driven `"abort"` leave the existing verdict untouched.
   *
   * Why: hotels and corporate networks block UDP/443 outright,
   * causing reliable handshake-stage failures. Caching prevents the
   * 5-second per-request penalty. By contrast, a single mid-stream
   * RST or DNS hiccup says nothing about whether the origin speaks
   * h3 next time, so we don't punish it.
   */
  recordFailure(origin: string, kind: Http3FailureKind): void {
    if (kind !== "handshake") return
    const key = normalize(origin)
    if (!key) return
    this.map.set(key, {
      verdict: "unsupported",
      expiresAt: this.now() + this.negativeTtlMs,
    })
    this.enforceLimit()
  }

  /**
   * Explicit seed for testing / benchmarking / force-h3 mode.
   *
   * @param origin - Origin string. Normalized via `new URL`.
   * @param verdict - Verdict to install. `"unknown"` removes any entry.
   * @param ttlMs - Optional override TTL; defaults to the type-appropriate
   *                default (positive or negative).
   */
  seed(origin: string, verdict: Http3Verdict, ttlMs?: number): void {
    const key = normalize(origin)
    if (!key) return
    if (verdict === "unknown") {
      this.map.delete(key)
      return
    }
    const ttl = ttlMs ?? (verdict === "supported" ? this.positiveTtlMs : this.negativeTtlMs)
    this.map.set(key, {
      verdict,
      expiresAt: this.now() + ttl,
    })
    this.enforceLimit()
  }

  /** Empty the cache. Returns the number of entries removed. */
  clear(): number {
    const n = this.map.size
    this.map.clear()
    return n
  }

  /** Test helper: current entry count (excluding expired). */
  size(): number {
    const now = this.now()
    let n = 0
    for (const entry of this.map.values()) if (entry.expiresAt > now) n++
    return n
  }
}

/**
 * Internal: parsed shape of an `Alt-Svc` header value. Only the
 * fields the cache acts on are extracted; full RFC 7838 conformance
 * is not the goal (we don't need quoted-string escaping, persistence
 * directives, or the deprecated `clear` token).
 */
interface AltSvcSummary {
  /** True when any `h3` or `h3-XX` (draft) alternative is advertised. */
  h3: boolean
  /** Minimum `ma=` (max-age) across the advertised h3 entries, in seconds. */
  maxAgeSec?: number
}

/**
 * Parse an `Alt-Svc` header value for h3 advertisements.
 *
 * Accepts the standard comma-separated form
 * `h3=":443"; ma=86400, h3-29=":443"; ma=600`. Returns the LOWEST
 * `ma=` across h3 entries (most conservative TTL) so we re-probe
 * earlier rather than later when the origin gives mixed values.
 *
 * @param value - Raw header value. Multi-header concatenation
 *                (comma-joined by the HTTP/2 layer) is supported.
 * @returns Summary with `h3: boolean` and optional `maxAgeSec`.
 */
export function parseAltSvc(value: string): AltSvcSummary {
  const trimmed = value.trim()
  if (!trimmed) return { h3: false }
  let h3 = false
  let minMaxAge: number | undefined
  // Split on commas that aren't inside quotes. Alt-Svc quoted-string
  // escaping is just \" — we don't need a full ABNF parser here.
  for (const entry of splitTopLevel(trimmed, ",")) {
    const parts = splitTopLevel(entry.trim(), ";").map((s) => s.trim())
    if (parts.length === 0) continue
    const protocolPart = parts[0]
    if (!protocolPart) continue
    const eq = protocolPart.indexOf("=")
    if (eq < 0) continue
    const protocol = protocolPart.slice(0, eq).trim().toLowerCase()
    if (protocol !== "h3" && !protocol.startsWith("h3-")) continue
    h3 = true
    for (const param of parts.slice(1)) {
      const pEq = param.indexOf("=")
      if (pEq < 0) continue
      const k = param.slice(0, pEq).trim().toLowerCase()
      const v = param.slice(pEq + 1).trim()
      if (k !== "ma") continue
      const n = Number.parseInt(v, 10)
      if (!Number.isFinite(n) || n < 0) continue
      minMaxAge = minMaxAge === undefined ? n : Math.min(minMaxAge, n)
    }
  }
  return minMaxAge === undefined ? { h3 } : { h3, maxAgeSec: minMaxAge }
}

/**
 * Quote-aware splitter for Alt-Svc parsing. Splits on `sep` at top
 * level only — separators inside `"..."` are preserved.
 */
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '"') {
      depth = depth === 0 ? 1 : 0
      continue
    }
    if (ch === "\\" && depth === 1) {
      i++ // skip escaped char
      continue
    }
    if (depth === 0 && ch === sep) {
      out.push(s.slice(start, i))
      start = i + 1
    }
  }
  out.push(s.slice(start))
  return out
}

/**
 * Normalize an origin-ish string to the canonical form the cache
 * keys on. Wraps URL parsing in a try/catch so callers can pass
 * arbitrary strings without worrying about throwing.
 */
function normalize(origin: string): string | null {
  try {
    return new URL(origin).origin
  } catch {
    return null
  }
}
