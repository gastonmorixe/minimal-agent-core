/**
 * Provider-neutral 401 auth-refresh middleware.
 *
 * Wraps an attempt and, on a 401, recovers the OAuth session and retries
 * once, mirroring the inline 401 handling in `client.ts`'s
 * `sendMessageOnce` but driven entirely through the `ProviderAuth.refresh`
 * hook so it works for any OAuth provider:
 *
 *   1. **store-first (multi-process race fix).** When many agents share
 *      one credential-store entry, server-side refresh-token rotation
 *      invalidates every OTHER process's cached access token, so they all
 *      401 at once. Before paying for a network refresh, re-read the local
 *      credential store (via the injected `peerToken` hook): if a peer
 *      already rotated the token, adopt it and retry. Collapses N concurrent
 *      refreshes per true-expiry event into ~1.
 *   2. **network refresh.** Otherwise call `auth.refresh()`, adopt the new
 *      token, and retry.
 *   3. **give up.** If a 401 persists after both, rethrow (the host should
 *      re-login).
 *
 * The token is mutated in place on the passed-in `ProviderAuth`, so the
 * retried attempt (which rebuilds its request from the same auth object)
 * picks up the fresh token.
 *
 * Provider-neutral by construction: the only provider-specific bit (reading
 * the local credential store for peer rotation) is an INJECTED `peerToken`
 * callback, not a hard import.
 *
 * **Assumption:** a 401 surfaces BEFORE any stream output (it's an HTTP
 * status error, pre-SSE), so retrying never double-emits text.
 *
 * @module llm/transport/auth-refresh
 */

import { diag } from "../../bus/diagnostic-bus.ts"
import type { ProviderAuth } from "../provider.ts"

import type { StreamedResponse } from "./types.ts"

/** Mutable auth holder. `auth.token` is updated in place on refresh. */
export interface AuthRefreshState {
  auth: ProviderAuth
}

export interface AuthRefreshOptions {
  /**
   * Store-first peer-rotation read: returns a token discovered locally in
   * the credential store WITHOUT a network refresh, or undefined/null when
   * none. Injected so the middleware stays provider-neutral. Omit to skip
   * straight to network refresh.
   */
  peerToken?: () => string | undefined | null
}

/** Heuristic: is this thrown error an HTTP 401 / auth failure? */
export function is401(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false
  const e = err as { name?: string; status?: number; opts?: { status?: number }; message?: string }
  if (e.name === "AuthError") return true
  if (e.opts?.status === 401 || e.status === 401) return true
  return typeof e.message === "string" && /\b401\b/.test(e.message)
}

/**
 * Run `makeAttempt`, recovering once from a 401 via store-first then
 * network refresh. Non-401 errors (and 401s with no refresh available)
 * propagate unchanged for the outer retry coordinator to classify.
 *
 * @param makeAttempt - Fresh attempt factory; re-reads `state.auth` each call.
 * @param state - Mutable auth holder; `auth.token` is updated on refresh.
 * @yields the attempt's text deltas.
 * @returns the successful attempt's `StreamedResponse`.
 */
export async function* withAuthRefresh(
  makeAttempt: () => AsyncGenerator<string, StreamedResponse, undefined>,
  state: AuthRefreshState,
  opts: AuthRefreshOptions = {},
): AsyncGenerator<string, StreamedResponse, undefined> {
  let triedPeer = false
  let triedRefresh = false

  for (;;) {
    try {
      return yield* makeAttempt()
    } catch (err) {
      const auth = state.auth
      // Only OAuth with a refresh callback can recover. Everything else
      // (non-401, api-key, no refresh, already-exhausted) propagates.
      if (!is401(err) || auth.kind !== "oauth" || !auth.refresh) throw err

      // 1) store-first: adopt a peer-rotated token without a refresh.
      if (!triedPeer) {
        triedPeer = true
        const peer = opts.peerToken?.()
        if (peer && peer !== auth.token) {
          diag.info("auth.refresh", "peer-process rotated token; retrying with fresh stored value")
          auth.token = peer
          continue
        }
        // No fresher peer token — fall through to the network refresh below.
      }

      // 2) network refresh.
      if (!triedRefresh) {
        triedRefresh = true
        diag.info("auth.refresh", "access token expired (401); refreshing")
        const next = await auth.refresh()
        auth.token = next.token
        continue
      }

      // 3) both paths exhausted and still 401 — credentials are stale.
      diag.error("auth.refresh", "401 persists after token refresh; credentials are stale")
      throw err
    }
  }
}
