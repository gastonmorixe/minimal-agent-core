/**
 * Ollama Cloud live model catalog.
 *
 * Implements the data side of `ProviderPlugin.listLiveModels`: a best-effort
 * GET of `https://ollama.com/api/tags` (the documented "list models available
 * directly via Ollama's API" endpoint) so `--list-models` / the picker show the
 * AUTHORITATIVE server catalog — every cloud slug the account can run right now,
 * not just the static built-in snapshot.
 *
 * Uses the global `fetch` rather than the host transport: listing is a cold,
 * off-the-hot-path read, and keeping it on `fetch` lets this plugin stay free of
 * any `src/` import. Must reject or resolve `[]` on failure — the host treats an
 * error as "live list unavailable" and falls back to the registry.
 *
 * @module llm/providers/ollama/live-models
 */

import type { ProviderAuth } from "@minimal-agent/plugin-api/llm/provider-auth"
import type { LiveModelRow } from "@minimal-agent/plugin-api/llm/provider-plugin"

const OLLAMA_TAGS_URL = "https://ollama.com/api/tags"

/** One row of the `/api/tags` response. */
interface OllamaTagRow {
  name?: string
  model?: string
  modified_at?: string
}

interface OllamaTagsResponse {
  models?: OllamaTagRow[]
}

/** Pull the Bearer token from provider auth, or null when not key/oauth. */
function bearerToken(auth: ProviderAuth): string | null {
  if (auth.kind === "api-key") return auth.key || null
  if (auth.kind === "oauth") return auth.token || null
  return null
}

/**
 * Fetch the live Ollama Cloud model list. Returns rows ready for the
 * `--list-models` merge (id + ISO date). Resolves `[]` when unauthenticated or
 * on any non-2xx / parse failure, so a server outage never hides the catalog.
 */
export async function listOllamaLiveModels(auth: ProviderAuth): Promise<LiveModelRow[]> {
  const token = bearerToken(auth)
  if (!token) return []
  let resp: Response
  try {
    resp = await fetch(OLLAMA_TAGS_URL, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    })
  } catch {
    return []
  }
  if (!resp.ok) return []
  let body: OllamaTagsResponse
  try {
    body = (await resp.json()) as OllamaTagsResponse
  } catch {
    return []
  }
  const rows = body.models ?? []
  const out: LiveModelRow[] = []
  for (const row of rows) {
    const id = row.model ?? row.name
    if (!id) continue
    out.push({
      id,
      createdAt: typeof row.modified_at === "string" ? row.modified_at.slice(0, 10) : undefined,
    })
  }
  return out
}
