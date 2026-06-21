/**
 * OpenCode Go `ProviderAdapter` — a dual-surface cross-plugin-reuse example.
 *
 * OpenCode Go (opencode.ai/go) is a low-cost subscription to open-weight
 * models. It exposes two wire formats depending on the model:
 *
 * - **OpenAI Chat Completions** (`/v1/chat/completions`) — DeepSeek, GLM,
 *   Kimi, MiMo.
 * - **Anthropic Messages** (`/v1/messages`) — MiniMax, Qwen.
 *
 * This adapter REUSES `plugins/llm-openai`'s wire layer for the Chat
 * surface and `plugins/llm-anthropic`'s wire layer for the Messages
 * surface. Only the endpoints and auth strategy differ.
 *
 * Auth: a Bearer API key from minimal-agent's provider auth store.
 *
 * @module llm/providers/opencode
 */

import type { CanonicalEvent } from "@minimal-agent/plugin-api/llm/canonical-events"
import type { RunContext } from "@minimal-agent/plugin-api/llm/provider-auth"
import type { ProviderPlugin } from "@minimal-agent/plugin-api/llm/provider-plugin"
import type { NetworkClient } from "@minimal-agent/plugin-api/net/types"
import type { SubagentModelRecommendation } from "@minimal-agent/plugin-api/types/plugin"
import { parseSse } from "@minimal-agent/plugin-api/utils/sse-parser"

import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import { findModelByTags, type ModelEntry, registerProvider } from "../../src/llm/model-registry.ts"
import type { ProviderAdapter, SurfaceId, ValidationResult } from "../../src/llm/provider.ts"
import { defaultNetworkClient } from "../../src/network/index.ts"
import {
  type AnthropicStreamEvent,
  buildAnthropicRequestBody,
  translateAnthropicStream,
  validateAnthropicRequest,
} from "../llm-anthropic/index.ts"
import {
  buildOpenAIChatBody,
  buildOpenAIHeaders,
  type OpenAIChatChunk,
  translateOpenAIChatStream,
  validateOpenAIRequest,
} from "../llm-openai/index.ts"

import { opencodeApiKeyAuth } from "./auth.ts"
import { CAPS_OPENCODE_CHAT_FALLBACK } from "./capabilities.ts"
import { registerOpencodeModel, registerOpencodeModels } from "./models.ts"
import { PRICING_OPENCODE_GENERIC } from "./pricing.ts"

const OPENCODE_CHAT_URL = "https://opencode.ai/zen/go/v1/chat/completions"
const OPENCODE_MESSAGES_URL = "https://opencode.ai/zen/go/v1/messages"

function buildOpencodeMessagesHeaders(auth: RunContext["auth"]): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "user-agent": "minimal-agent-opencode/0.1",
  }
  if (auth.kind === "api-key") {
    headers["x-api-key"] = auth.key
  } else if (auth.kind === "oauth") {
    headers["authorization"] = `Bearer ${auth.token}`
  } else {
    Object.assign(headers, auth.headers)
  }
  return headers
}

export const opencodeAdapter: ProviderAdapter = {
  id: "opencode",
  displayName: "OpenCode Go",
  surfaces: ["openai-chat-completions", "anthropic-messages"] satisfies ReadonlyArray<SurfaceId>,

  validate(req: CanonicalRequest, model: ModelEntry): ValidationResult {
    if (model.surfaceId === "openai-chat-completions") {
      return validateOpenAIRequest(req, model)
    }
    return validateAnthropicRequest(req, model)
  },

  async *run(
    req: CanonicalRequest,
    model: ModelEntry,
    ctx: RunContext,
  ): AsyncIterable<CanonicalEvent> {
    const auth = ctx.auth
    if (auth.kind === "api-key" && !auth.key) {
      throw new Error(
        "OpenCode Go adapter: missing api-key (run `minimal-agent provider opencode login`)",
      )
    }

    const networkClient = (ctx.networkClient as NetworkClient | undefined) ?? defaultNetworkClient

    if (model.surfaceId === "openai-chat-completions") {
      const headers = buildOpenAIHeaders({ auth })
      const body = buildOpenAIChatBody(req, model)
      const serialized = JSON.stringify(body)

      ctx.debug?.header(`POST ${OPENCODE_CHAT_URL}`)
      ctx.debug?.kv("model", body.model)
      ctx.debug?.headers(headers)
      ctx.debug?.body(body)

      const response = await networkClient.request({
        label: "opencode.chat.completions",
        method: "POST",
        url: OPENCODE_CHAT_URL,
        headers,
        body: serialized,
        signal: req.signal,
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`OpenCode Go API ${response.status}: ${text}`)
      }
      if (!response.body) {
        throw new Error("OpenCode Go API: empty response body for stream")
      }
      yield* translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))
    } else if (model.surfaceId === "anthropic-messages") {
      const headers = buildOpencodeMessagesHeaders(auth)
      const body = buildAnthropicRequestBody(req, model)
      const serialized = JSON.stringify(body)

      ctx.debug?.header(`POST ${OPENCODE_MESSAGES_URL}`)
      ctx.debug?.kv("model", body.model)
      ctx.debug?.headers(headers)
      ctx.debug?.body(body)

      const response = await networkClient.request({
        label: "opencode.messages",
        method: "POST",
        url: OPENCODE_MESSAGES_URL,
        headers,
        body: serialized,
        signal: req.signal,
      })

      if (!response.ok) {
        const text = await response.text()
        throw new Error(`OpenCode Go API ${response.status}: ${text}`)
      }
      if (!response.body) {
        throw new Error("OpenCode Go API: empty response body for stream")
      }
      yield* translateAnthropicStream(parseSse<AnthropicStreamEvent>(response.body))
    } else {
      throw new Error(`OpenCode Go adapter: unhandled surface "${model.surfaceId}"`)
    }
  },

  recommendSubagentModels(): SubagentModelRecommendation[] {
    const recs: SubagentModelRecommendation[] = []
    const scout = findModelByTags("opencode", ["cheap"])
    if (scout) recs.push({ role: "scout", modelId: scout.id })
    const balanced = findModelByTags("opencode", ["openai-compatible"])
    const balancedPick = balanced && balanced.id !== scout?.id ? balanced : undefined
    if (balancedPick) recs.push({ role: "balanced", modelId: balancedPick.id })
    return recs
  },
}

/** Register the OpenCode Go adapter + catalog. Idempotent. */
export function bootstrapOpencode(): void {
  registerOpencodeModels()
  registerProvider(opencodeAdapter)
}

/** Register a one-off OpenCode Go slug that is not in the built-in catalog. */
export function registerOpencodeAdHocModel(modelId: string): void {
  registerOpencodeModel({
    id: modelId,
    providerId: "opencode",
    displayName: modelId,
    tags: ["opencode"],
    surfaceId: "openai-chat-completions",
    capabilities: CAPS_OPENCODE_CHAT_FALLBACK,
    pricing: PRICING_OPENCODE_GENERIC,
  })
}

export const opencodeProviderPlugin: ProviderPlugin = {
  id: "opencode",
  displayName: "OpenCode Go",
  shortCode: "og",
  register: bootstrapOpencode,
  registerAdHocModel: registerOpencodeAdHocModel,
  apiKeyAuth: opencodeApiKeyAuth,
}
