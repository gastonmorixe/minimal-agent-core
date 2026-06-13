/**
 * Startup auth selection for the selected model's provider.
 *
 * Keeps `src/index.ts` as the composition root while moving provider-auth
 * bridging out of the entrypoint. The legacy agent still accepts `AuthResult`;
 * this module maps stored provider credentials into that shape without making
 * startup prompt Anthropic credentials for non-Anthropic models.
 *
 * @module startup/provider-auth
 */

import type { AuthResult } from "../auth.ts"
import { resolveStoredProviderAuth } from "../auth-strategies.ts"
import { c } from "../ui/style/ansi.ts"

import { getAuthWithFirstTimePrompt } from "./auth-prompt.ts"

/**
 * Resolve startup credentials for the selected provider.
 *
 * Anthropic keeps the legacy first-run prompt for now; every other provider
 * is resolved from minimal-agent's host-owned provider auth store.
 */
export async function resolveStartupAuth(
  providerId: string | undefined,
  modelId: string,
): Promise<AuthResult> {
  if (providerId === undefined || providerId === "anthropic") {
    return getAuthWithFirstTimePrompt()
  }
  const auth = resolveStoredProviderAuth(providerId, modelId)
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
      throw new Error(`provider "${providerId}" uses custom auth that startup cannot bridge yet`)
    default: {
      const _exhaustive: never = auth
      throw new Error(`unhandled provider auth kind: ${_exhaustive}`)
    }
  }
}

function refreshBridge(refresh: () => Promise<{ token: string }>): () => Promise<AuthResult> {
  return async () => {
    const refreshed = await refresh()
    return { type: "oauth", token: refreshed.token }
  }
}

/** Render the auth row shown in the startup tree. */
export function startupAuthLabel(auth: AuthResult, providerId: string | undefined): string {
  if (providerId && providerId !== "anthropic") {
    return `${auth.type} ${c.dim(`(${providerId})`)}`
  }
  return `${auth.type}${auth.accountUuid ? ` ${c.dim(`(account: ${auth.accountUuid.slice(0, 8)}...)`)}` : ""}`
}
