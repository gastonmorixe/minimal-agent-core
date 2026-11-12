/**
 * Startup auth selection for the selected model's provider.
 *
 * Keeps the host entry point as the composition root while moving provider-auth
 * bridging out of the entrypoint. The legacy agent still accepts `AuthResult`;
 * this module maps stored provider credentials into that shape.
 *
 * @module startup/provider-auth
 */

import type { ProviderAuth } from "../llm/provider.ts"
import { findProviderPlugin } from "../llm/provider-plugin.ts"

import type { AuthResult, TokenAuthResult } from "./auth.ts"
import {
  listStoredProviderFacts,
  resolveAnonymousProviderAuth,
  tryResolveProviderAuth,
} from "./auth-strategies.ts"
import {
  GenericEndpointAuthError,
  NoProviderCredentialsError,
  NoProviderSelectedError,
  UnhandledAuthTypeError,
} from "./errors.ts"

/** Map neutral {@link ProviderAuth} into the legacy {@link AuthResult} shape. */
export function providerAuthToAuthResult(auth: ProviderAuth): AuthResult {
  switch (auth.kind) {
    case "api-key":
      return { type: "api-key", token: auth.key }
    case "oauth":
      // Plan backends often carry provider-owned `baseUrl` / `headers` on
      // ProviderAuth. The legacy TokenAuthResult shape has no fields for
      // those, so stripping them sends compact / non-canonical paths to the
      // public API host with a plan token → 401 → silent local compact.
      // Keep the full ProviderAuth when present.
      if (auth.baseUrl || auth.headers) {
        return { type: "provider", auth }
      }
      return {
        type: "oauth",
        token: auth.token,
        ...(auth.refresh ? { refresh: refreshBridge(auth.refresh) } : {}),
      }
    case "custom":
      return { type: "provider", auth }
    default: {
      const _exhaustive: never = auth
      throw new Error(`unhandled provider auth kind: ${_exhaustive}`)
    }
  }
}

/**
 * Options describing how to authenticate against a user-supplied generic
 * OpenAI-compatible endpoint (the `generic-endpoint` pseudo-provider).
 */
export interface GenericEndpointAuthOptions {
  endpoint?: string
  format?: string
  authType?: "api-key" | "bearer" | "none" | "custom-header"
  apiKey?: string
  authHeader?: string
}

/**
 * Resolve startup credentials for the selected provider.
 *
 * Requires a registered model with a known provider. Missing credentials
 * throw with provider-specific login guidance, unless the provider declares
 * `anonymousAuth` and no explicit credential name was pinned. Then the
 * anonymous auth is returned (see {@link isAnonymousStartupAuth}).
 *
 * @param providerId - Provider slug to resolve.
 * @param modelId - Normalized model id (no `[1m]`/`[2m]` suffix).
 * @param credentialName - Optional credential name to disambiguate when the
 *   provider has multiple stored credentials. When omitted, the provider's
 *   default displayName is used.
 * @param generic - Options for the `generic-endpoint` pseudo-provider.
 */
export async function resolveStartupAuth(
  providerId: string | undefined,
  modelId: string,
  credentialName?: string,
  generic?: GenericEndpointAuthOptions,
): Promise<AuthResult> {
  if (process.env.MINIMAL_AGENT_TEST_AUTH === "1") {
    return { type: "oauth", token: "test-token", accountUuid: "test-account" }
  }

  if (providerId === undefined) {
    throw new NoProviderSelectedError(modelId, listStoredProviderFacts())
  }

  if (providerId === "generic-endpoint") {
    return { type: "provider", auth: resolveGenericEndpointAuth(generic) }
  }

  const auth = tryResolveProviderAuth(providerId, modelId, credentialName)
  if (!auth) {
    const anonymous = resolveAnonymousProviderAuth(providerId, credentialName)
    if (anonymous) {
      const result = providerAuthToAuthResult(anonymous)
      anonymousResults.add(result)
      return result
    }
    throw new NoProviderCredentialsError(providerId, modelId, listStoredProviderFacts())
  }

  return providerAuthToAuthResult(auth)
}

function resolveGenericEndpointAuth(opts?: GenericEndpointAuthOptions): ProviderAuth {
  const authType = opts?.authType ?? (opts?.apiKey ? "bearer" : "none")
  switch (authType) {
    case "none":
      return { kind: "custom", headers: {} }
    case "api-key":
    case "bearer": {
      const key = opts?.apiKey?.trim()
      if (!key) throw new GenericEndpointAuthError(authType, "api-key")
      return { kind: "api-key", key }
    }
    case "custom-header": {
      const key = opts?.apiKey?.trim()
      const header = opts?.authHeader?.trim()
      if (!key) throw new GenericEndpointAuthError("custom-header", "api-key")
      if (!header) throw new GenericEndpointAuthError("custom-header", "auth-header")
      return { kind: "custom", headers: { [header]: key } }
    }
    default: {
      const _exhaustive: never = authType
      throw new UnhandledAuthTypeError(String(_exhaustive))
    }
  }
}

function refreshBridge(refresh: () => Promise<{ token: string }>): () => Promise<TokenAuthResult> {
  return async () => {
    const refreshed = await refresh()
    return { type: "oauth", token: refreshed.token }
  }
}

/** Startup auth results built from `ProviderPlugin.anonymousAuth`. */
const anonymousResults = new WeakSet<AuthResult>()

/** True when {@link resolveStartupAuth} returned the provider's anonymous auth. */
export function isAnonymousStartupAuth(auth: AuthResult): boolean {
  return anonymousResults.has(auth)
}

/** Data for the auth row of the startup tree. The host renders the text. */
export interface StartupAuthDescription {
  kind: "anonymous" | "provider-plugin" | "plain"
  type: string
  providerId?: string
  /** First 8 chars of the account uuid ("plain" kind only). */
  accountPrefix?: string
}

/** Describe the startup auth as data. Core owns no text here. */
export function describeStartupAuth(
  auth: AuthResult,
  providerId: string | undefined,
): StartupAuthDescription {
  if (providerId && isAnonymousStartupAuth(auth)) {
    return { kind: "anonymous", type: auth.type, providerId }
  }
  if (providerId && findProviderPlugin(providerId)) {
    return { kind: "provider-plugin", type: auth.type, providerId }
  }
  return {
    kind: "plain",
    type: auth.type,
    ...(auth.type !== "provider" && auth.accountUuid
      ? { accountPrefix: auth.accountUuid.slice(0, 8) }
      : {}),
  }
}
