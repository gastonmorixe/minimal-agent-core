/**
 * Startup auth selection for the selected model's provider.
 *
 * Keeps `src/index.ts` as the composition root while moving provider-auth
 * bridging out of the entrypoint. The legacy agent still accepts `AuthResult`;
 * this module maps stored provider credentials into that shape.
 *
 * @module startup/provider-auth
 */

import type { AuthResult, TokenAuthResult } from "../../auth/auth.ts"
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
 * throw with provider-specific login guidance.
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
    throw new Error(`no provider selected for model "${modelId}". ${storedProvidersHint()}`)
  }

  if (providerId === "generic-endpoint") {
    return { type: "provider", auth: resolveGenericEndpointAuth(generic) }
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

function resolveGenericEndpointAuth(opts?: GenericEndpointAuthOptions): ProviderAuth {
  const authType = opts?.authType ?? (opts?.apiKey ? "bearer" : "none")
  switch (authType) {
    case "none":
      return { kind: "custom", headers: {} }
    case "api-key":
    case "bearer": {
      const key = opts?.apiKey?.trim()
      if (!key) throw new Error(`generic-endpoint auth-type ${authType} requires --api-key`)
      return { kind: "api-key", key }
    }
    case "custom-header": {
      const key = opts?.apiKey?.trim()
      const header = opts?.authHeader?.trim()
      if (!key) throw new Error("generic-endpoint auth-type custom-header requires --api-key")
      if (!header)
        throw new Error("generic-endpoint auth-type custom-header requires --auth-header")
      return { kind: "custom", headers: { [header]: key } }
    }
    default: {
      const _exhaustive: never = authType
      throw new Error(`unhandled generic-endpoint auth-type: ${_exhaustive}`)
    }
  }
}

function refreshBridge(refresh: () => Promise<{ token: string }>): () => Promise<TokenAuthResult> {
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
  return `${auth.type}${auth.type !== "provider" && auth.accountUuid ? ` ${c.dim(`(account: ${auth.accountUuid.slice(0, 8)}...)`)}` : ""}`
}
