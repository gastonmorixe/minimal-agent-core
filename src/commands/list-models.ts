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

import { tryResolveProviderAuth } from "../auth-strategies.ts"
import { listRegisteredModels } from "../llm/model-registry.ts"
import type { ProviderAuth } from "../llm/provider.ts"
import { listProviderPlugins } from "../llm/provider-plugin.ts"
import { writeCommandTable } from "../ui/command-table.ts"
import { c } from "../ui/style/ansi.ts"

interface ModelRow {
  id: string
  displayName?: string
  providerId: string
  surface?: string
  date?: string
}

/**
 * Implements `minimal-agent list-models`: merges live model catalogs from
 * every provider plugin (queried in parallel, fault-isolated so one outage
 * cannot hide another provider's rows) with the static registry fallback,
 * then prints a deduplicated table, optionally filtered to one provider.
 */
export async function runListModelsCommand(
  providerFilter?: string,
  deps: {
    output?: { write(s: string): unknown }
    error?: { write(s: string): unknown }
  } = {},
): Promise<void> {
  const byId = new Map<string, ModelRow>()

  // Live catalogs, one hook call per provider plugin that implements it.
  // Parallel, individually fault-isolated: one provider's outage must not
  // hide another's rows (nor the registry fallback below).
  const plugins = listProviderPlugins().filter((p) => typeof p.listLiveModels === "function")
  const results = await Promise.allSettled(
    plugins.map(async (p) => {
      const providerAuth: ProviderAuth | null = tryResolveProviderAuth(p.id, "")
      if (!providerAuth)
        return { plugin: p, rows: [] as Awaited<ReturnType<NonNullable<typeof p.listLiveModels>>> }
      return { plugin: p, rows: await p.listLiveModels?.(providerAuth) }
    }),
  )
  for (const r of results) {
    if (r.status === "rejected") {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason)
      ;(deps.error ?? process.stderr).write(`  ${c.dim(`(live model list unavailable: ${msg})`)}\n`)
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

  const sections = providerIds.flatMap((provider) => {
    const rows = byProvider.get(provider)
    if (!rows || rows.length === 0) return []
    return [
      {
        title: provider,
        rows: rows
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((row) => ({
            cells: {
              id: row.id,
              name: row.displayName ?? "",
              surface: row.surface ?? "",
              date: row.date ?? "",
            },
          })),
      },
    ]
  })
  const shown = sections.reduce((n, section) => n + section.rows.length, 0)

  writeCommandTable(
    {
      columns: [
        { key: "id", minWidth: idW, color: "cyan" },
        { key: "name", minWidth: nameW, color: "dim" },
        { key: "surface", minWidth: surfaceW, color: "dim" },
        { key: "date", color: "dim" },
      ],
      sections,
      empty: providerFilter ? `no models registered for provider "${providerFilter}"` : undefined,
      summary: `${shown} models available`,
    },
    deps.output,
  )
}
