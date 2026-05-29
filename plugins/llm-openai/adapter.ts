/**
 * OpenAI `ProviderAdapter` implementation.
 *
 * One adapter, two surfaces. `adapter.run()` dispatches by
 * `ModelEntry.surfaceId`:
 *
 * - `"openai-chat-completions"`     → POST `/v1/chat/completions`, translated by
 *                          `translateOpenAIChatStream`.
 * - `"openai-responses"`→ POST `/v1/responses`, translated by
 *                          `translateOpenAIResponsesStream`.
 *
 * Like the Anthropic adapter, retry / watchdog / observer live one layer
 * up (provider-neutral); this file only knows the wire format. The
 * generic `parseSse` parser ignores the Responses API's `event:` lines
 * and the per-chunk `obfuscation` padding (unknown JSON keys are
 * tolerated).
 *
 * @module llm/providers/openai/adapter
 */

import { defaultNetworkClient, type NetworkClient } from "../../src/network/index.ts"
import type { CanonicalEvent } from "../../src/llm/canonical-events.ts"
import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import { type ModelEntry, registerProvider } from "../../src/llm/model-registry.ts"
import type {
  ProviderAdapter,
  ProviderAuth,
  RunContext,
  SurfaceId,
  ValidationResult,
} from "../../src/llm/provider.ts"
import type { ProviderPlugin } from "../../src/llm/provider-plugin.ts"
import { parseSse } from "../../src/llm/streaming/sse-parser.ts"

import { buildOpenAIChatBody } from "./chat/request-body.ts"
import { type OpenAIChatChunk, translateOpenAIChatStream } from "./chat/response-stream.ts"
import { buildOpenAIHeaders } from "./headers.ts"
import { registerOpenAIModels } from "./models.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"
import {
  type OpenAIResponsesEvent,
  translateOpenAIResponsesStream,
} from "./responses/response-stream.ts"
import { fetchOpenAISessionInfo, setOpenAIRateLimits } from "./session-info.ts"
import { validateOpenAIRequest } from "./validate.ts"
import { CHAT_COMPLETIONS_URL, RESPONSES_URL } from "./wire-constants.ts"

/**
 * OpenAI adapter (Chat Completions + Responses). Singleton; register
 * once at module load via {@link bootstrapOpenAI}.
 */
export const openaiAdapter: ProviderAdapter = {
  id: "openai",
  displayName: "OpenAI",
  surfaces: ["openai-chat-completions", "openai-responses"] satisfies ReadonlyArray<SurfaceId>,

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
      throw new Error("OpenAI adapter: missing api-key")
    }
    if (auth.kind === "oauth" && !auth.token) {
      throw new Error("OpenAI adapter: missing oauth token")
    }

    const headers = buildOpenAIHeaders({ auth })
    const networkClient = (ctx.networkClient as NetworkClient | undefined) ?? defaultNetworkClient

    if (model.surfaceId === "openai-chat-completions") {
      const body = buildOpenAIChatBody(req, model)
      ctx.debug?.header(`POST ${CHAT_COMPLETIONS_URL}`)
      ctx.debug?.kv("model", body.model)
      ctx.debug?.kv("surface", "chat")
      ctx.debug?.headers(headers)
      ctx.debug?.body(body)

      const response = await networkClient.request({
        label: "openai.chat.completions",
        method: "POST",
        url: CHAT_COMPLETIONS_URL,
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`OpenAI Chat API ${response.status}: ${text}`)
      }
      // Capture rate-limit headers for the status-bar footer. Best-effort +
      // non-throwing; no behavior change to the stream below.
      setOpenAIRateLimits(response.headers)
      if (!response.body) {
        throw new Error("OpenAI Chat API: empty response body for stream")
      }
      yield* translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))
      return
    }

    if (model.surfaceId === "openai-responses") {
      const body = buildOpenAIResponsesBody(req, model)
      ctx.debug?.header(`POST ${RESPONSES_URL}`)
      ctx.debug?.kv("model", body.model)
      ctx.debug?.kv("surface", "responses")
      ctx.debug?.headers(headers)
      ctx.debug?.body(body)

      const response = await networkClient.request({
        label: "openai.responses",
        method: "POST",
        url: RESPONSES_URL,
        headers,
        body: JSON.stringify(body),
        signal: req.signal,
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`OpenAI Responses API ${response.status}: ${text}`)
      }
      // Capture rate-limit headers for the status-bar footer. Best-effort +
      // non-throwing; no behavior change to the stream below.
      setOpenAIRateLimits(response.headers)
      if (!response.body) {
        throw new Error("OpenAI Responses API: empty response body for stream")
      }
      yield* translateOpenAIResponsesStream(parseSse<OpenAIResponsesEvent>(response.body))
      return
    }

    throw new Error(
      `OpenAI adapter: model ${model.id} has unsupported surface "${model.surfaceId}"`,
    )
  },
}

/**
 * Register the OpenAI adapter + its model catalog into the global
 * registry. Idempotent. Call once at application start (alongside
 * `bootstrapAnthropic()`). After this, `resolveModel("gpt-5.5")` and
 * `run()` can reach the OpenAI surfaces.
 */
export function bootstrapOpenAI(): void {
  registerOpenAIModels()
  registerProvider(openaiAdapter)
}

/** This provider packaged for the {@link ProviderPlugin} registry. */
export const openaiProviderPlugin: ProviderPlugin = {
  id: "openai",
  displayName: "OpenAI",
  shortCode: "oai",
  register: bootstrapOpenAI,
  fetchSessionInfo: fetchOpenAISessionInfo,
}

export type { ProviderAuth }
