/**
 * Pure model-catalog data for inspection commands.
 *
 * Host commands collect rows here, then hand them to a print-format
 * renderer (text table / json / …). Keeps registry reads free of ANSI
 * and `process.stdout` so SDK / TUI / tests can share one path.
 *
 * @module host/commands/model-catalog-data
 */

import type { Capabilities } from "../../llm/capabilities.ts"
import { listRegisteredModels } from "../../llm/model-registry.ts"

/** One model row in the offline / live catalog listing. */
export interface ModelCatalogRow {
  id: string
  displayName?: string
  providerId: string
  surface?: string
  date?: string
  contextWindow?: number
  maxOutputTokens?: number
  capabilities?: Capabilities
}

/** Composite key so shared bare slugs stay per-provider. */
export function modelCatalogRowKey(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`
}

/**
 * Static registered catalog as structured rows (no network).
 * Optional `providerFilter` limits to one provider id.
 */
export function collectRegisteredModelRows(providerFilter?: string): ModelCatalogRow[] {
  const byKey = new Map<string, ModelCatalogRow>()
  for (const entry of listRegisteredModels()) {
    if (providerFilter && entry.providerId !== providerFilter) continue
    const key = modelCatalogRowKey(entry.providerId, entry.id)
    byKey.set(key, {
      id: entry.id,
      displayName: entry.displayName,
      providerId: entry.providerId,
      surface: entry.surfaceId,
      date: entry.knowledgeCutoff,
      contextWindow: entry.capabilities.contextWindow,
      maxOutputTokens: entry.capabilities.maxOutputTokens,
      capabilities: entry.capabilities,
    })
  }
  return [...byKey.values()].sort(
    (a, b) => a.providerId.localeCompare(b.providerId) || a.id.localeCompare(b.id),
  )
}

/** Group rows by provider id (sorted provider keys when iterating entries). */
export function groupModelRowsByProvider(
  rows: readonly ModelCatalogRow[],
): Map<string, ModelCatalogRow[]> {
  const byProvider = new Map<string, ModelCatalogRow[]>()
  for (const row of rows) {
    const list = byProvider.get(row.providerId)
    if (list) list.push(row)
    else byProvider.set(row.providerId, [row])
  }
  return byProvider
}
