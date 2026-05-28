import { c } from "../agent.ts"
import { listRegisteredModels, listRegisteredProviders } from "../llm/model-registry.ts"

/**
 * `providers` (bare): list every provider registered in the canonical
 * registry (id, display name, surfaces, model count). Reads the
 * in-process registry only — no auth, no network. Providers are
 * registered at startup by the discovery loader, so this reflects every
 * `plugins/llm-*` package present.
 */
export function runListProvidersCommand(): void {
  const providers = listRegisteredProviders()

  const modelCount = new Map<string, number>()
  for (const m of listRegisteredModels()) {
    modelCount.set(m.providerId, (modelCount.get(m.providerId) ?? 0) + 1)
  }

  console.log("")
  if (providers.length === 0) {
    console.log(`  ${c.dim("no providers registered")}`)
    return
  }

  for (const p of [...providers].sort((a, b) => a.id.localeCompare(b.id))) {
    const id = c.cyan(p.id.padEnd(16))
    const name = c.dim((p.displayName ?? "").padEnd(20))
    const surfaces = c.dim(p.surfaces.join(", "))
    const n = modelCount.get(p.id) ?? 0
    console.log(`  ${id} ${name} ${surfaces}  ${c.dim(`(${n} models)`)}`)
  }

  console.log("")
  console.log(
    `  ${c.dim(`${providers.length} providers · use 'providers models [id]' to list models`)}`,
  )
}
