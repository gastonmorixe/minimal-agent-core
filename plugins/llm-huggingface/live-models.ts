/**
 * HuggingFace Inference Providers live model catalog.
 *
 * Implements the data side of `ProviderPlugin.listLiveModels`: a best-effort
 * GET of `https://router.huggingface.co/v1/models` (the router's
 * OpenAI-compatible "list chat-completion models served by Inference
 * Providers" endpoint) so `--list-models` / the picker show the AUTHORITATIVE
 * server catalog — every slug the router currently serves, not just the 3-entry
 * static snapshot in `./models.ts`.
 *
 * Uses the global `fetch` rather than the host transport: listing is a cold,
 * off-the-hot-path read, and keeping it on `fetch` lets this plugin stay free
 * of any `src/` import (mirrors `plugins/llm-ollama/live-models.ts`). Must
 * reject or resolve `[]` on failure — the host treats an error as "live list
 * unavailable" and falls back to the registry, so a router outage never hides
 * the built-in catalog.
 *
 * The `/v1/models` endpoint is public (no auth needed to list), but we forward
 * the stored token when present so the response reflects the authenticated
 * principal's view.
 *
 * @module llm/providers/huggingface/live-models
 */

import type { Capabilities } from "@minimal-agent/plugin-api/llm/capabilities"
import type { ProviderAuth } from "@minimal-agent/plugin-api/llm/provider-auth"
import type { LiveModelRow } from "@minimal-agent/plugin-api/llm/provider-plugin"

import {
  deriveHuggingFaceCapabilities,
  type HuggingFaceModelCapabilityInfo,
} from "./capabilities.ts"
import { MODELS_URL } from "./wire-constants.ts"

/** One entry of the `/v1/models` response `data[]` array. */
interface HuggingFaceModelRow extends HuggingFaceModelCapabilityInfo {
  id?: string
  object?: string
  /** Unix epoch seconds the router reports for the model. */
  created?: number
  owned_by?: string
}

interface HuggingFaceModelsResponse {
  data?: HuggingFaceModelRow[]
}

/** Strip an optional `:provider` / `:policy` routing suffix off a wire id. */
function baseModelId(modelId: string): string {
  const colon = modelId.indexOf(":")
  return colon === -1 ? modelId : modelId.slice(0, colon)
}

/**
 * Fetch the live `/v1/models` catalog and derive EXACT capabilities for one
 * model (tools, structured outputs, context window, image modality). Strips any
 * `:provider` suffix off `modelId` before matching. Resolves `null` on any
 * failure or when the model isn't in the catalog, so the caller keeps the
 * permissive default. Best-effort, never throws.
 */
export async function fetchHuggingFaceModelCapabilities(
  auth: ProviderAuth,
  modelId: string,
): Promise<Capabilities | null> {
  const token = bearerToken(auth)
  const headers: Record<string, string> = { accept: "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  let resp: Response
  try {
    resp = await fetch(MODELS_URL, { headers })
  } catch {
    return null
  }
  if (!resp.ok) return null
  let body: HuggingFaceModelsResponse
  try {
    body = (await resp.json()) as HuggingFaceModelsResponse
  } catch {
    return null
  }
  const want = baseModelId(modelId)
  const row = (body.data ?? []).find((r) => r.id === want)
  if (!row) return null
  return deriveHuggingFaceCapabilities(row)
}

/** Pull the Bearer token from provider auth, or null when not key/oauth. */
function bearerToken(auth: ProviderAuth): string | null {
  if (auth.kind === "api-key") return auth.key || null
  if (auth.kind === "oauth") return auth.token || null
  return null
}

/** Convert a Unix-epoch-seconds timestamp into an ISO `YYYY-MM-DD`, or undefined. */
export function epochToIsoDate(created: number | undefined): string | undefined {
  if (typeof created !== "number" || !Number.isFinite(created) || created <= 0) return undefined
  const d = new Date(created * 1000)
  if (Number.isNaN(d.getTime())) return undefined
  return d.toISOString().slice(0, 10)
}

/**
 * Map a parsed `/v1/models` body into the neutral {@link LiveModelRow}[] shape.
 * Skips rows without an `id`. Pure — no I/O, so it's directly unit-testable.
 */
export function mapHuggingFaceLiveModels(body: HuggingFaceModelsResponse): LiveModelRow[] {
  const rows = body.data ?? []
  const out: LiveModelRow[] = []
  for (const row of rows) {
    if (!row.id) continue
    out.push({ id: row.id, createdAt: epochToIsoDate(row.created) })
  }
  return out
}

/**
 * Fetch the live HuggingFace router model list. Returns rows ready for the
 * `--list-models` merge (id + ISO date). Resolves `[]` on any non-2xx / parse
 * failure so a server outage never hides the built-in catalog.
 */
export async function listHuggingFaceLiveModels(auth: ProviderAuth): Promise<LiveModelRow[]> {
  const token = bearerToken(auth)
  const headers: Record<string, string> = { accept: "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  let resp: Response
  try {
    resp = await fetch(MODELS_URL, { headers })
  } catch {
    return []
  }
  if (!resp.ok) return []
  let body: HuggingFaceModelsResponse
  try {
    body = (await resp.json()) as HuggingFaceModelsResponse
  } catch {
    return []
  }
  return mapHuggingFaceLiveModels(body)
}
