/**
 * Provider-declared auth strategy helpers.
 *
 * This module is the host-side facade over provider plugin auth hooks. It
 * keeps credential lookup policy generic while providers own their service
 * ids and store codecs.
 *
 * @module auth-strategies
 */

import { defaultAuthStore } from "./auth-store.ts"
import type { ProviderAuth } from "./llm/provider.ts"
import {
  type ApiKeyAuthProvider,
  findProviderPlugin,
  listProviderPlugins,
  type OAuthLoginProvider,
} from "./llm/provider-plugin.ts"

/** List registered provider OAuth login strategies. */
export function listOAuthLoginProviders(): OAuthLoginProvider[] {
  return listProviderPlugins()
    .map((p) => p.oauthLogin)
    .filter((p): p is OAuthLoginProvider => p !== undefined)
}

/** List registered provider OAuth login strategies with their owning provider ids. */
export function listOAuthLoginProviderEntries(): Array<{
  providerId: string
  auth: OAuthLoginProvider
}> {
  return listProviderPlugins().flatMap((p) =>
    p.oauthLogin ? [{ providerId: p.id, auth: p.oauthLogin }] : [],
  )
}

/** Find a provider OAuth login strategy, or the default one when no id is supplied. */
export function findOAuthLoginProvider(providerId?: string): OAuthLoginProvider | undefined {
  if (!providerId) return listOAuthLoginProviders()[0]
  return findProviderPlugin(providerId)?.oauthLogin
}

/** List registered provider API-key auth strategies with their owning provider ids. */
export function listApiKeyAuthProviders(): Array<{ providerId: string; auth: ApiKeyAuthProvider }> {
  return listProviderPlugins().flatMap((p) =>
    p.apiKeyAuth ? [{ providerId: p.id, auth: p.apiKeyAuth }] : [],
  )
}

/** Find the API-key auth strategy for a provider id. */
export function findApiKeyAuthProvider(providerId: string): ApiKeyAuthProvider | undefined {
  return findProviderPlugin(providerId)?.apiKeyAuth
}

/** Resolve runtime auth for a provider from minimal-agent's own auth store only. */
export function resolveStoredProviderAuth(providerId: string, modelId: string): ProviderAuth {
  const plugin = findProviderPlugin(providerId)
  if (!plugin) {
    throw new Error(
      `canonical transport: no credential strategy for provider "${providerId}" ` +
        `(model "${modelId}"). Provider plugin is not registered.`,
    )
  }

  const store = defaultAuthStore()

  const oauth = plugin.oauthLogin
  if (oauth?.readAuth) {
    const storedSecrets = store.getSecrets(oauth.serviceId, oauth.displayName)
    const auth = storedSecrets ? oauth.readAuth(storedSecrets) : null
    if (auth) return auth
  }

  const apiKey = plugin.apiKeyAuth
  if (apiKey) {
    const storedSecrets = store.getSecrets(apiKey.serviceId, apiKey.displayName)
    const stored = storedSecrets ? apiKey.readApiKey(storedSecrets) : null
    if (stored && stored.trim().length > 0) return { kind: "api-key", key: stored }
  }

  throw new Error(
    `canonical transport: no stored credentials for provider "${providerId}" ` +
      `(model "${modelId}"). Run ` +
      `minimal-agent provider ${providerId} login.`,
  )
}
