/**
 * Host-owned auth-status command chrome.
 *
 * The command layer reads credentials and returns exit codes; this module owns
 * the terminal rows shown to the user.
 *
 * @module ui/chrome/auth-status
 */

import type { ProviderAuth } from "../../llm/provider.ts"
import type { AuthCredentialInfo } from "../../llm/provider-plugin.ts"
import { c } from "../style/ansi.ts"

export interface AuthStatusProviderView {
  readonly providerId: string
  readonly displayName: string
  readonly authKind: "oauth" | "api-key"
  readonly source: "store"
  readonly credentialLabel?: string
  readonly credentialInfo?: AuthCredentialInfo
  readonly auth: ProviderAuth | null
}

export interface AuthStatusRenderInput {
  readonly providers: readonly AuthStatusProviderView[]
  readonly now: number
}

/** Render the `minimal-agent --auth-status` rows. */
export function renderAuthStatusRows(input: AuthStatusRenderInput): string[] {
  const rows = [`  ${c.bold(c.pink("ⓘ"))} ${c.bold("Auth status")}`]

  if (input.providers.length === 0) {
    rows.push(`  ${c.faintWhite("╰")} ${c.dim("not logged in")} ${c.boldYellow("✗")}`)
    rows.push(
      ``,
      `  ${c.dim("run `minimal-agent provider <id> login` (e.g. `minimal-agent provider example-provider login`).")}`,
    )
    return rows
  }

  for (let i = 0; i < input.providers.length; i++) {
    const p = input.providers[i]!
    const isLast = i === input.providers.length - 1
    const branch = isLast ? "╰" : "│"
    const prefix = `  ${c.faintWhite(branch)}`
    const info = p.credentialInfo

    if (!p.auth || info?.usable === false) {
      rows.push(
        `${prefix} ${c.sky(p.providerId)} ${c.dim("— credential unreadable")} ${c.boldRed("✗")}`,
      )
      rows.push(...renderCredentialDetails(prefix, info, input.now))
      continue
    }

    if (p.auth.kind === "api-key") {
      const via = p.credentialLabel ?? "api-key"
      rows.push(`${prefix} ${c.sky(p.providerId)} ${c.dim(`— ${via}`)} ${c.boldGreen("✔")}`)
      rows.push(...renderCredentialDetails(prefix, info, input.now))
      continue
    }

    const via = p.credentialLabel ?? "oauth"
    rows.push(`${prefix} ${c.sky(p.providerId)} ${c.dim(`— ${via}`)} ${c.boldGreen("✔")} oauth`)
    rows.push(...renderCredentialDetails(prefix, info, input.now))
  }

  return rows
}

function renderCredentialDetails(
  prefix: string,
  info: AuthCredentialInfo | undefined,
  now: number,
): string[] {
  if (!info) return []
  const rows: string[] = []
  if (info.accountId) rows.push(`${prefix} ${c.sky("account")}  ${c.dim(info.accountId)}`)
  if (info.organizationId) rows.push(`${prefix} ${c.sky("org")}      ${c.dim(info.organizationId)}`)
  if (info.scopes && info.scopes.length > 0) {
    rows.push(`${prefix} ${c.sky("scopes")}   ${c.dim(info.scopes.join(" "))}`)
  }
  if (typeof info.expiresAt === "number") {
    const expired = info.expiresAt < now
    const expiryLabel = expired
      ? c.boldRed(`expired ${formatRelative(now - info.expiresAt)} ago`)
      : `${new Date(info.expiresAt).toISOString().replace("T", " ").slice(0, 19)} UTC ${c.dim(
          `(in ${formatRelative(info.expiresAt - now)})`,
        )}`
    rows.push(`${prefix} ${c.sky("expires")}  ${expiryLabel}`)
  }
  if (typeof info.hasRefreshToken === "boolean") {
    rows.push(
      `${prefix} ${c.sky("refresh")}  ${
        info.hasRefreshToken ? c.boldGreen("present") : c.boldYellow("missing")
      }`,
    )
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
