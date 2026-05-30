/**
 * Shared 401 recovery primitive: the keychain-first peer-token probe.
 *
 * Extracted from `client.ts` so `sendMessageOnce` (chat) and `checkQuota`
 * (quota probe) share ONE implementation of the multi-process race
 * mitigation, instead of duplicating the read-keychain / compare / retry
 * decision in two places.
 *
 * Background (May 2026): when many agent processes share one keychain
 * entry, server-side refresh-token rotation makes each `auth.refresh()`
 * invalidate the access tokens cached by every OTHER process. They each
 * 401 on their next request, refresh, invalidate the previous one, and the
 * cycle never settles. Net-dbg trace from session c0ab6ba6: 24/105
 * requests in a single 5-minute window returned 401, with 22 refreshes.
 *
 * The fix: on a 401, re-read the keychain BEFORE calling `auth.refresh()`.
 * If a peer process already wrote a fresher access token, adopt it
 * directly : no oauth round-trip, no rotation, no race. Only when the
 * keychain has nothing fresher does the caller fall back to its own
 * `auth.refresh()`. Collapses N concurrent refreshes per "true expiry"
 * event into 1.
 */

import { type AuthResult, readCredentials } from "../auth.ts"
import type { NetworkResponse } from "../network/index.ts"

/** Outcome of the keychain-first peer-token probe. */
export interface KeychainRecoveryResult {
  /**
   * True when a peer-rotated token was found in the keychain AND the retry
   * with it returned a 2xx. The caller treats the request as recovered and
   * skips its own `auth.refresh()` fallback.
   */
  recovered: boolean
  /**
   * The response from retrying with the peer token, present only when a
   * fresher keychain token was found and tried (whether or not the retry
   * succeeded). The caller reassigns its own `response` from this so the
   * subsequent `response.status` check reflects the retry. Absent when the
   * keychain had nothing newer than the token we just 401'd on.
   */
  response?: NetworkResponse
}

/**
 * Keychain-first 401 recovery. On a 401, re-read the keychain; if a peer
 * process already rotated to a fresher access token, adopt it (mutating
 * `auth.token` in place so future turns reuse it) and retry via
 * `doRequest`. Returns whether the retry recovered, plus the retry
 * response so the caller can re-check its status before falling back to
 * `auth.refresh()`.
 *
 * Fail-quiet: any keychain read or retry error is swallowed and surfaced
 * as `{ recovered: false }` so the caller's refresh fallback runs. This is
 * the single source of truth for the keychain-first decision; the
 * `auth.refresh()` fallback (with its caller-specific status UI, error
 * wrapping, and persistent-401 handling) stays in each caller.
 *
 * @param args.auth Credentials whose `.token` is compared + mutated in place.
 * @param args.doRequest Re-issues the request with a given bearer token.
 * @param args.onPeerRotated Fired right before retrying with a peer token
 *   (callers use it for status-bar + diag UI).
 * @param args.onPeerRecovered Fired after the peer-token retry returns 2xx.
 * @returns Whether a peer token recovered the request, and the retry response.
 */
export async function recoverFrom401ViaKeychain(args: {
  auth: AuthResult
  doRequest: (token: string) => Promise<NetworkResponse>
  onPeerRotated?: () => void
  onPeerRecovered?: () => void
}): Promise<KeychainRecoveryResult> {
  const { auth, doRequest, onPeerRotated, onPeerRecovered } = args
  try {
    const fresh = readCredentials()
    const freshToken = fresh?.claudeAiOauth?.accessToken
    if (freshToken && freshToken !== auth.token) {
      onPeerRotated?.()
      auth.token = freshToken
      const response = await doRequest(freshToken)
      if (response.ok) {
        onPeerRecovered?.()
        return { recovered: true, response }
      }
      return { recovered: false, response }
    }
  } catch {
    // Keychain read failures are non-fatal; the caller's refresh path is
    // the authoritative recovery anyway.
  }
  return { recovered: false }
}
