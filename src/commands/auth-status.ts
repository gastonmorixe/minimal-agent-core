/**
 * `minimal-agent --auth-status` command.
 *
 * Reads the macOS Keychain credentials (without refreshing) and prints a
 * compact, human-readable summary: logged in/out, account uuid, scopes,
 * subscription type, expiry, refresh token presence. Mirrors the official
 * CLI's `claude auth status` text format roughly, but limited to the
 * fields we can resolve without making network calls.
 *
 * Returns exit code 0 when logged in, 1 otherwise (matches the official
 * CLI's behavior — useful for `if minimal-agent --auth-status; then …` in
 * shell scripts).
 *
 * @module commands/auth-status
 */

import { c } from "../agent.ts"
import { type CredentialsData, readKeychain } from "../auth.ts"

export interface AuthStatusDeps {
  /** Override keychain read (tests). */
  read?: (service?: string) => CredentialsData | null
  /** Where rows go (defaults to stderr). */
  output?: { write: (s: string) => void }
  /** Inject "now" for deterministic expiry rendering. */
  now?: () => number
}

/**
 * Render-only — no exit code logic. Public so tests can drive it without
 * spawning a subprocess. Returns `true` when logged in.
 */
export function renderAuthStatus(deps: AuthStatusDeps = {}): boolean {
  const out = deps.output ?? { write: (s: string) => process.stderr.write(s) }
  const now = deps.now ? deps.now() : Date.now()
  const read = deps.read ?? readKeychain
  const creds = read()

  out.write(`  ${c.bold(c.pink("ⓘ"))} ${c.bold("Auth status")}\n`)

  if (!creds) {
    out.write(`  ${c.faintWhite("╰")} ${c.dim("not logged in")} ${c.boldYellow("✗")}\n`)
    out.write(
      `\n  ${c.dim(
        "run `minimal-agent --login` to sign in, or `claude` if you prefer the official CLI.",
      )}\n`,
    )
    return false
  }

  if (creds.apiKey) {
    out.write(`  ${c.faintWhite("│")} ${c.sky("type")}     api-key\n`)
    out.write(`  ${c.faintWhite("╰")} ${c.boldGreen("✔")} ${c.dim("logged in via API key")}\n`)
    return true
  }

  const oauth = creds.claudeAiOauth
  if (!oauth?.accessToken) {
    out.write(
      `  ${c.faintWhite("╰")} ${c.dim("keychain entry exists but has no access token")} ${c.boldRed("✗")}\n`,
    )
    return false
  }

  const accountUuid = creds.oauthAccount?.accountUuid
  const orgUuid = creds.oauthAccount?.organizationUuid
  const sub = oauth.subscriptionType
  const tier = oauth.rateLimitTier
  const scopes = oauth.scopes ?? []
  const expiresAt = oauth.expiresAt
  const expired = typeof expiresAt === "number" ? expiresAt < now : false
  const expiresInMs = typeof expiresAt === "number" ? expiresAt - now : null
  const expiryLabel =
    expiresAt == null
      ? c.dim("(no expiry recorded)")
      : expired
        ? c.boldRed(`expired ${formatRelative(now - expiresAt!)} ago`)
        : `${new Date(expiresAt).toISOString().replace("T", " ").slice(0, 19)} UTC ${c.dim(
            `(in ${formatRelative(expiresInMs!)})`,
          )}`

  out.write(`  ${c.faintWhite("│")} ${c.sky("type")}     oauth\n`)
  if (accountUuid) {
    out.write(`  ${c.faintWhite("│")} ${c.sky("account")}  ${c.dim(accountUuid)}\n`)
  }
  if (orgUuid) {
    out.write(`  ${c.faintWhite("│")} ${c.sky("org")}      ${c.dim(orgUuid)}\n`)
  }
  if (sub) {
    out.write(
      `  ${c.faintWhite("│")} ${c.sky("plan")}     ${c.bold(sub)}${tier ? ` ${c.dim(`(${tier})`)}` : ""}\n`,
    )
  }
  if (scopes.length > 0) {
    out.write(`  ${c.faintWhite("│")} ${c.sky("scopes")}   ${c.dim(scopes.join(" "))}\n`)
  }
  out.write(`  ${c.faintWhite("│")} ${c.sky("expires")}  ${expiryLabel}\n`)
  out.write(
    `  ${c.faintWhite("│")} ${c.sky("refresh")}  ${
      oauth.refreshToken ? c.boldGreen("present") : c.boldYellow("missing")
    }\n`,
  )

  if (expired) {
    out.write(
      `  ${c.faintWhite("╰")} ${c.boldYellow("⚠")} ${c.bold("token expired")} — minimal-agent will auto-refresh on next request, or run \`--login\` to re-issue.\n`,
    )
  } else {
    out.write(`  ${c.faintWhite("╰")} ${c.boldGreen("✔")} ${c.bold("logged in")}\n`)
  }
  return true
}

/**
 * Format a duration in ms as a short human-readable string.
 * 60s · 5m 20s · 3h 12m · 4d 6h.
 */
function formatRelative(ms: number): string {
  const abs = Math.abs(ms)
  const sec = Math.round(abs / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  if (hr < 24) return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`
  const day = Math.floor(hr / 24)
  const remHr = hr % 24
  return remHr > 0 ? `${day}d ${remHr}h` : `${day}d`
}

/**
 * Run the auth-status command. Returns 0 when logged in, 1 otherwise.
 */
export async function runAuthStatusCommand(deps: AuthStatusDeps = {}): Promise<number> {
  return renderAuthStatus(deps) ? 0 : 1
}
