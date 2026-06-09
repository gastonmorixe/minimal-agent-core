/**
 * listModels : fetch available models for this user.
 *
 * Extracted from `client.ts` (which re-exports `listModels` so existing
 * importers keep resolving).
 */

import type { AuthResult } from "../auth.ts"
import { buildHeaders } from "../headers.ts"
import { getSessionId } from "../metadata.ts"
import { defaultNetworkClient, type NetworkClient } from "../network/index.ts"

import { debugHeader, debugResponse } from "./debug.ts"
import type { ModelInfo } from "./types.ts"

/** Endpoint for listing available models. */
const MODELS_URL = "https://api.anthropic.com/v1/models?beta=true"

/**
 * List models available to the authenticated user, plus synthesized
 * `[1m]` context-window variants.
 *
 * Calls `GET /v1/models?beta=true` (matching the Anthropic SDK's `list()`
 * method) to fetch the real model list, then appends `[1m]`-suffixed copies
 * for any model that supports the 1M context window. The suffix is a
 * client-side convention : the API itself doesn't know about it. The
 * `--list-models` CLI flag uses this expanded list so users can pick
 * `claude-opus-4-7[1m]` from the menu and get 1M context automatically.
 *
 * @param auth Authenticated credentials
 * @param networkClient Network client used for the models request.
 * @returns Array of {@link ModelInfo}, with `[1m]` variants appended
 *
 * @see cc-03312026/src/utils/context.ts:modelSupports1M()
 */
export async function listModels(
  auth: AuthResult,
  networkClient: NetworkClient = defaultNetworkClient,
): Promise<ModelInfo[]> {
  const sessionId = getSessionId()
  const headers = buildHeaders(auth, sessionId)

  debugHeader(`GET ${MODELS_URL}`)

  const response = await networkClient.request({
    label: "models.list",
    method: "GET",
    url: MODELS_URL,
    headers,
  })

  debugResponse(response.status, response.headers)

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Models API ${response.status}: ${errorBody}`)
  }

  const data = await response.json<{ data: ModelInfo[] }>()
  const models = data.data

  // Synthesize 1M context variants for models that support it.
  // The CLI uses a client-side [1m] suffix convention : these aren't separate
  // API model IDs. The actual 1M activation happens via the context-1m-2025-08-07
  // beta flag. See cc-03312026/src/utils/context.ts:modelSupports1M().
  //
  // 1M-capable families (as of 2026-05-28 / claude-code 2.1.154):
  //   - Sonnet 4 / 4.5 / 4.6  (sonnet-4 substring match)
  //   - Opus 4.6 / 4.7 / 4.8  (each gated explicitly to avoid catching
  //     older opus-4-0/4-1 ids which were 200k)
  const supports1M = (id: string) =>
    id.includes("claude-sonnet-4") ||
    id.includes("opus-4-6") ||
    id.includes("opus-4-7") ||
    id.includes("opus-4-8") ||
    id.includes("claude-fable-5")

  const variants: ModelInfo[] = []
  for (const m of models) {
    if (supports1M(m.id)) {
      variants.push({
        ...m,
        id: `${m.id}[1m]`,
        display_name: m.display_name ? `${m.display_name} (1M context)` : `${m.id} (1M context)`,
      })
    }
  }

  return [...models, ...variants]
}
