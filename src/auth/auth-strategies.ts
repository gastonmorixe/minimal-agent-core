/**
 * Provider-declared auth strategy helpers.
 *
 * This module is the host-side facade over provider plugin auth hooks. It
 * keeps credential lookup policy generic while providers own their service
 * ids and store codecs.
 *
 * @module auth-strategies
 */

import { findModelByTags, listRegisteredModels } from "../llm/model-registry.ts"
import type { ProviderAuth } from "../llm/provider.ts"
import {
  type ApiKeyAuthProvider,
  type AuthCredentialInfo,
  type AuthSecretBag,
  findProviderPlugin,
  listProviderPlugins,
  type OAuthLoginProvider,
} from "../llm/provider-plugin.ts"
import { defaultNetworkClient } from "../network/index.ts"

import type { AuthStore } from "./auth-store.ts"
import { defaultAuthStore } from "./auth-store.ts"

/** Summary of a provider the host can authenticate against. */
export interface CredentialedProvider {
  providerId: string
  displayName: string
  authKind: "oauth" | "api-key"
  /** Where the credential came from for this summary. */
  source: "store"
  /** Human label of the stored entry, when `source === "store"`. */
  credentialLabel?: string
  /** The stored credential name (disambiguates multiple entries per provider). */
  credentialName?: string
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
  credentialName?: string,
): { auth: ProviderAuth; secrets: AuthSecretBag } | null {
  if (!oauth.readAuth) return null
  const name = credentialName ?? oauth.displayName
  const storedSecrets = store.getSecrets(oauth.serviceId, name)
  if (!storedSecrets) return null
  const auth = oauth.readAuth(storedSecrets)
  if (!auth) return null
  if (auth.kind === "oauth" && oauth.refreshCredential) {
    return {
      auth: {
        ...auth,
        refresh: buildStoredOAuthRefresh({
          provider: oauth,
          initialSecrets: storedSecrets,
          credentialName: name,
        }),
      },
      secrets: storedSecrets,
    }
  }
  return { auth, secrets: storedSecrets }
}

function readApiKeyFromStore(
  apiKey: ApiKeyAuthProvider,
  store: AuthStore,
  credentialName?: string,
): ProviderAuth | null {
  const name = credentialName ?? apiKey.displayName
  const storedSecrets = store.getSecrets(apiKey.serviceId, name)
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
  credentialName?: string,
): string | undefined {
  const oauth = findProviderPlugin(providerId)?.oauthLogin
  if (!oauth?.readAuth) return undefined
  const name = credentialName ?? oauth.displayName
  const secrets = store.getSecrets(oauth.serviceId, name)
  if (!secrets) return undefined
  const auth = oauth.readAuth(secrets)
  return auth?.kind === "oauth" ? auth.token : undefined
}

/**
 * Try to resolve runtime auth for a provider from minimal-agent's auth store only.
 * When `credentialName` is omitted, the provider's default displayName is used
 * as the credential name (backward compatible with single-credential setups).
 * When `credentialName` is given, only that named credential is resolved.
 * Returns `null` when no matching credential exists.
 */
export function tryResolveProviderAuth(
  providerId: string,
  _modelId = "",
  credentialName?: string,
): ProviderAuth | null {
  const plugin = findProviderPlugin(providerId)
  if (!plugin) return null

  const store = defaultAuthStore()

  const oauth = plugin.oauthLogin
  if (oauth) {
    const fromStore = readOAuthFromStore(oauth, store, credentialName)
    if (fromStore) return fromStore.auth
  }

  const apiKey = plugin.apiKeyAuth
  if (apiKey) {
    const fromStore = readApiKeyFromStore(apiKey, store, credentialName)
    if (fromStore) return fromStore
  }

  return null
}

