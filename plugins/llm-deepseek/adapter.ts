/**
 * DeepSeek `ProviderAdapter` — a cross-plugin-reuse demonstration.
 *
 * DeepSeek's API is OpenAI Chat Completions-compatible, so this adapter
 * REUSES `plugins/llm-openai`'s building blocks wholesale:
 *
 * - `buildOpenAIChatBody`       (canonical request → Chat Completions body)
 * - `translateOpenAIChatStream` (Chat Completions SSE → CanonicalEvent)
 * - `buildOpenAIHeaders`        (Bearer auth headers)
 * - `validateOpenAIRequest`     (capability gating)
 *
 * Only the endpoint + model catalog + pricing differ. This is exactly the
 * "providers reuse the OpenAI/Anthropic spec with a different endpoint"
 * pattern the canonical layer + provider-plugin packaging are designed for:
 * a new OpenAI-compatible vendor is ~5 small files plus a `provider.json`.
 *
 * @module llm/providers/deepseek/adapter
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
import { registerDeepSeekModels } from "./models.ts"

const DEEPSEEK_CHAT_URL = "https://api.deepseek.com/chat/completions"

/** DeepSeek adapter. Speaks the OpenAI Chat surface against DeepSeek's host. */
export const deepseekAdapter: ProviderAdapter = {
  id: "deepseek",
  displayName: "DeepSeek",
  surfaces: ["openai-chat"] satisfies ReadonlyArray<SurfaceId>,

  validate(req, model): ValidationResult {
    // Same capability gating as OpenAI Chat — DeepSeek shares the surface.
    return validateOpenAIRequest(req, model)
  },

  async *run(
    req: CanonicalRequest,
    model: ModelEntry,
    ctx: RunContext,
  ): AsyncIterable<CanonicalEvent> {
    const auth = ctx.auth
    if (auth.kind === "api-key" && !auth.key) {
      throw new Error("DeepSeek adapter: missing api-key")
    }

    const headers = buildOpenAIHeaders({ auth })
    const body = buildOpenAIChatBody(req, model)
    ctx.debug?.header(`POST ${DEEPSEEK_CHAT_URL}`)
    ctx.debug?.kv("model", body.model)
    ctx.debug?.headers(headers)
    ctx.debug?.body(body)

    const networkClient = (ctx.networkClient as NetworkClient | undefined) ?? defaultNetworkClient
    const response = await networkClient.request({
      label: "deepseek.chat.completions",
      method: "POST",
      url: DEEPSEEK_CHAT_URL,
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`DeepSeek API ${response.status}: ${text}`)
    }
    if (!response.body) {
      throw new Error("DeepSeek API: empty response body for stream")
    }
    yield* translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))
  },
}

/** Register the DeepSeek adapter + catalog. Idempotent. */
export function bootstrapDeepSeek(): void {
  registerDeepSeekModels()
  registerProvider(deepseekAdapter)
}

/** This provider packaged for the {@link ProviderPlugin} registry. */
export const deepseekProviderPlugin: ProviderPlugin = {
  id: "deepseek",
  displayName: "DeepSeek",
  shortCode: "ds",
  register: bootstrapDeepSeek,
}
