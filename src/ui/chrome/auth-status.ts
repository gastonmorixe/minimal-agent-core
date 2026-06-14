/**
 * Host-owned auth-status command chrome.
 *
 * The command layer reads credentials and returns exit codes; this module owns
 * the terminal rows shown to the user.
 *
 * @module ui/chrome/auth-status
 */

import { c } from "../style/ansi.ts"

export interface AuthStatusCredentialsView {
  readonly apiKey?: string
  readonly claudeAiOauth?: {
    readonly accessToken?: string
    readonly refreshToken?: string
    readonly expiresAt?: number
    readonly scopes?: readonly string[]
    readonly subscriptionType?: string
    readonly rateLimitTier?: string
  }
  readonly oauthAccount?: {
    readonly accountUuid?: string
    readonly organizationUuid?: string
  }
}

export interface AuthStatusRenderInput {
  readonly credentials: AuthStatusCredentialsView | null
  readonly now: number
}

/** Render the `minimal-agent --auth-status` rows. */
export function renderAuthStatusRows(input: AuthStatusRenderInput): string[] {
  const creds = input.credentials
  const rows = [`  ${c.bold(c.pink("ⓘ"))} ${c.bold("Auth status")}`]

  if (!creds) {
    rows.push(`  ${c.faintWhite("╰")} ${c.dim("not logged in")} ${c.boldYellow("✗")}`)
    rows.push(``, `  ${c.dim("run `minimal-agent --login` to sign in.")}`)
    return rows
  }

  if (creds.apiKey) {
    rows.push(`  ${c.faintWhite("│")} ${c.sky("type")}     api-key`)
    rows.push(`  ${c.faintWhite("╰")} ${c.boldGreen("✔")} ${c.dim("logged in via API key")}`)
    return rows
  }

  const oauth = creds.claudeAiOauth
  if (!oauth?.accessToken) {
    rows.push(
      `  ${c.faintWhite("╰")} ${c.dim("credential entry exists but has no access token")} ${c.boldRed("✗")}`,
    )
    return rows
  }

  const accountUuid = creds.oauthAccount?.accountUuid
  const orgUuid = creds.oauthAccount?.organizationUuid
  const sub = oauth.subscriptionType
  const tier = oauth.rateLimitTier
  const scopes = oauth.scopes ?? []
  const expiresAt = oauth.expiresAt
  const expired = typeof expiresAt === "number" ? expiresAt < input.now : false
  const expiresInMs = typeof expiresAt === "number" ? expiresAt - input.now : null
  const expiryLabel =
    expiresAt == null
      ? c.dim("(no expiry recorded)")
      : expired
        ? c.boldRed(`expired ${formatRelative(input.now - expiresAt)} ago`)
        : `${new Date(expiresAt).toISOString().replace("T", " ").slice(0, 19)} UTC ${c.dim(
            `(in ${formatRelative(expiresInMs!)})`,
          )}`

  rows.push(`  ${c.faintWhite("│")} ${c.sky("type")}     oauth`)
  if (accountUuid) {
    rows.push(`  ${c.faintWhite("│")} ${c.sky("account")}  ${c.dim(accountUuid)}`)
  }
  if (orgUuid) {
    rows.push(`  ${c.faintWhite("│")} ${c.sky("org")}      ${c.dim(orgUuid)}`)
  }
  if (sub) {
    rows.push(
      `  ${c.faintWhite("│")} ${c.sky("plan")}     ${c.bold(sub)}${tier ? ` ${c.dim(`(${tier})`)}` : ""}`,
    )
  }
  if (scopes.length > 0) {
    rows.push(`  ${c.faintWhite("│")} ${c.sky("scopes")}   ${c.dim(scopes.join(" "))}`)
  }
  rows.push(`  ${c.faintWhite("│")} ${c.sky("expires")}  ${expiryLabel}`)
  rows.push(
    `  ${c.faintWhite("│")} ${c.sky("refresh")}  ${
      oauth.refreshToken ? c.boldGreen("present") : c.boldYellow("missing")
    }`,
  )

  if (expired) {
    rows.push(
      `  ${c.faintWhite("╰")} ${c.boldYellow("⚠")} ${c.bold("token expired")} — minimal-agent will auto-refresh on next request, or run \`--login\` to re-issue.`,
    )
  } else {
    rows.push(`  ${c.faintWhite("╰")} ${c.boldGreen("✔")} ${c.bold("logged in")}`)
  }
  return rows
}

/**
 * Format a duration in ms as a short human-readable string.
 * 60s · 5m 20s · 3h 12m · 4d 6h.
 */
export function formatRelative(ms: number): string {
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
