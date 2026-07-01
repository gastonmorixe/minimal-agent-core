/**
 * HuggingFace API-key auth strategy.
 *
 * HuggingFace Inference Providers uses a Bearer token for authentication.
 * The token needs "Make calls to Inference Providers" permission
 * (fine-grained) or is a standard user access token. The host stores the
 * credential via the login command; the plugin never reads env vars.
 *
 * @module llm/providers/huggingface/auth
 */

import type {
  ApiKeyAuthProvider,
  AuthCredentialInfo,
  AuthSecretBag,
} from "@minimal-agent/plugin-api/llm/provider-plugin"

export const HUGGINGFACE_API_KEY_AUTH = {
  serviceId: "huggingface-api-key",
  displayName: "HuggingFace API Token",
} as const

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Encode a HuggingFace token into this provider's opaque secret bag. */
export function huggingfaceApiKeyToSecrets(apiKey: string): AuthSecretBag {
  return { tokenType: "api-key", apiKey }
}

/** Build the host-persistable credential write for a HuggingFace token. */
export function buildHuggingfaceApiKeyCredential(apiKey: string) {
  return {
    serviceId: HUGGINGFACE_API_KEY_AUTH.serviceId,
    displayName: HUGGINGFACE_API_KEY_AUTH.displayName,
    secrets: huggingfaceApiKeyToSecrets(apiKey),
  }
}

/** Decode a HuggingFace token from this provider's opaque secret bag. */
export function readHuggingfaceApiKey(secrets: AuthSecretBag): string | null {
  return str(secrets.apiKey) ?? null
}

/** Inspect stored HuggingFace token metadata without exposing the secret. */
export function inspectHuggingfaceApiKeyCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  const apiKey = readHuggingfaceApiKey(secrets)
  return {
    usable: Boolean(apiKey && apiKey.trim().length > 0),
  }
}

export const huggingfaceApiKeyAuth: ApiKeyAuthProvider = {
  ...HUGGINGFACE_API_KEY_AUTH,
  buildCredential: buildHuggingfaceApiKeyCredential,
  readApiKey: readHuggingfaceApiKey,
  inspectCredential: inspectHuggingfaceApiKeyCredential,
}
