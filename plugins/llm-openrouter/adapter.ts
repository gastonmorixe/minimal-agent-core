/**
 * OpenRouter `ProviderAdapter` — a cross-plugin-reuse example.
 *
 * OpenRouter (openrouter.ai) is an OpenAI Chat Completions-compatible
 * gateway to many upstream models, so this adapter REUSES
 * `plugins/llm-openai`'s wire layer wholesale (`buildOpenAIChatBody`,
 * `translateOpenAIChatStream`, `buildOpenAIHeaders`, `validateOpenAIRequest`).
 * Only the endpoint, model catalog, auth env var, and the optional
 * OpenRouter attribution header differ.
 *
 * Auth: a Bearer key from `OPENROUTER_KEY`, passed via
 * `RunContext.auth = { kind: "api-key", key }`.
 *
 * @module llm/providers/openrouter/adapter
 */

import { defaultNetworkClient, type NetworkClient } from "../../src/network/index.ts"
import type { CanonicalEvent } from "../../src/llm/canonical-events.ts"
import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import { type ModelEntry, registerProvider } from "../../src/llm/model-registry.ts"
import type { ProviderPlugin } from "../../src/llm/provider-plugin.ts"
import type {
  ProviderAdapter,
  RunContext,
  SurfaceId,
  ValidationResult,
} from "../../src/llm/provider.ts"
import { parseSse } from "../../src/llm/streaming/sse-parser.ts"
import {
  buildOpenAIChatBody,
  buildOpenAIHeaders,
  type OpenAIChatChunk,
  translateOpenAIChatStream,
  validateOpenAIRequest,
} from "../llm-openai/index.ts"
import { registerOpenRouterModels } from "./models.ts"
import { fetchOpenRouterSessionInfo, setOpenRouterRateLimits } from "./session-info.ts"

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"

/** OpenRouter adapter. Speaks the OpenAI Chat surface against OpenRouter's host. */
export const openrouterAdapter: ProviderAdapter = {
  id: "openrouter",
  displayName: "OpenRouter",
  surfaces: ["openai-chat-completions"] satisfies ReadonlyArray<SurfaceId>,

  validate(req, model): ValidationResult {
    return validateOpenAIRequest(req, model)
  },

  async *run(
    req: CanonicalRequest,
    model: ModelEntry,
    ctx: RunContext,
  ): AsyncIterable<CanonicalEvent> {
    const auth = ctx.auth
    if (auth.kind === "api-key" && !auth.key) {
      throw new Error("OpenRouter adapter: missing api-key (set OPENROUTER_KEY)")
    }

    const headers = buildOpenAIHeaders({ auth })
    // Optional OpenRouter attribution header (used for their app leaderboard).
    headers["x-title"] = "minimal-agent"
    const body = buildOpenAIChatBody(req, model)
    ctx.debug?.header(`POST ${OPENROUTER_CHAT_URL}`)
    ctx.debug?.kv("model", body.model)
    ctx.debug?.headers(headers)
    ctx.debug?.body(body)

    const networkClient = (ctx.networkClient as NetworkClient | undefined) ?? defaultNetworkClient
    const response = await networkClient.request({
      label: "openrouter.chat.completions",
      method: "POST",
      url: OPENROUTER_CHAT_URL,
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`OpenRouter API ${response.status}: ${text}`)
    }
    // Capture rate-limit headers for the status-bar footer. Best-effort +
    // non-throwing; no behavior change to the stream below.
    setOpenRouterRateLimits(response.headers)
    if (!response.body) {
      throw new Error("OpenRouter API: empty response body for stream")
    }
    yield* translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))
  },
}

/** Register the OpenRouter adapter + catalog. Idempotent. */
export function bootstrapOpenRouter(): void {
  registerOpenRouterModels()
  registerProvider(openrouterAdapter)
}

/** This provider packaged for the {@link ProviderPlugin} registry. */
export const openrouterProviderPlugin: ProviderPlugin = {
  id: "openrouter",
  displayName: "OpenRouter",
  shortCode: "or",
  register: bootstrapOpenRouter,
  fetchSessionInfo: fetchOpenRouterSessionInfo,
}
