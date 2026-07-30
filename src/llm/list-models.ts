/**
 * Provider-neutral live model listing for the REPL model picker (and the
 * forthcoming `models-live` command).
 *
 * Queries every registered provider plugin's `listLiveModels` hook and
 * returns the catalog as `ModelInfo` rows. The static CLI listing
 * (`ma models` / `--list-models`) never calls this — it reads only the
 * in-process registry. Fault-isolated: one provider's outage degrades to
 * the others' rows rather than failing the whole list. Names no provider.
 *
 * When the same bare model id is returned by multiple providers (e.g.
 * `kimi-k2.6` from Ollama and OpenCode), both rows are kept — dedup is
 * per-provider, not global on bare id.
 *
 * @module llm/list-models
 */

import { tryResolveProviderAuth } from "../auth/auth-strategies.ts"

import { listProviderPlugins } from "./provider-plugin.ts"
import type { ModelInfo } from "./transport/types.ts"

/** Composite key so two providers advertising the same bare slug stay distinct. */
function liveRowKey(providerId: string, modelId: string): string {
  return `${providerId}\0${modelId}`
}

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
      if (!auth)
        return [] as Array<{
          providerId: string
          row: { id: string; displayName?: string; createdAt?: string }
        }>
      const rows = (await p.listLiveModels?.(auth)) ?? []
      return rows.map((row) => ({ providerId: p.id, row }))
    }),
  )
  // Per-provider dedup: same bare id from two providers → two picker rows.
  // Within one provider, later live rows win on id collision (stable map).
  const byKey = new Map<string, ModelInfo>()
  for (const r of results) {
    if (r.status !== "fulfilled") continue
    for (const { providerId, row } of r.value) {
      byKey.set(liveRowKey(providerId, row.id), {
        id: row.id,
        display_name: row.displayName,
        type: "model",
        created_at: row.createdAt,
      })
    }
  }
  return [...byKey.values()]
}
