import type {
  ApiKeyAuthProvider,
  AuthCredentialInfo,
  AuthSecretBag,
} from "@minimal-agent/plugin-api/llm/provider-plugin"

export const OPENCODE_API_KEY_AUTH = {
  serviceId: "opencode-api-key",
  displayName: "OpenCode Go API Key",
} as const

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/** Encode an OpenCode Go API key into this provider's opaque secret bag. */
export function opencodeApiKeyToSecrets(apiKey: string): AuthSecretBag {
  return { tokenType: "api-key", apiKey }
}

/** Build the host-persistable credential write for an OpenCode Go API key. */
export function buildOpencodeApiKeyCredential(apiKey: string) {
  return {
    serviceId: OPENCODE_API_KEY_AUTH.serviceId,
    displayName: OPENCODE_API_KEY_AUTH.displayName,
    secrets: opencodeApiKeyToSecrets(apiKey),
  }
}

/** Decode an OpenCode Go API key from this provider's opaque secret bag. */
export function readOpencodeApiKey(secrets: AuthSecretBag): string | null {
  return str(secrets.apiKey) ?? null
}

/** Inspect stored OpenCode Go API-key metadata without exposing the secret. */
export function inspectOpencodeApiKeyCredential(secrets: AuthSecretBag): AuthCredentialInfo {
  const apiKey = readOpencodeApiKey(secrets)
  return {
    usable: Boolean(apiKey && apiKey.trim().length > 0),
  }
}

export const opencodeApiKeyAuth: ApiKeyAuthProvider = {
  ...OPENCODE_API_KEY_AUTH,
  buildCredential: buildOpencodeApiKeyCredential,
  readApiKey: readOpencodeApiKey,
  inspectCredential: inspectOpencodeApiKeyCredential,
}
