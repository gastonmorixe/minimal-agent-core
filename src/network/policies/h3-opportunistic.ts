/**
 * Opportunistic HTTP/3 negotiation policy.
 *
 * Pairs with {@link Http3NegotiationCache} to give the agent
 * Alt-Svc-style h3 negotiation: first request to an origin goes
 * over h2, and if the response advertises `Alt-Svc: h3=...`, every
 * subsequent request to that origin is pinned to h3 until the
 * advertised `ma=` TTL elapses. Handshake failures downgrade the
 * origin to "unsupported" for an hour, so brief networking
 * problems don't turn into permanent h3-everywhere disasters.
 *
 * ## Three behaviors in one policy
 *
 *   onRequest:
 *     - Caller pinned `protocol` explicitly → leave it alone.
 *     - Cache says "supported"              → set `protocol: "h3"`.
 *     - Cache says "unsupported" or "unknown" → leave unset (h2 wins
 *       by transport routing).
 *
 *   onResponse:
 *     - Always peek at `Alt-Svc` and feed it to the cache. This is
 *       how an origin gets promoted from "unknown" to "supported"
 *       in the first place, AND how a "supported" entry gets its
 *       TTL extended.
 *
 *   wrap:
 *     - If WE pinned this request to h3 (caller didn't) and the
 *       transport throws a handshake failure: record the failure,
 *       then re-fire with `protocol: undefined` so the client
 *       routes to the default (h2) transport. Once.
 *     - If the CALLER pinned h3 explicitly: don't second-guess
 *       them. Surface the error unchanged. (The cache still gets
 *       updated, so future opportunistic decisions improve.)
 *
 * ## Three modes
 *
 *   "opt"  : the recommended default. Behavior above.
 *   "force": every origin treated as `"supported"` until the cache
 *            observes a handshake failure. Useful for benchmarking
 *            or once a fleet-wide rollout decision has been made.
 *   "off"  : the policy doesn't install at all (caller's choice).
 *
 * @see Http3NegotiationCache
 * @module network/policies/h3-opportunistic
 */

import { Http3NegotiationCache } from "../http3-cache.ts"
import { isHttp3HandshakeError } from "../http3-transport.ts"
import type { NetworkPolicy, NetworkRequest, NetworkResponse } from "../types.ts"

/** Tunables for {@link http3OpportunisticPolicy}. */
export interface H3OpportunisticOptions {
  /**
   * Shared cache instance. Required — pass the SAME cache to the
   * benchmark / status / debug surfaces so they observe the same
   * verdicts.
   */
  cache: Http3NegotiationCache
  /**
   * - `"opt"`   — h3 only when the cache says `"supported"` (default).
   * - `"force"` — h3 by default, unsupported only when proven so.
   */
  mode?: "opt" | "force"
  /**
   * Optional observer for diagnostics: receives a one-line summary
   * each time the policy makes or reverses a decision. Typically a
   * `console.error` adapter or wired to net-dbg.
   */
  onDecision?: (event: H3DecisionEvent) => void
}

/** Diagnostic event emitted by {@link H3OpportunisticOptions.onDecision}. */
export interface H3DecisionEvent {
  origin: string
  /** What the policy did at `onRequest` time. */
  kind: "pin-h3" | "pin-h3-forced" | "pass-through" | "respect-pin"
  /** Cache verdict observed at the moment of decision. */
  verdict: "supported" | "unsupported" | "unknown"
  /** True when the caller had already set `req.protocol`. */
  callerPinned: boolean
}

/** Diagnostic event emitted from `wrap()` on a downgrade-retry. */
export interface H3DowngradeEvent {
  origin: string
  /** Whichever error the h3 transport threw before the downgrade. */
  cause: unknown
}

/**
 * Build the opportunistic-h3 policy.
 *
 * @example
 *   const cache = new Http3NegotiationCache()
 *   const client = new NetworkClient(\{
 *     primary: new Http2Transport(),
 *     transports: new Map([["http3", new Http3Transport()]]),
 *     policies: [http3OpportunisticPolicy(\{ cache, mode: "opt" \})],
 *   \})
 */
export function http3OpportunisticPolicy(opts: H3OpportunisticOptions): NetworkPolicy {
  const { cache, mode = "opt", onDecision } = opts
  return {
    id: "h3-opportunistic",

    onRequest(req: NetworkRequest): NetworkRequest | undefined {
      const origin = safeOrigin(req.url)
      if (!origin) return undefined
      const verdict = cache.lookup(origin)
      // Caller pinned explicitly → respect them.
      if (req.protocol) {
        onDecision?.({ origin, kind: "respect-pin", verdict, callerPinned: true })
        return undefined
      }
      if (verdict === "supported") {
        onDecision?.({ origin, kind: "pin-h3", verdict, callerPinned: false })
        return { ...req, protocol: "h3" }
      }
      if (mode === "force" && verdict !== "unsupported") {
        onDecision?.({ origin, kind: "pin-h3-forced", verdict, callerPinned: false })
        return { ...req, protocol: "h3" }
      }
      onDecision?.({ origin, kind: "pass-through", verdict, callerPinned: false })
      return undefined
    },

    onResponse(req: NetworkRequest, res: NetworkResponse): undefined {
      const origin = safeOrigin(req.url)
      if (!origin) return undefined
      cache.recordAltSvc(origin, res.headers.get("alt-svc"))
      return undefined
    },

    async wrap(
      req: NetworkRequest,
      run: (override?: NetworkRequest) => Promise<NetworkResponse>,
    ): Promise<NetworkResponse> {
      try {
        return await run()
      } catch (err) {
        const origin = safeOrigin(req.url)
        if (!isHttp3HandshakeError(err) || req.protocol !== "h3" || !origin) {
          throw err
        }
        // Record the failure regardless of whether the caller pinned
        // (helps future opportunistic decisions either way).
        cache.recordFailure(origin, "handshake")
        // Only retry-with-downgrade when WE pinned h3 (not the
        // caller). If the caller explicitly asked for h3, surfacing
        // the original error is the correct behavior.
        if (!callerWantsH3(req)) {
          const downgraded = stripProtocol(req)
          return run(downgraded)
        }
        throw err
      }
    },
  }
}

/**
 * Heuristic to distinguish caller-pinned vs policy-pinned h3.
 *
 * We can't track "who set the protocol field" in TypeScript without
 * a sentinel, so we read intent from `policyTags`. Caller can opt
 * out of automatic downgrade by including `"explicit-h3"` in their
 * `req.policyTags` — useful for benchmarks and explicit tests of
 * h3 behavior.
 */
function callerWantsH3(req: NetworkRequest): boolean {
  return req.policyTags?.includes("explicit-h3") ?? false
}

/** Return a clone of `req` with `protocol` cleared. */
function stripProtocol(req: NetworkRequest): NetworkRequest {
  const { protocol: _p, ...rest } = req
  return rest as NetworkRequest
}

/** URL parsing that doesn't throw. */
function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}
