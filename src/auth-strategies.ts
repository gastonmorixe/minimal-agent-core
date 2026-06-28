/**
 * Provider-declared auth strategy helpers.
 *
 * This module is the host-side facade over provider plugin auth hooks. It
 * keeps credential lookup policy generic while providers own their service
 * ids and store codecs.
 *
 * @module auth-strategies
 */

import type { AuthStore } from "./auth-store.ts"
import { defaultAuthStore } from "./auth-store.ts"
import { findModelByTags, listRegisteredModels } from "./llm/model-registry.ts"
import type { ProviderAuth } from "./llm/provider.ts"
import {
  type ApiKeyAuthProvider,
  type AuthCredentialInfo,
  type AuthSecretBag,
  findProviderPlugin,
  listProviderPlugins,
  type OAuthLoginProvider,
} from "./llm/provider-plugin.ts"
import { defaultNetworkClient } from "./network/index.ts"

/** Summary of a provider the host can authenticate against. */
export interface CredentialedProvider {
  providerId: string
  displayName: string
  authKind: "oauth" | "api-key"
  /** Where the credential came from for this summary. */
  source: "store"
  /** Human label of the stored entry, when `source === "store"`. */
  credentialLabel?: string
  /** Provider-supplied safe diagnostic metadata, when available. */
  credentialInfo?: AuthCredentialInfo
}

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

function readOAuthFromStore(
  oauth: OAuthLoginProvider,
  store: AuthStore,
): { auth: ProviderAuth; secrets: AuthSecretBag } | null {
  if (!oauth.readAuth) return null
  const storedSecrets = store.getSecrets(oauth.serviceId, oauth.displayName)
  if (!storedSecrets) return null
  const auth = oauth.readAuth(storedSecrets)
  if (!auth) return null
  if (auth.kind === "oauth" && oauth.refreshCredential) {
    return {
      auth: {
        ...auth,
        refresh: buildStoredOAuthRefresh({ provider: oauth, initialSecrets: storedSecrets }),
      },
      secrets: storedSecrets,
    }
  }
  return { auth, secrets: storedSecrets }
}

function readApiKeyFromStore(apiKey: ApiKeyAuthProvider, store: AuthStore): ProviderAuth | null {
  const storedSecrets = store.getSecrets(apiKey.serviceId, apiKey.displayName)
  const stored = storedSecrets ? apiKey.readApiKey(storedSecrets) : null
  if (stored && stored.trim().length > 0) return { kind: "api-key", key: stored }
  return null
}

/**
 * Store-first peer-rotation read for the transport's 401 recovery: return
 * the provider's CURRENT stored OAuth access token (re-read from the store, so
 * a peer process's rotation is picked up) WITHOUT a network refresh, or
 * undefined when there is none.
 *
 * Provider-neutral: it asks the resolved provider's own OAuth strategy
 * (`serviceId` + `readAuth`) for the token, so core never reads any single
 * provider's credential shape. This is the host-side half of the multi-process
 * race fix the canonical transport's `withAuthRefresh` consumes via its
 * injected `peerToken` hook.
 */
export function providerPeerToken(
  providerId: string,
  store: AuthStore = defaultAuthStore(),
): string | undefined {
  const oauth = findProviderPlugin(providerId)?.oauthLogin
  if (!oauth?.readAuth) return undefined
  const secrets = store.getSecrets(oauth.serviceId, oauth.displayName)
  if (!secrets) return undefined
  const auth = oauth.readAuth(secrets)
  return auth?.kind === "oauth" ? auth.token : undefined
}

/** Try to resolve runtime auth for a provider from minimal-agent's auth store only. */
export function tryResolveProviderAuth(providerId: string, _modelId = ""): ProviderAuth | null {
  const plugin = findProviderPlugin(providerId)
  if (!plugin) return null

  const store = defaultAuthStore()

  const oauth = plugin.oauthLogin
  if (oauth) {
    const fromStore = readOAuthFromStore(oauth, store)
    if (fromStore) return fromStore.auth
  }

  const apiKey = plugin.apiKeyAuth
  if (apiKey) {
    const fromStore = readApiKeyFromStore(apiKey, store)
    if (fromStore) return fromStore
  }

  return null
}

/** Resolve runtime auth for a provider or throw with a provider-specific hint. */
export function resolveStoredProviderAuth(providerId: string, modelId: string): ProviderAuth {
  const plugin = findProviderPlugin(providerId)
  if (!plugin) {
    throw new Error(
      `canonical transport: no credential strategy for provider "${providerId}" ` +
        `(model "${modelId}"). Provider plugin is not registered.`,
    )
  }

  const auth = tryResolveProviderAuth(providerId, modelId)
  if (auth) return auth

  const others = discoverCredentialedProviders().filter((p) => p.providerId !== providerId)
  const extra =
    others.length > 0
      ? ` Other logged-in providers: ${others.map((p) => p.providerId).join(", ")}.`
      : ""

  throw new Error(
    `canonical transport: no credentials for provider "${providerId}" ` +
      `(model "${modelId}"). Run ` +
      `minimal-agent provider ${providerId} login.${extra}`,
  )
}

