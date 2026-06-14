/**
 * `minimal-agent --auth-status` command.
 *
 * Reads minimal-agent's own credential store (`~/.minimal-agent/auth.jsonc`,
 * without refreshing) and prints a compact, human-readable summary: logged
 * in/out, account uuid, scopes, subscription type, expiry, refresh token
 * presence — limited to the fields we can resolve without making network
 * calls.
 *
 * Returns exit code 0 when logged in, 1 otherwise (matches the official
 * CLI's behavior — useful for `if minimal-agent --auth-status; then …` in
 * shell scripts).
 *
 * @module commands/auth-status
 */

import { type CredentialsData, readCredentials } from "../auth.ts"
import { renderAuthStatusRows } from "../ui/chrome/auth-status.ts"
import { writeCommandRows } from "../ui/command-output.ts"

export interface AuthStatusDeps {
  /** Override the credential-store read (tests). */
  read?: (service?: string) => CredentialsData | null
  /** Where rows go (defaults to stderr). */
  output?: { write: (s: string) => void }
  /** Inject "now" for deterministic expiry rendering. */
  now?: () => number
}

/** Print the auth status rows and return `true` when logged in. */
export function renderAuthStatus(deps: AuthStatusDeps = {}): boolean {
  const out = deps.output ?? { write: (s: string) => process.stderr.write(s) }
  const now = deps.now ? deps.now() : Date.now()
  const read = deps.read ?? readCredentials
  const creds = read()

  writeCommandRows(renderAuthStatusRows({ credentials: creds, now }), out)
  return isLoggedIn(creds)
}

function isLoggedIn(creds: CredentialsData | null): boolean {
  return Boolean(creds?.apiKey || creds?.claudeAiOauth?.accessToken)
}

/**
 * Run the auth-status command. Returns 0 when logged in, 1 otherwise.
 */
export async function runAuthStatusCommand(deps: AuthStatusDeps = {}): Promise<number> {
  return renderAuthStatus(deps) ? 0 : 1
}
