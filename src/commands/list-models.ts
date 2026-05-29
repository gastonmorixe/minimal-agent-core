import { c } from "../agent.ts"
import type { AuthResult } from "../auth.ts"
import { listModels } from "../client.ts"
import { listRegisteredModels } from "../llm/model-registry.ts"

interface ModelRow {
  id: string
  displayName?: string
  providerId: string
  surface?: string
  date?: string
}

export async function runListModelsCommand(
  auth: AuthResult,
  providerFilter?: string,
): Promise<void> {
  const byId = new Map<string, ModelRow>()

  // Live Anthropic catalog (authoritative + real-time from api.anthropic.com).
  // Resilient: a network/auth failure shouldn't hide the registered catalog.
  try {
    for (const m of await listModels(auth)) {
      byId.set(m.id, {
        id: m.id,
        displayName: m.display_name,
        providerId: "anthropic",
        surface: "anthropic-messages",
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
      surface: entry.surfaceId,
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

  const providerIds = providerFilter ? [providerFilter] : [...byProvider.keys()].sort()

  // Column widths sized to the rows actually being shown, so long ids
  // (`claude-sonnet-4-5-20250929[1m]`), long display names
  // (`Claude Sonnet 4.5 (1M context)`), and long surfaces
  // (`openai-chat-completions`) stay aligned instead of overflowing a
  // hardcoded pad. Small floors keep narrow tables from looking cramped.
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
