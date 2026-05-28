import { c } from "../agent.ts"
import type { AuthResult } from "../auth.ts"
import { listModels } from "../client.ts"
import { listRegisteredModels } from "../llm/model-registry.ts"

interface ModelRow {
  id: string
  displayName?: string
  providerId: string
  date?: string
}

export async function runListModelsCommand(auth: AuthResult): Promise<void> {
  const byId = new Map<string, ModelRow>()

  // Live Anthropic catalog (authoritative + real-time from api.anthropic.com).
  // Resilient: a network/auth failure shouldn't hide the registered catalog.
  try {
    for (const m of await listModels(auth)) {
      byId.set(m.id, {
        id: m.id,
        displayName: m.display_name,
        providerId: "anthropic",
        date: m.created_at?.slice(0, 10),
      })
    }
  } catch (err) {
    console.error(
      `  ${c.dim(`(live Anthropic model list unavailable: ${err instanceof Error ? err.message : String(err)})`)}`,
    )
  }

  // Canonical registry adds every other registered provider (OpenAI's
  // gpt-5.x / gpt-4 / o-series, plus any discovered provider plugins).
  // Live entries win on id collision (they carry real created_at dates).
  for (const entry of listRegisteredModels()) {
    if (byId.has(entry.id)) continue
    byId.set(entry.id, {
      id: entry.id,
      displayName: entry.displayName,
      providerId: entry.providerId,
      date: entry.knowledgeCutoff,
    })
  }

  // Group by provider (anthropic / openai / …).
  const byProvider = new Map<string, ModelRow[]>()
  for (const row of byId.values()) {
    const list = byProvider.get(row.providerId)
    if (list) list.push(row)
    else byProvider.set(row.providerId, [row])
  }

  console.log("")
  for (const [provider, rows] of [...byProvider.entries()].sort()) {
    console.log(`  ${c.bold(provider)}`)
    for (const row of rows.sort((a, b) => a.id.localeCompare(b.id))) {
      const id = c.cyan(row.id.padEnd(30))
      const name = row.displayName ? c.dim(row.displayName.padEnd(28)) : "".padEnd(28)
      const date = row.date ? c.dim(row.date) : ""
      console.log(`    ${id} ${name} ${date}`)
    }
    console.log("")
  }
  console.log(`  ${c.dim(`${byId.size} models available`)}`)
}
