/**
 * Host-owned auth-status command chrome.
 *
 * The command layer reads credentials and returns exit codes; this module owns
 * the terminal rows shown to the user.
 *
 * @module ui/chrome/auth-status
 */

import type { ProviderAuth } from "../../../llm/provider.ts"
import type { AuthCredentialInfo } from "../../../llm/provider-plugin.ts"
import { renderCommandTable } from "../command-table.ts"
import { c } from "../style/ansi.ts"

export interface AuthStatusProviderView {
  readonly providerId: string
  readonly displayName: string
  readonly authKind: "oauth" | "api-key"
  readonly source: "store"
  readonly credentialLabel?: string
  readonly credentialName?: string
  readonly credentialInfo?: AuthCredentialInfo
  readonly auth: ProviderAuth | null
}

export interface AuthStatusRenderInput {
  readonly providers: readonly AuthStatusProviderView[]
  readonly now: number
}

/**
 * Group providers by providerId so multi-credential providers render as a
 * tree under one heading.
 */
function groupByProvider(
  providers: readonly AuthStatusProviderView[],
): Map<string, AuthStatusProviderView[]> {
  const map = new Map<string, AuthStatusProviderView[]>()
  for (const p of providers) {
    const list = map.get(p.providerId)
    if (list) list.push(p)
    else map.set(p.providerId, [p])
  }
  return map
}

function safeText(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: remove terminal controls from external metadata
  return value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ").trim()
}

function renderCredentialName(p: AuthStatusProviderView, index: number): string {
  return (
    safeText(p.credentialName ?? "") ||
    safeText(p.credentialLabel ?? "") ||
    `Credential ${index + 1}`
  )
}

function renderCredentialStatus(p: AuthStatusProviderView): string {
  const info = p.credentialInfo
  if (!p.auth || info?.usable === false) return c.boldRed("✗")
  return c.boldGreen("✔")
}

function renderDetailLines(info: AuthCredentialInfo | undefined, now: number): string[] {
  if (!info) return []
  const lines: string[] = []
  if (info.accountId) lines.push(c.dim(`account: ${safeText(info.accountId)}`))
  if (info.organizationId) lines.push(c.dim(`org: ${safeText(info.organizationId)}`))
  if (info.scopes && info.scopes.length > 0) {
    lines.push(c.dim(`scopes: ${safeText(info.scopes.join(" "))}`))
  }
  if (typeof info.expiresAt === "number" && Number.isFinite(new Date(info.expiresAt).getTime())) {
    const expired = info.expiresAt <= now
    const expiryLabel = expired
      ? c.boldRed(`expired ${formatRelative(now - info.expiresAt)} ago`)
      : `${new Date(info.expiresAt).toISOString().replace("T", " ").slice(0, 19)} UTC ${c.dim(
          `(in ${formatRelative(info.expiresAt - now)})`,
        )}`
    lines.push(c.dim(`expires: ${expiryLabel}`))
  }
  if (typeof info.hasRefreshToken === "boolean") {
    lines.push(
      c.dim(`refresh: ${info.hasRefreshToken ? c.boldGreen("present") : c.boldYellow("missing")}`),
    )
  }
  for (const detail of info.details ?? []) {
    lines.push(c.dim(`${safeText(detail.label)}: ${safeText(detail.value)}`))
  }
  return lines
}

/** Render the `minimal-agent --auth-status` rows. */
export function renderAuthStatusRows(input: AuthStatusRenderInput): string[] {
  if (input.providers.length === 0) {
    return renderCommandTable({
      columns: [{ key: "status" }],
      sections: [],
      empty: "not logged in. Run `minimal-agent provider <id> login`",
    })
  }

  const rows: string[] = [""]
  for (const [providerId, creds] of groupByProvider(input.providers)) {
    if (rows.length > 1) rows.push("")
    rows.push(`  ${c.bold(safeText(creds[0]!.displayName))} ${c.sky(`(${safeText(providerId)})`)}`)
    for (const [index, p] of creds.entries()) {
      if (index > 0) rows.push("")
      const status = renderCredentialStatus(p)
      const kind = c.dim(p.auth?.kind ?? p.authKind)
      const diagnostic =
        !p.auth || p.credentialInfo?.usable === false ? ` ${c.dim("credential unreadable")}` : ""
      rows.push(`    ${c.bold(renderCredentialName(p, index))} ${status} ${kind}${diagnostic}`)
      for (const detail of renderDetailLines(p.credentialInfo, input.now)) {
        rows.push(`      ${detail}`)
      }
    }
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
