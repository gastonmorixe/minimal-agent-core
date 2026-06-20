/**
 * Wafer API-key auth strategy.
 *
 * Wafer Serverless uses Bearer tokens in the `Authorization` header.
 * Keys follow the `wfr_<hex>` format (see https://docs.wafer.ai/serverless/api-keys).
 *
 * Shape mirrors `openrouter/auth.ts` and `openai/auth.ts` exactly so
 * the provider-auth store can treat Wafer identically to other API-key
 * providers.
 *
 * @module llm/providers/wafer/auth
 */

import type {
  ApiKeyAuthProvider,
  AuthCredentialInfo,
  AuthSecretBag,
} from "@minimal-agent/plugin-api/llm/provider-plugin"

export const WAFER_API_KEY_AUTH = {
  serviceId: "wafer-api-key",
  displayName: "Wafer API Key",
} as const

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Encode a Wafer API key into this provider's opaque secret bag. */
export function waferApiKeyToSecrets(apiKey: string): AuthSecretBag {
  return { tokenType: "api-key", apiKey }
}

/** Build the host-persistable credential write for a Wafer API key. */
export function buildWaferApiKeyCredential(apiKey: string) {
  return {
    serviceId: WAFER_API_KEY_AUTH.serviceId,
    displayName: WAFER_API_KEY_AUTH.displayName,
    secrets: waferApiKeyToSecrets(apiKey),
  }
}

/** Decode a Wafer API key from this provider's opaque secret bag. */
export function readWaferApiKey(secrets: AuthSecretBag): string | null {
  return str(secrets.apiKey) ?? null
}

/** Inspect stored Wafer API-key metadata without exposing the secret. */
export function inspectWaferApiKeyCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  const apiKey = readWaferApiKey(secrets)
  return {
    usable: Boolean(apiKey && apiKey.trim().length > 0),
  }
}

export const waferApiKeyAuth: ApiKeyAuthProvider = {
  ...WAFER_API_KEY_AUTH,
  buildCredential: buildWaferApiKeyCredential,
  readApiKey: readWaferApiKey,
  inspectCredential: inspectWaferApiKeyCredential,
}
