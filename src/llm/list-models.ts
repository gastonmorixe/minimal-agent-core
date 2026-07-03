/**
 * Provider-neutral live model listing for the REPL model picker.
 *
 * Queries every registered provider plugin's `listLiveModels` hook (the same
 * seam `minimal-agent list-models` uses) and returns the merged catalog as
 * `ModelInfo` rows. Fault-isolated: one provider's outage degrades to the
 * others' rows rather than failing the whole list. Names no provider.
 *
 * @module llm/list-models
 */

import { tryResolveProviderAuth } from "../auth/auth-strategies.ts"

import { listProviderPlugins } from "./provider-plugin.ts"
import type { ModelInfo } from "./transport/types.ts"

/**
 * List the live models the authenticated principal can access across all
 * registered provider plugins. Returns `ModelInfo` rows (`id` +
 * `display_name`) for the picker. A provider that has no credential or whose
 * fetch fails contributes no rows instead of throwing.
 *
 * @param providerId - Optional provider to restrict the listing to. When
 *   omitted, every provider plugin with a live-list hook is queried.
 */
export async function listLiveModelsForPicker(providerId?: string): Promise<ModelInfo[]> {
  const plugins = listProviderPlugins().filter(
    (p) => typeof p.listLiveModels === "function" && (!providerId || p.id === providerId),
  )
  const results = await Promise.allSettled(
    plugins.map(async (p) => {
      // Public-catalog providers (e.g. HuggingFace) list without a credential
      // via an anonymous custom auth; auth-required providers contribute no
      // rows when unauthenticated. Mirrors src/host/commands/list-models.ts.
      const auth =
        tryResolveProviderAuth(p.id, "") ??
        (p.publicModelList ? ({ kind: "custom", headers: {} } as const) : null)
      if (!auth) return []
      return (await p.listLiveModels?.(auth)) ?? []
    }),
  )
  const byId = new Map<string, ModelInfo>()
  for (const r of results) {
    if (r.status !== "fulfilled") continue
    for (const row of r.value) {
      byId.set(row.id, {
        id: row.id,
        display_name: row.displayName,
        type: "model",
        created_at: row.createdAt,
      })
    }
  }
  return [...byId.values()]
}
