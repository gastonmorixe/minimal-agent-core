import { discoverCredentialedProviders } from "../../auth/auth-strategies.ts"
import { listRegisteredModels, listRegisteredProviders } from "../../llm/model-registry.ts"
import { writeCommandTable } from "../ui/command-table.ts"

/**
 * `providers` (bare): list every provider registered in the canonical
 * registry (id, display name, surfaces, model count, credential count).
 * Reads the in-process registry only — no auth, no network. Providers are
 * registered at startup by the discovery loader, so this reflects every
 * `plugins/llm-*` package present.
 */
export function runListProvidersCommand(
  deps: { output?: { write(s: string): unknown } } = {},
): void {
  const providers = listRegisteredProviders()

  const modelCount = new Map<string, number>()
  for (const m of listRegisteredModels()) {
    modelCount.set(m.providerId, (modelCount.get(m.providerId) ?? 0) + 1)
  }

  // Count stored credentials per provider (all entries, not just default names)
  const credCount = new Map<string, number>()
  for (const c of discoverCredentialedProviders()) {
    credCount.set(c.providerId, (credCount.get(c.providerId) ?? 0) + 1)
  }

  if (providers.length === 0) {
    writeCommandTable(
      { columns: [{ key: "id" }], sections: [], empty: "no providers registered" },
      deps.output,
    )
    return
  }

  writeCommandTable(
    {
      columns: [
        { key: "id", minWidth: 16, color: "cyan" },
        { key: "name", minWidth: 20, color: "dim" },
        { key: "surfaces", color: "dim" },
        { key: "count", color: "dim" },
        { key: "auth", color: "dim" },
      ],
      sections: [
        {
          rows: [...providers]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((p) => {
              const mc = modelCount.get(p.id) ?? 0
              const cc = credCount.get(p.id) ?? 0
              const authStr = cc > 0 ? `${cc} credential${cc !== 1 ? "s" : ""}` : "no auth"
              return {
                cells: {
                  id: p.id,
                  name: p.displayName ?? "",
                  surfaces: p.surfaces.join(", "),
                  count: `(${mc} model${mc !== 1 ? "s" : ""})`,
                  auth: authStr,
                },
              }
            }),
        },
      ],
      summary: `${providers.length} providers · use 'providers models [id]' to list models`,
    },
    deps.output,
  )
}
