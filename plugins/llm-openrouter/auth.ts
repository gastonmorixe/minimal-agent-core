/**
 * OpenRouter API-key auth strategy.
 *
 * @module llm/providers/openrouter/auth
 */

import type {
  ApiKeyAuthProvider,
  AuthCredentialInfo,
  AuthSecretBag,
} from "@minimal-agent/plugin-api/llm/provider-plugin"

export const OPENROUTER_API_KEY_AUTH = {
  serviceId: "openrouter-api-key",
  displayName: "OpenRouter API Key",
} as const

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Encode an OpenRouter API key into this provider's opaque secret bag. */
export function openRouterApiKeyToSecrets(apiKey: string): AuthSecretBag {
  return { tokenType: "api-key", apiKey }
}

/** Build the host-persistable credential write for an OpenRouter API key. */
export function buildOpenRouterApiKeyCredential(apiKey: string) {
  return {
    serviceId: OPENROUTER_API_KEY_AUTH.serviceId,
    displayName: OPENROUTER_API_KEY_AUTH.displayName,
    secrets: openRouterApiKeyToSecrets(apiKey),
  }
}

/** Decode an OpenRouter API key from this provider's opaque secret bag. */
export function readOpenRouterApiKey(secrets: AuthSecretBag): string | null {
  return str(secrets.apiKey) ?? null
}

/** Inspect stored OpenRouter API-key metadata without exposing the secret. */
export function inspectOpenRouterApiKeyCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  const apiKey = readOpenRouterApiKey(secrets)
  return {
    usable: Boolean(apiKey && apiKey.trim().length > 0),
  }
}

export const openRouterApiKeyAuth: ApiKeyAuthProvider = {
  ...OPENROUTER_API_KEY_AUTH,
  buildCredential: buildOpenRouterApiKeyCredential,
  readApiKey: readOpenRouterApiKey,
  inspectCredential: inspectOpenRouterApiKeyCredential,
}
