/**
 * Startup auth selection for the selected model's provider.
 *
 * Keeps `src/index.ts` as the composition root while moving provider-auth
 * bridging out of the entrypoint. The legacy agent still accepts `AuthResult`;
 * this module maps stored provider credentials into that shape.
 *
 * @module startup/provider-auth
 */

import type { AuthResult } from "../../auth/auth.ts"
import { storedProvidersHint, tryResolveProviderAuth } from "../../auth/auth-strategies.ts"
import type { ProviderAuth } from "../../llm/provider.ts"
import { findProviderPlugin } from "../../llm/provider-plugin.ts"
import { c } from "../ui/style/ansi.ts"

/** Map neutral {@link ProviderAuth} into the legacy {@link AuthResult} shape. */
export function providerAuthToAuthResult(auth: ProviderAuth): AuthResult {
  switch (auth.kind) {
    case "api-key":
      return { type: "api-key", token: auth.key }
    case "oauth":
      return {
        type: "oauth",
        token: auth.token,
        ...(auth.refresh ? { refresh: refreshBridge(auth.refresh) } : {}),
      }
    case "custom":
      throw new Error("custom provider auth cannot bridge to legacy AuthResult")
    default: {
      const _exhaustive: never = auth
      throw new Error(`unhandled provider auth kind: ${_exhaustive}`)
    }
  }
}

/**
 * Resolve startup credentials for the selected provider.
 *
 * Requires a registered model with a known provider. Missing credentials
 * throw with provider-specific login guidance.
 *
 * @param providerId - Provider slug to resolve.
 * @param modelId - Normalized model id (no `[1m]`/`[2m]` suffix).
 * @param credentialName - Optional credential name to disambiguate when the
 *   provider has multiple stored credentials. When omitted, the provider's
 *   default displayName is used.
 */
export async function resolveStartupAuth(
  providerId: string | undefined,
  modelId: string,
  credentialName?: string,
): Promise<AuthResult> {
  if (process.env.MINIMAL_AGENT_TEST_AUTH === "1") {
    return { type: "oauth", token: "test-token", accountUuid: "test-account" }
  }

  if (providerId === undefined) {
    throw new Error(`no provider selected for model "${modelId}". ${storedProvidersHint()}`)
  }

  const auth = tryResolveProviderAuth(providerId, modelId, credentialName)
  if (!auth) {
    const hint = storedProvidersHint()
    throw new Error(
      `no credentials for provider "${providerId}" (model "${modelId}"). ` +
        `Run minimal-agent provider ${providerId} login. ${hint}`,
    )
  }

  return providerAuthToAuthResult(auth)
}

function refreshBridge(refresh: () => Promise<{ token: string }>): () => Promise<AuthResult> {
  return async () => {
    const refreshed = await refresh()
    return { type: "oauth", token: refreshed.token }
  }
}

/** Render the auth row shown in the startup tree. */
export function startupAuthLabel(auth: AuthResult, providerId: string | undefined): string {
  if (providerId && findProviderPlugin(providerId)) {
    return `${auth.type} ${c.dim(`(${providerId})`)}`
  }
  return `${auth.type}${auth.accountUuid ? ` ${c.dim(`(account: ${auth.accountUuid.slice(0, 8)}...)`)}` : ""}`
}
