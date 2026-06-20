/**
 * OpenRouter `ProviderAdapter` — a cross-plugin-reuse example.
 *
 * OpenRouter (openrouter.ai) is an OpenAI Chat Completions-compatible
 * gateway to many upstream models, so this adapter REUSES
 * `plugins/llm-openai`'s wire layer wholesale (`buildOpenAIChatBody`,
 * `translateOpenAIChatStream`, `buildOpenAIHeaders`, `validateOpenAIRequest`).
 * Only the endpoint, model catalog, auth strategy, and the optional
 * OpenRouter attribution header differ.
 *
 * Auth: a Bearer key from minimal-agent's provider auth store, passed via
 * `RunContext.auth = { kind: "api-key", key }`.
 *
 * @module llm/providers/openrouter/adapter
 */

import { type CanonicalEvent, isEvent } from "@minimal-agent/plugin-api/llm/canonical-events"
import { classifyUpstreamError } from "@minimal-agent/plugin-api/llm/errors"
import type { RunContext } from "@minimal-agent/plugin-api/llm/provider-auth"
import type { ProviderPlugin } from "@minimal-agent/plugin-api/llm/provider-plugin"
import type { SubagentModelRecommendation } from "@minimal-agent/plugin-api/types/plugin"
import { parseSse } from "@minimal-agent/plugin-api/utils/sse-parser"

import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import { findModelByTags, type ModelEntry, registerProvider } from "../../src/llm/model-registry.ts"
import type { ProviderAdapter, SurfaceId, ValidationResult } from "../../src/llm/provider.ts"
import { defaultNetworkClient, type NetworkClient } from "../../src/network/index.ts"
import {
  buildOpenAIChatBody,
  buildOpenAIHeaders,
  type OpenAIChatChunk,
  translateOpenAIChatStream,
  validateOpenAIRequest,
} from "../llm-openai/index.ts"

import { openRouterApiKeyAuth } from "./auth.ts"
import { registerOpenRouterModel, registerOpenRouterModels } from "./models.ts"
import {
  accumulateOpenRouterUsage,
  fetchOpenRouterSessionInfo,
  setOpenRouterRateLimits,
} from "./session-info.ts"

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
      throw new Error(
        "OpenRouter adapter: missing api-key (run minimal-agent provider openrouter login)",
      )
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
      throw taggedHttpError("OpenRouter API", response.status, text)
    }
    // Capture rate-limit headers for the status-bar footer. Best-effort +
    // non-throwing; no behavior change to the stream below.
    setOpenRouterRateLimits(response.headers)
    if (!response.body) {
      throw new Error("OpenRouter API: empty response body for stream")
    }
    // Accumulate usage from the stream's terminal message_delta event so the
    // footer displays per-session token totals and estimated cost.
    for await (const ev of translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))) {
      if (isEvent(ev, "message_delta")) {
        accumulateOpenRouterUsage(ev.usage)
      }
      yield ev
    }
  },

  /**
   * Recommend OpenRouter models per abstract sub-agent role, from THIS
   * provider's own (representative) catalog by tag. scout → a `cheap` model;
   * balanced → an openai-compatible non-cheap model. `deep` is intentionally
   * left unmapped here (the thin built-in catalog has no clear flagship), so
   * the caller falls back to the lead's own model for deep work.
   */
  recommendSubagentModels(): SubagentModelRecommendation[] {
    const recs: SubagentModelRecommendation[] = []
    const scout = findModelByTags("openrouter", ["cheap"])
    if (scout) recs.push({ role: "scout", modelId: scout.id })
    const balanced = findModelByTags("openrouter", ["openai-compatible"])
    // prefer a DIFFERENT model than scout for balanced when possible
    const balancedPick = balanced && balanced.id !== scout?.id ? balanced : undefined
    if (balancedPick) recs.push({ role: "balanced", modelId: balancedPick.id })
    return recs
  },
}

/**
 * Parse the OpenRouter error code out of a non-2xx JSON body. OpenRouter
 * returns the standard OpenAI error shape:
 * `{"error":{"message":"…","type":"…","code":"…"}}`.
 */
function parseOpenRouterErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; type?: string } }
    return parsed?.error?.code ?? parsed?.error?.type ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Build a tagged HTTP error so the provider-neutral retry coordinator can
 * recover from a pre-stream rejection (429 rate limit, 5xx overload, 503
 * capacity shedding, …) instead of stopping the agent.
 *
 * The `streamErrorType` property is what `src/llm/run.ts` checks to decide
 * whether to retry. Without it, every non-2xx from OpenRouter is fatal.
 */
function taggedHttpError(
  label: string,
  status: number,
  body: string,
): Error & { streamErrorType?: string } {
  const upstreamCode = parseOpenRouterErrorCode(body)
  const { streamErrorType } = classifyUpstreamError({ httpStatus: status, upstreamCode })
  const err = new Error(`${label} ${status}: ${body}`) as Error & { streamErrorType?: string }
  if (streamErrorType) err.streamErrorType = streamErrorType
  return err
}

/** Register the OpenRouter adapter + catalog. Idempotent. */
export function bootstrapOpenRouter(): void {
  registerOpenRouterModels()
  registerProvider(openrouterAdapter)
}

/** Register a one-off OpenRouter slug that is not in the built-in catalog. */
export function registerOpenRouterAdHocModel(modelId: string): void {
  registerOpenRouterModel({ id: modelId })
}

/** This provider packaged for the {@link ProviderPlugin} registry. */
export const openrouterProviderPlugin: ProviderPlugin = {
  id: "openrouter",
  displayName: "OpenRouter",
  shortCode: "or",
  register: bootstrapOpenRouter,
  registerAdHocModel: registerOpenRouterAdHocModel,
  apiKeyAuth: openRouterApiKeyAuth,
  fetchSessionInfo: fetchOpenRouterSessionInfo,
}
