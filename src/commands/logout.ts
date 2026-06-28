/**
 * `minimal-agent --logout` command.
 *
 * Removes minimal-agent credentials from its independent store
 * (`~/.minimal-agent/auth.jsonc`, see `../auth-store.ts`), the sole
 * credential source.
 *
 * Idempotent: running `--logout` twice in a row exits 0 the second time.
 *
 * @module commands/logout
 */

import { clearAllCredentials, clearProviderCredentials } from "../auth-strategies.ts"
import {
  renderLogoutResultRows,
  renderLogoutStartRows,
  renderLogoutWarningRows,
} from "../ui/chrome/logout.ts"
import { writeCommandRows } from "../ui/command-output.ts"

export interface LogoutDeps {
  /** Provider to clear; omit to clear every stored credential. */
  providerId?: string
  /**
   * Override credential removal (tests). Returns `true` if an entry was
   * actually removed, `false` if there was nothing to remove.
   */
  clearCredentials?: (providerId?: string) => boolean
  /** Where progress / footer rows go (defaults to stderr). */
  output?: { write: (s: string) => void }
}

/**
 * Run the logout flow. Returns an exit code (always 0 — logout is
 * idempotent and we never throw).
 */
export async function runLogoutCommand(deps: LogoutDeps = {}): Promise<number> {
  const out = deps.output ?? { write: (s: string) => process.stderr.write(s) }
  const clear =
    deps.clearCredentials ??
    ((providerId?: string) =>
      providerId ? clearProviderCredentials(providerId) : clearAllCredentials())

  writeCommandRows(renderLogoutStartRows(deps.providerId), out)

  let removed = false
  try {
    removed = clear(deps.providerId)
  } catch (err) {
    writeCommandRows(renderLogoutWarningRows(err instanceof Error ? err.message : String(err)), out)
  }

  writeCommandRows(renderLogoutResultRows(removed, deps.providerId), out)
  return 0
}
