/**
 * Startup auth selection for the selected model's provider.
 *
 * Keeps `src/index.ts` as the composition root while moving provider-auth
 * bridging out of the entrypoint. The legacy agent still accepts `AuthResult`;
 * this module maps stored provider credentials into that shape without making
 * startup prompt credentials for providers that own their own auth strategies.
 *
 * @module startup/provider-auth
 */

import type { AuthResult } from "../auth.ts"
import { resolveStoredProviderAuth } from "../auth-strategies.ts"
import { findProviderPlugin } from "../llm/provider-plugin.ts"
import { c } from "../ui/style/ansi.ts"

import { getAuthWithFirstTimePrompt } from "./auth-prompt.ts"

/**
 * Resolve startup credentials for the selected provider.
 *
 * Providers can opt into the legacy host prompt while that compatibility path
 * exists. Otherwise, startup reads minimal-agent's host-owned provider store.
 */
export async function resolveStartupAuth(
  providerId: string | undefined,
  modelId: string,
): Promise<AuthResult> {
  const plugin = providerId ? findProviderPlugin(providerId) : undefined
  if (providerId === undefined || plugin?.usesLegacyStartupAuth) {
    return getAuthWithFirstTimePrompt()
  }
  const auth = resolveStoredProviderAuth(providerId, modelId)
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
      throw new Error(`provider "${providerId}" uses custom auth that startup cannot bridge yet`)
    default: {
      const _exhaustive: never = auth
      throw new Error(`unhandled provider auth kind: ${_exhaustive}`)
    }
  }
}

function refreshBridge(refresh: () => Promise<{ token: string }>): () => Promise<AuthResult> {
  return async () => {
    const refreshed = await refresh()
    return { type: "oauth", token: refreshed.token }
  }
}

/** Render the auth row shown in the startup tree. */
export function startupAuthLabel(auth: AuthResult, providerId: string | undefined): string {
  const plugin = providerId ? findProviderPlugin(providerId) : undefined
  if (providerId && !plugin?.usesLegacyStartupAuth) {
    return `${auth.type} ${c.dim(`(${providerId})`)}`
  }
  return `${auth.type}${auth.accountUuid ? ` ${c.dim(`(account: ${auth.accountUuid.slice(0, 8)}...)`)}` : ""}`
}
