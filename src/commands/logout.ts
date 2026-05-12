/**
 * `minimal-agent --logout` command.
 *
 * Mirrors the official CLI's `performLogout({ clearOnboarding: false })`
 * (see `cc-03312026-2.1.88/src/commands/logout/logout.js`) trimmed to two
 * effects:
 *
 *   1. Delete the credential store entry. On macOS this removes the
 *      Keychain item `Claude Code-credentials`; on Linux/others it
 *      removes `~/.claude/.credentials.json`.
 *   2. Strip the `oauthAccount` block from `~/.claude.json` (preserve other
 *      fields — onboarding, settings, project state belongs to the official
 *      CLI and we don't touch it).
 *
 * Both steps are idempotent: running `--logout` twice in a row exits 0 the
 * second time.
 *
 * @module commands/logout
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { c } from "../agent.ts"
import { deleteCredentials } from "../auth.ts"

export interface LogoutDeps {
  /** Override credential delete (tests). Returns `true` if an entry was deleted. */
  deleteCredentials?: () => boolean
  /** Override fs read (tests). */
  readFile?: (path: string) => string | null
  /** Override fs write (tests). */
  writeFile?: (path: string, contents: string) => void
  /** Override $HOME (tests). */
  home?: string
  /** Where progress / footer rows go (defaults to stderr). */
  output?: { write: (s: string) => void }
}

/**
 * Strip `oauthAccount` from `~/.claude.json` if it exists. Preserves all
 * other top-level keys. Best-effort: missing file or parse failure is
 * treated as "nothing to strip" and returns silently. Returns `true` if a
 * write actually occurred.
 */
export function stripClaudeJsonOauthAccount(
  deps: Pick<LogoutDeps, "readFile" | "writeFile" | "home"> = {},
): boolean {
  const home = deps.home ?? process.env.HOME ?? ""
  if (!home) return false
  const path = join(home, ".claude.json")

  let raw: string | null = null
  if (deps.readFile) {
    raw = deps.readFile(path)
  } else {
    try {
      raw = readFileSync(path, "utf-8")
    } catch {
      raw = null
    }
  }
  if (!raw) return false

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return false
  }
  if (!("oauthAccount" in parsed)) return false

  // Use destructuring with `_` to extract+drop the field; a clean
  // `delete parsed.oauthAccount` works too but biome dislikes the
  // `delete` operator in strict mode.
  const { oauthAccount: _drop, ...rest } = parsed
  void _drop
  const json = JSON.stringify(rest, null, 2)

  if (deps.writeFile) {
    deps.writeFile(path, json)
  } else {
    try {
      writeFileSync(path, json, { mode: 0o600 })
    } catch {
      return false
    }
  }
  return true
}

/**
 * Run the logout flow. Returns an exit code (always 0 — logout is
 * idempotent and we never throw).
 */
export async function runLogoutCommand(deps: LogoutDeps = {}): Promise<number> {
  const out = deps.output ?? { write: (s: string) => process.stderr.write(s) }
  const del = deps.deleteCredentials ?? deleteCredentials

  out.write(`  ${c.bold(c.pink("⊖"))} ${c.bold("Sign out")}\n`)

  let removed = false
  try {
    removed = del()
  } catch (err) {
    out.write(
      `  ${c.boldYellow("warn")} credential delete failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    )
  }
  out.write(
    `  ${c.faintWhite("│")} credentials  ${removed ? c.boldGreen("removed") : c.dim("(no entry)")}\n`,
  )

  let strippedJson = false
  try {
    strippedJson = stripClaudeJsonOauthAccount(deps)
  } catch (err) {
    out.write(
      `  ${c.boldYellow("warn")} ~/.claude.json strip failed: ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    )
  }
  out.write(
    `  ${c.faintWhite("╰")} config    ${
      strippedJson ? c.boldGreen("stripped oauthAccount") : c.dim("(nothing to strip)")
    }\n`,
  )

  out.write(`\n  ${c.boldGreen("✔")} ${c.bold("Logged out")}\n`)
  return 0
}
