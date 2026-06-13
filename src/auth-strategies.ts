/**
 * Provider-declared auth strategy helpers.
 *
 * This module is the host-side facade over provider plugin auth hooks. It
 * keeps credential lookup policy generic while providers own their service
 * ids, environment variable names, config keys, and store codecs.
 *
 * @module auth-strategies
 */

import { defaultAuthStore } from "./auth-store.ts"
import { loadUserConfig } from "./config.ts"
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

/** Resolve API-key auth for a provider from env, config, then the host auth store. */
export function resolveApiKeyAuth(providerId: string, modelId: string): ProviderAuth {
  const strategy = findApiKeyAuthProvider(providerId)
  if (!strategy) {
    throw new Error(
      `canonical transport: no credential strategy for provider "${providerId}" ` +
        `(model "${modelId}"). Add apiKeyAuth or oauthLogin to that provider plugin.`,
    )
  }

  for (const envVar of strategy.envVars) {
    const value = process.env[envVar]
    if (value && value.trim().length > 0) return { kind: "api-key", key: value }
  }

  const configKey = strategy.configKey
  if (configKey) {
    const apiKeys = loadUserConfig().apiKeys as Record<string, string | undefined> | undefined
    const value = apiKeys?.[configKey]
    if (value && value.trim().length > 0) return { kind: "api-key", key: value }
  }

  const storedSecrets = defaultAuthStore().getSecrets(strategy.serviceId, strategy.displayName)
  const stored = storedSecrets ? strategy.readApiKey(storedSecrets) : null
  if (stored && stored.trim().length > 0) return { kind: "api-key", key: stored }

  const envHint = strategy.envVars.length > 0 ? strategy.envVars.join(" or ") : "an env var"
  const configHint = configKey
    ? `, add "apiKeys.${configKey}" to ~/.minimal-agent/config.jsonc`
    : ""
  throw new Error(
    `canonical transport: no API key for provider "${providerId}" (model "${modelId}"). ` +
      `Set ${envHint}${configHint}, or run ` +
      `minimal-agent --login --provider ${providerId} --api-key.`,
  )
}
