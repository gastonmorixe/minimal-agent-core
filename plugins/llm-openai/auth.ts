/**
 * OpenAI API-key auth strategy.
 *
 * OpenAI's public API is API-key authenticated here; this plugin does not
 * claim an OAuth login flow. The provider hook lets core resolve keys from
 * env/config/store without hardcoding OpenAI in transport code.
 *
 * @module llm/providers/openai/auth
 */

import type {
  ApiKeyAuthProvider,
  AuthSecretBag,
} from "@minimal-agent/plugin-api/llm/provider-plugin"

export const OPENAI_API_KEY_AUTH = {
  serviceId: "openai-api-key",
  displayName: "OpenAI API Key",
  envVars: ["OPENAI_API_KEY"] as const,
  configKey: "openai",
} as const

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Encode an OpenAI API key into this provider's opaque secret bag. */
export function openAIApiKeyToSecrets(apiKey: string): AuthSecretBag {
  return { tokenType: "api-key", apiKey }
}

/** Build the host-persistable credential write for an OpenAI API key. */
export function buildOpenAIApiKeyCredential(apiKey: string) {
  return {
    serviceId: OPENAI_API_KEY_AUTH.serviceId,
    displayName: OPENAI_API_KEY_AUTH.displayName,
    secrets: openAIApiKeyToSecrets(apiKey),
  }
}

/** Decode an OpenAI API key from this provider's opaque secret bag. */
export function readOpenAIApiKey(secrets: AuthSecretBag): string | null {
  return str(secrets.apiKey) ?? null
}

export const openAIApiKeyAuth: ApiKeyAuthProvider = {
  ...OPENAI_API_KEY_AUTH,
  buildCredential: buildOpenAIApiKeyCredential,
  readApiKey: readOpenAIApiKey,
}
