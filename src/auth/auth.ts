/**
 * Auth result types: the credential shape the agent and the transport carry.
 *
 * Core is provider-neutral (decision 39). It holds no OAuth client, no
 * endpoint, no client id, and no secret-bag codec. Each provider plugin owns
 * those behind the generic provider-plugin auth contract (`oauthLogin`,
 * `apiKeyAuth`, `anonymousAuth`). The host resolves a credential with
 * `auth-strategies.ts` and `provider-auth.ts`, and stores it with
 * `AuthStore` (`auth-store.ts`).
 *
 * @module auth
 */

import type { ProviderAuth } from "@minimal-agent/core/plugin-api/llm/provider-auth"

/**
 * Token-bearing auth: a bearer token (OAuth or API key) with an optional
 * refresh closure.
 */
export interface TokenAuthResult {
  type: "api-key" | "oauth"
  token: string
  accountUuid?: string
  organizationUuid?: string
  /**
   * Callable refresh function for 401 retry. When the API returns 401, the
   * transport calls this to get a fresh token, then retries the request.
   */
  refresh?: () => Promise<TokenAuthResult>
}

/**
 * Provider-native auth that cannot be represented as token auth (e.g. a
 * generic endpoint using a custom header bag). Carried opaquely to the transport.
 */
export interface ProviderNativeAuthResult {
  type: "provider"
  auth: ProviderAuth
}

export type AuthResult = TokenAuthResult | ProviderNativeAuthResult

/**
 * Map an {@link AuthResult} to the provider-neutral {@link ProviderAuth} the
 * canonical transport reads. The inverse is `providerAuthToAuthResult` in
 * `provider-auth.ts`. The OAuth refresh closure is kept and re-shaped to the
 * `{ token }` return. The store-first refresh race fix lives in the
 * transport middleware, not here.
 */
export function authResultToProviderAuth(auth: AuthResult): ProviderAuth {
  if (auth.type === "provider") return auth.auth
  if (auth.type === "api-key") return { kind: "api-key", key: auth.token }
  const refresh = auth.refresh
  if (!refresh) return { kind: "oauth", token: auth.token }
  return {
    kind: "oauth",
    token: auth.token,
    refresh: async () => {
      const refreshed = await refresh()
      if (refreshed.type !== "oauth" && refreshed.type !== "api-key") {
        throw new Error("provider-native auth refresh cannot produce a bearer token")
      }
      return { token: refreshed.token }
    },
  }
}

/** @deprecated Use {@link authResultToProviderAuth}. Kept for external hosts. */
export const legacyAuthToProviderAuth = authResultToProviderAuth
