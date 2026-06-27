/**
 * Anthropic live model catalog: `GET /v1/models?beta=true`, plus the
 * synthesized client-side `[1m]` context-window variants.
 *
 * Owned by the plugin because both the endpoint and the `[1m]` family
 * knowledge are Anthropic-specific. The adapter's `listLiveModels` hook maps
 * the result into the neutral `LiveModelRow` shape the host consumes.
 *
 * @module llm-anthropic/list-models
 */

import type { CanonicalRequest } from "@minimal-agent/plugin-api/llm/canonical-request"
import type { NetworkClient } from "@minimal-agent/plugin-api/net/types"

import type { AuthResult } from "../../src/auth.ts"
import { resolveModel } from "../../src/llm/model-registry.ts"
import { defaultNetworkClient } from "../../src/network/index.ts"

import { buildAnthropicHeaders } from "./headers.ts"

/** One model row as the models endpoint reports it. */
export interface AnthropicModelInfo {
  id: string
  display_name?: string
  type?: string
  created_at?: string
}

const MODELS_URL = "https://api.anthropic.com/v1/models?beta=true"

/**
 * The model families that support the 1M context window (as of 2026-06-09):
 * Sonnet 4 / 4.5 / 4.6; Opus 4.6 / 4.7 / 4.8 (gated explicitly to avoid the
 * 200k opus-4-0/4-1 ids); Fable 5 (1M-native).
 */
function supports1M(id: string): boolean {
  return (
    id.includes("claude-sonnet-4") ||
    id.includes("opus-4-6") ||
    id.includes("opus-4-7") ||
    id.includes("opus-4-8") ||
    id.includes("claude-fable-5")
  )
}

/**
 * List models available to the authenticated principal, plus a synthesized
 * `[1m]`-suffixed variant for every 1M-capable model. The suffix is a
 * client-side convention (the API itself has no `[1m]` id); 1M activation
 * happens via a beta capability flag.
 *
 * @param auth - Anthropic credential (OAuth or API key).
 * @param networkClient - Network client for the request.
 * @returns The model rows plus `[1m]` variants.
 */
export async function listAnthropicModels(
  auth: AuthResult,
  networkClient: NetworkClient = defaultNetworkClient,
): Promise<AnthropicModelInfo[]> {
  // A model-list GET carries no real message payload; a minimal canonical
  // request is enough for the header builder to classify it + pick flags.
  const req: CanonicalRequest = {
    modelId: "claude-opus-4-8",
    messages: [{ role: "user", content: [{ type: "text", text: "" }] }],
  }
  const { headers } = buildAnthropicHeaders({
    req,
    model: resolveModel("claude-opus-4-8"),
    auth:
      auth.type === "oauth"
        ? { kind: "oauth", token: auth.token }
        : { kind: "api-key", key: auth.token },
    sessionId: process.env.MINIMAL_AGENT_SESSION_ID ?? "list-models",
  })

  const response = await networkClient.request({
    label: "models.list",
    method: "GET",
    url: MODELS_URL,
    headers,
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Models API ${response.status}: ${errorBody}`)
  }

  const data = await response.json<{ data: AnthropicModelInfo[] }>()
  const models = data.data

  const variants: AnthropicModelInfo[] = []
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
