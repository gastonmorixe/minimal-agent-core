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

import { c } from "../agent.ts"
import { clearCredentials } from "../auth.ts"

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

  out.write(`  ${c.bold(c.pink("⊖"))} ${c.bold("Sign out")}\n`)

  let removed = false
  try {
    removed = clear()
  } catch (err) {
    out.write(
      `  ${c.boldYellow("warn")} credential removal failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    )
  }
  out.write(
    `  ${c.faintWhite("╰")} credentials  ${
      removed ? c.boldGreen("removed") : c.dim("(no entry)")
    }\n`,
  )

  out.write(`\n  ${c.boldGreen("✔")} ${c.bold("Logged out")}\n`)
  return 0
}