/** Providers with credentials stored in minimal-agent's auth store. */
export function discoverCredentialedProviders(
  store: AuthStore = defaultAuthStore(),
): CredentialedProvider[] {
  const out: CredentialedProvider[] = []

  for (const plugin of listProviderPlugins()) {
    const oauth = plugin.oauthLogin
    if (oauth?.readAuth) {
      const storedSecrets = store.getSecrets(oauth.serviceId, oauth.displayName)
      if (storedSecrets) {
        const auth = oauth.readAuth(storedSecrets)
        const info = oauth.inspectCredential?.(storedSecrets)
        out.push({
          providerId: plugin.id,
          displayName: plugin.displayName,
          authKind: "oauth",
          source: "store",
          credentialLabel: oauth.displayName,
          credentialInfo: info ?? { usable: Boolean(auth) },
        })
        continue
      }
    }

    const apiKey = plugin.apiKeyAuth
    if (!apiKey) continue

    const storedSecrets = store.getSecrets(apiKey.serviceId, apiKey.displayName)
    if (storedSecrets) {
      const stored = apiKey.readApiKey(storedSecrets)
      const usable = Boolean(stored && stored.trim().length > 0)
      out.push({
        providerId: plugin.id,
        displayName: plugin.displayName,
        authKind: "api-key",
        source: "store",
        credentialLabel: apiKey.displayName,
        credentialInfo: apiKey.inspectCredential?.(storedSecrets) ?? { usable },
      })
    }
  }

  return out
}

/**
 * Discover providers that have stored credentials.
 *
 * @deprecated Use {@link discoverCredentialedProviders}.
 */
export function discoverStoredProviders(
  store: AuthStore = defaultAuthStore(),
): CredentialedProvider[] {
  return discoverCredentialedProviders(store)
}

/** Example model ids registered for `providerId` (up to `limit`). */
export function exampleModelsForProvider(providerId: string, limit = 2): string[] {
  const ids: string[] = []
  for (const entry of listRegisteredModels()) {
    if (entry.providerId !== providerId) continue
    ids.push(entry.id)
    if (ids.length >= limit) break
  }
  return ids
}

/** A representative default model id for `providerId`, when one exists in the registry. */
export function suggestModelForProvider(providerId: string): string | undefined {
  const cheap = findModelByTags(providerId, ["cheap"])
  if (cheap) return cheap.id
  const first = listRegisteredModels().find((m) => m.providerId === providerId)
  return first?.id
}

/** Human hint listing credentialed providers and example model ids. */
export function storedProvidersHint(): string {
  const providers = discoverCredentialedProviders()
  if (providers.length === 0) {
    return (
      "No provider credentials found. Run `minimal-agent provider <id> login` " +
      "(e.g. `minimal-agent provider example-provider login`)."
    )
  }

  const lines = providers.map((p) => {
    const examples = exampleModelsForProvider(p.providerId)
    const exampleText =
      examples.length > 0 ? ` — e.g. ${examples.map((id) => `"${id}"`).join(", ")}` : ""
    const label = p.credentialLabel ?? p.displayName
    return `${p.providerId} (${label})${exampleText}`
  })

  return (
    `Logged in: ${lines.join("; ")}. ` +
    `Set "model" and "provider" in ~/.minimal-agent/config.jsonc or pass --provider <id> --model <id>.`
  )
}

/** Remove all credential store entries owned by a provider plugin. */
export function clearProviderCredentials(
  providerId: string,
  store: AuthStore = defaultAuthStore(),
): boolean {
  const plugin = findProviderPlugin(providerId)
  if (!plugin) return false
  let removed = false
  if (plugin.oauthLogin) {
    removed = store.remove(plugin.oauthLogin.serviceId, plugin.oauthLogin.displayName) || removed
  }
  if (plugin.apiKeyAuth) {
    removed = store.remove(plugin.apiKeyAuth.serviceId, plugin.apiKeyAuth.displayName) || removed
  }
  return removed
}

/** Remove every credential in the auth store. */
export function clearAllCredentials(store: AuthStore = defaultAuthStore()): boolean {
  const had = store.list().length > 0
  store.clear()
  return had
}

function buildStoredOAuthRefresh(opts: {
  provider: OAuthLoginProvider
  initialSecrets: AuthSecretBag
}): () => Promise<{ token: string }> {
  const { provider } = opts
  let lastSecrets = opts.initialSecrets
  return async () => {
    const store = defaultAuthStore()
    const currentSecrets = store.getSecrets(provider.serviceId, provider.displayName) ?? lastSecrets
    const refreshed = await provider.refreshCredential?.(currentSecrets, {
      networkClient: defaultNetworkClient,
    })
    if (!refreshed) throw new Error(`provider "${provider.serviceId}" does not support refresh`)
    store.set(
      refreshed.credential.serviceId,
      refreshed.credential.displayName,
      refreshed.credential.secrets,
    )
    lastSecrets = refreshed.credential.secrets
    const nextAuth = provider.readAuth?.(lastSecrets)
    if (!nextAuth || nextAuth.kind !== "oauth" || !nextAuth.token) {
      throw new Error(`provider "${provider.serviceId}" refreshed credential is not usable`)
    }
    return { token: nextAuth.token }
  }
}
