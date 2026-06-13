import { listRegisteredModels, listRegisteredProviders } from "../llm/model-registry.ts"
import { writeCommandTable } from "../ui/command-table.ts"

/**
 * `providers` (bare): list every provider registered in the canonical
 * registry (id, display name, surfaces, model count). Reads the
 * in-process registry only — no auth, no network. Providers are
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
      ],
      sections: [
        {
          rows: [...providers]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((p) => ({
              cells: {
                id: p.id,
                name: p.displayName ?? "",
                surfaces: p.surfaces.join(", "),
                count: `(${modelCount.get(p.id) ?? 0} models)`,
              },
            })),
        },
      ],
      summary: `${providers.length} providers · use 'providers models [id]' to list models`,
    },
    deps.output,
  )
}
