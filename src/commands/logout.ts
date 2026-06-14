/**
 * `minimal-agent --logout` command.
 *
 * Removes minimal-agent's own credentials from its independent store
 * (`~/.minimal-agent/auth.jsonc`, see `../auth-store.ts`). It does NOT
 * touch the macOS Keychain or `~/.claude.json` — those belong to the official
 * `claude` CLI and minimal-agent no longer shares them, so logging out here
 * leaves any official-CLI login completely intact.
 *
 * Idempotent: running `--logout` twice in a row exits 0 the second time
 * (the second run simply finds nothing to remove).
 *
 * @module commands/logout
 */

import { clearCredentials } from "../auth.ts"
import {
  renderLogoutResultRows,
  renderLogoutStartRows,
  renderLogoutWarningRows,
} from "../ui/chrome/logout.ts"
import { writeCommandRows } from "../ui/command-output.ts"

export interface LogoutDeps {
  /**
   * Override credential removal (tests). Returns `true` if an entry was
   * actually removed, `false` if there was nothing to remove. Defaults to
   * {@link clearCredentials}.
   */
  clearCredentials?: () => boolean
  /** Where progress / footer rows go (defaults to stderr). */
  output?: { write: (s: string) => void }
}

/**
 * Run the logout flow. Returns an exit code (always 0 — logout is
 * idempotent and we never throw).
 */
export async function runLogoutCommand(deps: LogoutDeps = {}): Promise<number> {
  const out = deps.output ?? { write: (s: string) => process.stderr.write(s) }
  const clear = deps.clearCredentials ?? clearCredentials

  writeCommandRows(renderLogoutStartRows(), out)

  let removed = false
  try {
    removed = clear()
  } catch (err) {
    writeCommandRows(renderLogoutWarningRows(err instanceof Error ? err.message : String(err)), out)
  }

  writeCommandRows(renderLogoutResultRows(removed), out)
  return 0
}
