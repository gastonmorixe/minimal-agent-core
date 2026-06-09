/**
 * `--list-models`: merged live + registered model catalog, grouped by
 * provider.
 *
 * Provider-NEUTRAL by construction (OCP): live rows come from each
 * registered `ProviderPlugin.listLiveModels` hook; static rows come from
 * the canonical model registry. Adding a provider plugin extends this
 * listing with zero edits here. Live rows win on id collision (they carry
 * real `created_at` dates); a failed/missing live fetch degrades to the
 * registry so the command never hides the catalog on network trouble.
 *
 * @module commands/list-models
 */

import { c } from "../agent.ts"
import type { AuthResult } from "../auth.ts"
import { listRegisteredModels } from "../llm/model-registry.ts"
import type { ProviderAuth } from "../llm/provider.ts"
import { listProviderPlugins } from "../llm/provider-plugin.ts"

interface ModelRow {
  id: string
  displayName?: string
  providerId: string
  surface?: string
  date?: string
}

/** Project the CLI's resolved auth into the neutral provider-auth shape. */
function toProviderAuth(auth: AuthResult): ProviderAuth {
  return auth.type === "oauth"
    ? { kind: "oauth", token: auth.token }
    : { kind: "api-key", key: auth.token }
}

export async function runListModelsCommand(
  auth: AuthResult,
  providerFilter?: string,
): Promise<void> {
  const byId = new Map<string, ModelRow>()

  // Live catalogs, one hook call per provider plugin that implements it.
  // Parallel, individually fault-isolated: one provider's outage must not
  // hide another's rows (nor the registry fallback below).
  const providerAuth = toProviderAuth(auth)
  const plugins = listProviderPlugins().filter((p) => typeof p.listLiveModels === "function")
  const results = await Promise.allSettled(
    plugins.map(async (p) => ({ plugin: p, rows: await p.listLiveModels?.(providerAuth) })),
  )
  for (const r of results) {
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
      console.error(`  ${c.dim(`(live model list unavailable: ${msg})`)}`)
      continue
    }
    for (const m of r.value.rows ?? []) {
      byId.set(m.id, {
        id: m.id,
        displayName: m.displayName,
        providerId: r.value.plugin.id,
        surface: undefined,
        date: m.createdAt,
      })
    }
  }

  // Canonical registry: every registered provider's static catalog.
  // Live entries win on id collision.
  for (const entry of listRegisteredModels()) {
    if (byId.has(entry.id)) {
      // Backfill the surface (live rows don't know it).
      const row = byId.get(entry.id)!
      if (!row.surface) row.surface = entry.surfaceId
      continue
    }
    byId.set(entry.id, {
      id: entry.id,
      displayName: entry.displayName,
      providerId: entry.providerId,
      surface: entry.surfaceId,
      date: entry.knowledgeCutoff,
    })
  }

  // Group by provider.
  const byProvider = new Map<string, ModelRow[]>()
  for (const row of byId.values()) {
    const list = byProvider.get(row.providerId)
    if (list) list.push(row)
    else byProvider.set(row.providerId, [row])
  }

  const providerIds = providerFilter ? [providerFilter] : [...byProvider.keys()].sort()

  // Column widths sized to the rows actually shown, so long ids, display
  // names, and surfaces stay aligned instead of overflowing a hard pad.
  const shownRows = providerIds.flatMap((p) => byProvider.get(p) ?? [])
  const idW = Math.max(20, ...shownRows.map((r) => r.id.length))
  const nameW = Math.max(12, ...shownRows.map((r) => (r.displayName ?? "").length))
  const surfaceW = Math.max(10, ...shownRows.map((r) => (r.surface ?? "").length))

  let shown = 0
  console.log("")
  for (const provider of providerIds) {
    const rows = byProvider.get(provider)
    if (!rows || rows.length === 0) {
      if (providerFilter)
        console.log(`  ${c.dim(`no models registered for provider "${provider}"`)}`)
      continue
    }
    console.log(`  ${c.bold(provider)}`)
    for (const row of rows.sort((a, b) => a.id.localeCompare(b.id))) {
      const id = c.cyan(row.id.padEnd(idW))
      const name = c.dim((row.displayName ?? "").padEnd(nameW))
      const surface = c.dim((row.surface ?? "").padEnd(surfaceW))
      const date = row.date ? c.dim(row.date) : ""
      console.log(`    ${id} ${name} ${surface} ${date}`)
      shown++
    }
    console.log("")
  }
  console.log(`  ${c.dim(`${shown} models available`)}`)
}
