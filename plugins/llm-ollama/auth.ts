/**
 * Ollama Cloud API-key auth strategy.
 *
 * Direct ollama.com API access uses a Bearer API key (created at
 * https://ollama.com/settings/keys, normally exported as `OLLAMA_API_KEY`).
 * minimal-agent stores it in the provider auth store under this strategy's
 * service id and hands it back to the adapter as
 * `RunContext.auth = { kind: "api-key", key }`.
 *
 * @module llm/providers/ollama/auth
 */

import type {
  ApiKeyAuthProvider,
  AuthCredentialInfo,
  AuthSecretBag,
} from "@minimal-agent/plugin-api/llm/provider-plugin"

export const OLLAMA_API_KEY_AUTH = {
  serviceId: "ollama-api-key",
  displayName: "Ollama Cloud API Key",
} as const

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Encode an Ollama Cloud API key into this provider's opaque secret bag. */
export function ollamaApiKeyToSecrets(apiKey: string): AuthSecretBag {
  return { tokenType: "api-key", apiKey }
}

/** Build the host-persistable credential write for an Ollama Cloud API key. */
export function buildOllamaApiKeyCredential(apiKey: string) {
  return {
    serviceId: OLLAMA_API_KEY_AUTH.serviceId,
    displayName: OLLAMA_API_KEY_AUTH.displayName,
    secrets: ollamaApiKeyToSecrets(apiKey),
  }
}

/** Decode an Ollama Cloud API key from this provider's opaque secret bag. */
export function readOllamaApiKey(secrets: AuthSecretBag): string | null {
  return str(secrets.apiKey) ?? null
}

/** Inspect stored Ollama Cloud API-key metadata without exposing the secret. */
export function inspectOllamaApiKeyCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  const apiKey = readOllamaApiKey(secrets)
  return {
    usable: Boolean(apiKey && apiKey.trim().length > 0),
    label: OLLAMA_API_KEY_AUTH.displayName,
  }
}

export const ollamaApiKeyAuth: ApiKeyAuthProvider = {
  ...OLLAMA_API_KEY_AUTH,
  buildCredential: buildOllamaApiKeyCredential,
  readApiKey: readOllamaApiKey,
  inspectCredential: inspectOllamaApiKeyCredential,
}