/** Resolve runtime auth for a provider or throw with a provider-specific hint. */
export function resolveStoredProviderAuth(
  providerId: string,
  modelId: string,
  credentialName?: string,
): ProviderAuth {
  const plugin = findProviderPlugin(providerId)
  if (!plugin) {
    throw new Error(
      `canonical transport: no credential strategy for provider "${providerId}" ` +
        `(model "${modelId}"). Provider plugin is not registered.`,
    )
  }

  const auth = tryResolveProviderAuth(providerId, modelId, credentialName)
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

/**
 * Providers with credentials stored in minimal-agent's auth store.
 *
 * Lists ALL stored entries per provider, not just the default displayName.
 * Multiple entries for the same provider (disambiguated by credentialName)
 * each produce a separate CredentialedProvider entry.
 */
export function discoverCredentialedProviders(
  store: AuthStore = defaultAuthStore(),
): CredentialedProvider[] {
  const out: CredentialedProvider[] = []

  for (const plugin of listProviderPlugins()) {
    const oauth = plugin.oauthLogin
    if (oauth?.readAuth) {
      // List ALL store entries matching this provider's serviceId
      const allEntries = store.list(oauth.serviceId)
      for (const entry of allEntries) {
        const storedSecrets = store.getSecrets(oauth.serviceId, entry.name)
        if (!storedSecrets) continue
        const auth = oauth.readAuth(storedSecrets)
        const info = oauth.inspectCredential?.(storedSecrets)
        out.push({
          providerId: plugin.id,
          displayName: plugin.displayName,
          authKind: "oauth",
          source: "store",
          credentialLabel: entry.name,
          credentialName: entry.name,
          credentialInfo: info ?? { usable: Boolean(auth) },
        })
      }
    }

    const apiKey = plugin.apiKeyAuth
    if (apiKey) {
      // List ALL store entries matching this provider's serviceId
      const allEntries = store.list(apiKey.serviceId)
      for (const entry of allEntries) {
        const storedSecrets = store.getSecrets(apiKey.serviceId, entry.name)
        if (!storedSecrets) continue
        const stored = apiKey.readApiKey(storedSecrets)
        const usable = Boolean(stored && stored.trim().length > 0)
        out.push({
          providerId: plugin.id,
          displayName: plugin.displayName,
          authKind: "api-key",
          source: "store",
          credentialLabel: entry.name,
          credentialName: entry.name,
          credentialInfo: apiKey.inspectCredential?.(storedSecrets) ?? { usable },
        })
      }
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

/**
 * Remove all credential store entries owned by a provider plugin.
 * When `credentialName` is given, only that specific entry is removed.
 * When omitted, ALL entries for the provider are removed.
 */
export function clearProviderCredentials(
  providerId: string,
  store: AuthStore = defaultAuthStore(),
  credentialName?: string,
): boolean {
  const plugin = findProviderPlugin(providerId)
  if (!plugin) return false
  let removed = false

  if (credentialName) {
    // Remove a specific named credential
    if (plugin.oauthLogin) {
      removed = store.remove(plugin.oauthLogin.serviceId, credentialName) || removed
    }
    if (plugin.apiKeyAuth) {
      removed = store.remove(plugin.apiKeyAuth.serviceId, credentialName) || removed
    }
  } else {
    // Remove ALL entries for this provider's service ids
    if (plugin.oauthLogin) {
      const entries = store.list(plugin.oauthLogin.serviceId)
      for (const entry of entries) {
        removed = store.remove(plugin.oauthLogin.serviceId, entry.name) || removed
      }
    }
    if (plugin.apiKeyAuth) {
      const entries = store.list(plugin.apiKeyAuth.serviceId)
      for (const entry of entries) {
        removed = store.remove(plugin.apiKeyAuth.serviceId, entry.name) || removed
      }
    }
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
  credentialName?: string
}): () => Promise<{ token: string }> {
  const { provider } = opts
  const credentialName = opts.credentialName ?? provider.displayName
  let lastSecrets = opts.initialSecrets
  return async () => {
    const store = defaultAuthStore()
    const currentSecrets = store.getSecrets(provider.serviceId, credentialName) ?? lastSecrets
    const refreshed = await provider.refreshCredential?.(currentSecrets, {
      networkClient: defaultNetworkClient,
    })
    if (!refreshed) throw new Error(`provider "${provider.serviceId}" does not support refresh`)
    store.set(refreshed.credential.serviceId, credentialName, refreshed.credential.secrets)
    lastSecrets = refreshed.credential.secrets
    const nextAuth = provider.readAuth?.(lastSecrets)
    if (!nextAuth || nextAuth.kind !== "oauth" || !nextAuth.token) {
      throw new Error(`provider "${provider.serviceId}" refreshed credential is not usable`)
    }
    return { token: nextAuth.token }
  }
}
