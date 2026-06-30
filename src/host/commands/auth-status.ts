/**
 * `minimal-agent --auth-status` command.
 *
 * Reads minimal-agent's credential store (`~/.minimal-agent/auth.jsonc`,
 * without refreshing) and prints a compact, human-readable summary per
 * provider with resolvable credentials.
 *
 * Returns exit code 0 when at least one provider is logged in, 1 otherwise.
 *
 * @module commands/auth-status
 */

import {
  type CredentialedProvider,
  discoverCredentialedProviders,
  tryResolveProviderAuth,
} from "../../auth-strategies.ts"
import type { ProviderAuth } from "../../llm/provider.ts"
import { renderAuthStatusRows } from "../ui/chrome/auth-status.ts"
import { writeCommandRows } from "../ui/command-output.ts"

export interface AuthStatusDeps {
  /** Override credential discovery (tests). */
  discover?: () => CredentialedProvider[]
  /** Override per-provider auth resolution (tests). */
  resolveAuth?: (providerId: string) => ProviderAuth | null
  /** Where rows go (defaults to stderr). */
  output?: { write: (s: string) => void }
  /** Inject "now" for deterministic expiry rendering. */
  now?: () => number
}

/** Print the auth status rows and return `true` when any provider is logged in. */
export function renderAuthStatus(deps: AuthStatusDeps = {}): boolean {
  const out = deps.output ?? { write: (s: string) => process.stderr.write(s) }
  const now = deps.now ? deps.now() : Date.now()
  const discover = deps.discover ?? discoverCredentialedProviders
  const resolveAuth =
    deps.resolveAuth ?? ((providerId: string) => tryResolveProviderAuth(providerId))

  const providers = discover()
  writeCommandRows(
    renderAuthStatusRows({
      providers: providers.map((p) => ({
        providerId: p.providerId,
        displayName: p.displayName,
        authKind: p.authKind,
        source: p.source,
        credentialLabel: p.credentialLabel,
        credentialInfo: p.credentialInfo,
        auth: resolveAuth(p.providerId),
      })),
      now,
    }),
    out,
  )
  return providers.length > 0
}

/**
 * Run the auth-status command. Returns 0 when logged in, 1 otherwise.
 */
export async function runAuthStatusCommand(deps: AuthStatusDeps = {}): Promise<number> {
  return renderAuthStatus(deps) ? 0 : 1
}
