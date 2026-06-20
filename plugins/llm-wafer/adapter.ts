/**
 * Wafer `ProviderAdapter` — an OpenAI-compatible gateway.
 *
 * Wafer (pass.wafer.ai) is an OpenAI Chat Completions-compatible gateway
 * to many upstream models (GLM, Kimi, Qwen, DeepSeek, MiniMax), so this
 * adapter REUSES `plugins/llm-openai`'s wire layer wholesale
 * (`buildOpenAIChatBody`, `translateOpenAIChatStream`,
 * `buildOpenAIHeaders`, `validateOpenAIRequest`). Only the endpoint,
 * model catalog, auth strategy, and optional ZDR header differ.
 *
 * This is the same reuse pattern as `plugins/llm-openrouter` — one
 * provider adapts the shared OpenAI wire to its own gateway.
 *
 * Auth: a Bearer key from minimal-agent's provider auth store, passed via
 * `RunContext.auth = { kind: "api-key", key }`.
 *
 * @module llm/providers/wafer/adapter
 */

import { type CanonicalEvent, isEvent } from "@minimal-agent/plugin-api/llm/canonical-events"
import { classifyUpstreamError } from "@minimal-agent/plugin-api/llm/errors"
import type { RunContext } from "@minimal-agent/plugin-api/llm/provider-auth"
import type {
  ProviderPlugin,
  ProviderSetupContext,
} from "@minimal-agent/plugin-api/llm/provider-plugin"
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

import { waferApiKeyAuth } from "./auth.ts"
import { registerWaferModel, registerWaferModels } from "./models.ts"
import {
  accumulateWaferUsage,
  fetchWaferSessionInfo,
  primeWaferSessionInfo,
  setWaferRateLimits,
} from "./session-info.ts"
import { CHAT_COMPLETIONS_URL } from "./wire-constants.ts"

/** Wafer adapter. Speaks the OpenAI Chat surface against Wafer's host. */
export const waferAdapter: ProviderAdapter = {
  id: "wafer",
  displayName: "Wafer",
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
      throw new Error("Wafer adapter: missing api-key (run minimal-agent provider wafer login)")
    }

    const headers = buildOpenAIHeaders({ auth })
    // Optional Zero Data Retention header (model must support it).
    // Set Wafer-ZDR on every request when the model advertises zdr_supported.
    // The header is harmless when ZDR is unsupported.

    const body = buildOpenAIChatBody(req, model)
    ctx.debug?.header(`POST ${CHAT_COMPLETIONS_URL}`)
    ctx.debug?.kv("model", body.model)
    ctx.debug?.kv("provider", "wafer")
    ctx.debug?.headers(headers)
    ctx.debug?.body(body)

    const networkClient = (ctx.networkClient as NetworkClient | undefined) ?? defaultNetworkClient
    const response = await networkClient.request({
      label: "wafer.chat.completions",
      method: "POST",
      url: CHAT_COMPLETIONS_URL,
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw taggedHttpError("Wafer API", response.status, text)
    }
    // Capture rate-limit headers for the status-bar footer. Best-effort +
    // non-throwing; no behavior change to the stream below.
    setWaferRateLimits(response.headers)
    if (!response.body) {
      throw new Error("Wafer API: empty response body for stream")
    }
    // Accumulate usage from the stream's terminal message_delta event so the
    // footer displays per-session token totals and estimated cost.
    for await (const ev of translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))) {
      if (isEvent(ev, "message_delta")) {
        accumulateWaferUsage(ev.usage)
      }
      yield ev
    }
  },

  /**
   * Recommend Wafer models per abstract sub-agent role, from THIS
   * provider's own catalog by tag. scout → a `cheap` + `scout` model
   * (deepseek-v4-flash); balanced → a `balanced` model (GLM-5.1);
   * deep → a `flagship` + `deep` reasoning model (deepseek-v4-pro).
   */
  recommendSubagentModels(): SubagentModelRecommendation[] {
    const byTier: Array<{ role: string; tags: string[] }> = [
      { role: "scout", tags: ["cheap", "scout"] },
      { role: "balanced", tags: ["balanced"] },
      { role: "deep", tags: ["flagship", "deep"] },
    ]
    const recs: SubagentModelRecommendation[] = []
    for (const { role, tags } of byTier) {
      const model = findModelByTags("wafer", tags)
      if (model) recs.push({ role, modelId: model.id })
    }
    return recs
  },
}

// ---------------------------------------------------------------------------
// Error classification (mirrors the OpenAI adapter's taggedHttpError)
// ---------------------------------------------------------------------------

/**
 * Parse the Wafer error code out of a non-2xx JSON body. Wafer returns the
 * standard OpenAI error shape: `{"error":{"message":"…","type":"…","code":"…"}}`.
 */
function parseWaferErrorCode(body: string): string | undefined {
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
 * whether to retry. Without it, every non-2xx from Wafer is fatal.
 */
function taggedHttpError(
  label: string,
  status: number,
  body: string,
): Error & { streamErrorType?: string } {
  const upstreamCode = parseWaferErrorCode(body)
  const { streamErrorType } = classifyUpstreamError({ httpStatus: status, upstreamCode })
  const err = new Error(`${label} ${status}: ${body}`) as Error & { streamErrorType?: string }
  if (streamErrorType) err.streamErrorType = streamErrorType
  return err
}

/** Register the Wafer adapter + catalog. Idempotent. */
export function bootstrapWafer(ctx?: ProviderSetupContext): void {
  registerWaferModels(ctx?.models)
  registerProvider(waferAdapter)
}

/** Register a one-off Wafer model that is not in the built-in catalog. */
export function registerWaferAdHocModel(modelId: string): void {
  registerWaferModel({ id: modelId })
}

/** This provider packaged for the {@link ProviderPlugin} registry. */
export const waferProviderPlugin: ProviderPlugin = {
  id: "wafer",
  displayName: "Wafer",
  shortCode: "wf",
  register: bootstrapWafer,
  registerAdHocModel: registerWaferAdHocModel,
  apiKeyAuth: waferApiKeyAuth,
  fetchSessionInfo: fetchWaferSessionInfo,
  primeSessionInfo: primeWaferSessionInfo,
  /**
   * Version token for dense labels: extract the model family name
   * stripped of vendor prefixes and suffixes.
   *
   * - `GLM-5.1` → `5.1`
   * - `deepseek-v4-pro` → `v4-pro`
   * - `Qwen3.6-35B-A3B` → `3.6-35B`
   * - `Kimi-K2.7-Code` → `K2.7-Code`
   */
  modelVersionToken(modelId: string): string | undefined {
    // Wafer model IDs are flat strings like "GLM-5.1" or "deepseek-v4-pro".
    // Return them directly for label building.
    return modelId.replace(/^(GLM|Kimi|Qwen|qwen|deepseek|MiniMax)-?/, "")
  },
}
