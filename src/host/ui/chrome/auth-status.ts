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
import { type CommandTableSpec, renderCommandTable } from "../command-table.ts"
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

function renderCredentialName(p: AuthStatusProviderView): string {
  const label = p.credentialName ?? p.credentialLabel ?? ""
  return label ? c.dim(label) : ""
}

function renderCredentialStatus(p: AuthStatusProviderView): string {
  const info = p.credentialInfo
  if (!p.auth || info?.usable === false) return c.boldRed("✗")
  return c.boldGreen("✔")
}

function renderCredentialLabel(p: AuthStatusProviderView): string {
  const info = p.credentialInfo
  if (!p.auth || info?.usable === false) return c.dim("credential unreadable")
  return renderCredentialName(p)
}

function renderCredentialKind(p: AuthStatusProviderView): string {
  if (!p.auth) return ""
  return c.dim(p.auth.kind === "oauth" ? "oauth" : "api-key")
}

function renderDetailLines(info: AuthCredentialInfo | undefined, now: number): string[] {
  if (!info) return []
  const lines: string[] = []
  if (info.accountId) lines.push(c.dim(`account ${info.accountId}`))
  if (info.organizationId) lines.push(c.dim(`org ${info.organizationId}`))
  if (info.scopes && info.scopes.length > 0) {
    lines.push(c.dim(`scopes ${info.scopes.join(" ")}`))
  }
  if (typeof info.expiresAt === "number") {
    const expired = info.expiresAt < now
    const expiryLabel = expired
      ? c.boldRed(`expired ${formatRelative(now - info.expiresAt)} ago`)
      : `${new Date(info.expiresAt).toISOString().replace("T", " ").slice(0, 19)} UTC ${c.dim(
          `(in ${formatRelative(info.expiresAt - now)})`,
        )}`
    lines.push(c.dim(`expires ${expiryLabel}`))
  }
  if (typeof info.hasRefreshToken === "boolean") {
    lines.push(
      c.dim(`refresh ${info.hasRefreshToken ? c.boldGreen("present") : c.boldYellow("missing")}`),
    )
  }
  for (const detail of info.details ?? []) {
    lines.push(c.dim(`${detail.label} ${detail.value}`))
  }
  return lines
}

/** Render the `minimal-agent --auth-status` rows. */
export function renderAuthStatusRows(input: AuthStatusRenderInput): string[] {
  if (input.providers.length === 0) {
    return renderCommandTable({
      columns: [{ key: "status" }],
      sections: [],
      empty: "not logged in — run `minimal-agent provider <id> login`",
    })
  }

  const grouped = groupByProvider(input.providers)
  const sections: CommandTableSpec["sections"] = []

  for (const [providerId, creds] of grouped) {
    const rows: CommandTableSpec["sections"][number]["rows"] = []

    if (creds.length === 1) {
      // Single credential: flat row with provider, kind, status on one line
      const p = creds[0]!
      const label = renderCredentialLabel(p)
      const kind = renderCredentialKind(p)
      const status = renderCredentialStatus(p)
      rows.push({ cells: { provider: c.sky(providerId), name: label, kind, status } })

      for (const detail of renderDetailLines(p.credentialInfo, input.now)) {
        rows.push({ cells: { provider: "", name: detail, kind: "", status: "" } })
      }
    } else {
      // Multiple credentials: provider as section title, each credential as sub-row
      for (const p of creds) {
        const label = renderCredentialLabel(p)
        const kind = renderCredentialKind(p)
        const status = renderCredentialStatus(p)
        rows.push({ cells: { provider: "", name: label, kind, status } })

        for (const detail of renderDetailLines(p.credentialInfo, input.now)) {
          rows.push({ cells: { provider: "", name: detail, kind: "", status: "" } })
        }
      }
    }

    sections.push({ title: creds.length > 1 ? providerId : undefined, rows })
  }

  return renderCommandTable({
    columns: [
      { key: "provider", minWidth: 14, color: "none" },
      { key: "name", color: "none" },
      { key: "kind", minWidth: 8, color: "none" },
      { key: "status", minWidth: 2, color: "none" },
    ],
    sections,
  })
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
