/**
 * HuggingFace Inference Providers `ProviderAdapter`.
 *
 * HuggingFace is an OpenAI-compatible gateway to 15+ backend providers
 * (Cerebras, Groq, Together, DeepInfra, etc.). This adapter REUSES
 * `plugins/llm-openai`'s wire layer wholesale (`buildOpenAIChatBody`,
 * `translateOpenAIChatStream`, `buildOpenAIHeaders`, `validateOpenAIRequest`).
 * Only the endpoint, model catalog, auth strategy, and the provider-suffix
 * logic differ.
 *
 * Provider selection: HuggingFace supports appending `:<provider>` to the
 * model id on the wire (e.g. `"openai/gpt-oss-120b:groq"`). The default is
 * `:fastest` (auto-selects the fastest available backend). The adapter reads
 * `req.vendor?.huggingface?.provider` to override this; when absent, it
 * defaults to `"auto"` (which HuggingFace treats as `:fastest`).
 *
 * Auth: an API key passed via
 * `RunContext.auth = { kind: "api-key", key }`.
 *
 * @module llm/providers/huggingface/adapter
 */

import { type CanonicalEvent, isEvent } from "@minimal-agent/plugin-api/llm/canonical-events"
import { classifyUpstreamError } from "@minimal-agent/plugin-api/llm/errors"
import type { RunContext } from "@minimal-agent/plugin-api/llm/provider-auth"
import type {
  ProviderPlugin,
  ProviderSetupContext,
} from "@minimal-agent/plugin-api/llm/provider-plugin"
import type { NetworkClient } from "@minimal-agent/plugin-api/net/types"
import type { SubagentModelRecommendation } from "@minimal-agent/plugin-api/types/plugin"
import { parseSse } from "@minimal-agent/plugin-api/utils/sse-parser"

import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import { findModelByTags, type ModelEntry, registerProvider } from "../../src/llm/model-registry.ts"
import type { ProviderAdapter, SurfaceId, ValidationResult } from "../../src/llm/provider.ts"
import { defaultNetworkClient } from "../../src/network/index.ts"
import {
  buildOpenAIChatBody,
  buildOpenAIHeaders,
  type OpenAIChatChunk,
  translateOpenAIChatStream,
  validateOpenAIRequest,
} from "../llm-openai/index.ts"

import { huggingfaceApiKeyAuth } from "./auth.ts"
import { listHuggingFaceLiveModels } from "./live-models.ts"
import { registerHuggingFaceModel, registerHuggingFaceModels } from "./models.ts"
import {
  accumulateHuggingFaceUsage,
  fetchHuggingFaceSessionInfo,
  setHuggingFaceRateLimits,
} from "./session-info.ts"
import { CHAT_COMPLETIONS_URL, HUGGINGFACE_USER_AGENT } from "./wire-constants.ts"

/**
 * Resolve the wire model id with the provider suffix.
 *
 * HuggingFace model ids on the wire are `"org/model:provider"` where
 * `:provider` is optional and defaults to `:fastest` (auto-select).
 * The adapter reads `req.vendor?.huggingface?.provider` for the suffix;
 * when absent or `"auto"`, it omits the suffix (HuggingFace defaults to
 * fastest). A specific provider id or policy (`"groq"`, `"cerebras"`,
 * `"fastest"`, `"cheapest"`, `"preferred"`) is appended as `:<value>`.
 */
export function resolveWireModelId(req: CanonicalRequest, model: ModelEntry): string {
  const baseId = model.vendorIds?.firstParty ?? req.modelId
  const provider = req.vendor?.huggingface?.provider
  if (!provider || provider === "auto") return baseId
  return `${baseId}:${provider}`
}

/** HuggingFace adapter. Speaks the OpenAI Chat surface against HuggingFace's router. */
export const huggingfaceAdapter: ProviderAdapter = {
  id: "huggingface",
  displayName: "HuggingFace",
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
        "HuggingFace adapter: missing api-key (run minimal-agent provider huggingface login)",
      )
    }

    const headers = buildOpenAIHeaders({ auth })
    // Override the user-agent with the HuggingFace-specific one.
    headers["user-agent"] = HUGGINGFACE_USER_AGENT

    // Build the body with the provider-suffixed model id.
    const wireModelId = resolveWireModelId(req, model)
    const body = buildOpenAIChatBody(req, model)
    body.model = wireModelId

    const url = CHAT_COMPLETIONS_URL
    ctx.debug?.header(`POST ${url}`)
    ctx.debug?.kv("model", body.model)
    ctx.debug?.kv("surface", "chat")
    ctx.debug?.headers(headers)
    ctx.debug?.body(body)

    const networkClient = (ctx.networkClient as NetworkClient | undefined) ?? defaultNetworkClient

    const response = await networkClient.request({
      label: "huggingface.chat.completions",
      method: "POST",
      url,
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw taggedHttpError("HuggingFace API", response.status, text)
    }
    // Capture rate-limit headers for the status-bar footer. Best-effort +
    // non-throwing; no behavior change to the stream below.
    setHuggingFaceRateLimits(response.headers)
    if (!response.body) {
      throw new Error("HuggingFace API: empty response body for stream")
    }
    // Accumulate usage from the stream's terminal message_delta event so the
    // footer displays per-session token totals and estimated cost.
    for await (const ev of translateOpenAIChatStream(parseSse<OpenAIChatChunk>(response.body))) {
      if (isEvent(ev, "message_delta")) {
        accumulateHuggingFaceUsage(ev.usage)
      }
      yield ev
    }
  },

  /**
   * Recommend HuggingFace models per abstract sub-agent role, from THIS
   * provider's own (representative) catalog by tag. scout → a `cheap` model;
   * balanced → a `flagship` model. `deep` is intentionally left unmapped here
   * (the thin built-in catalog has no clear reasoning model), so the caller
   * falls back to the lead's own model for deep work.
   */
  recommendSubagentModels(): SubagentModelRecommendation[] {
    const recs: SubagentModelRecommendation[] = []
    const scout = findModelByTags("huggingface", ["cheap"])
    if (scout) recs.push({ role: "scout", modelId: scout.id })
    const balanced = findModelByTags("huggingface", ["flagship"])
    if (balanced && balanced.id !== scout?.id) recs.push({ role: "balanced", modelId: balanced.id })
    return recs
  },
}

/**
 * Parse the HuggingFace error code out of a non-2xx JSON body. HuggingFace
 * returns the standard OpenAI error shape:
 * `{"error":{"message":"…","type":"…","code":"…"}}`.
 */
function parseHuggingFaceErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: string; type?: string } }
    return parsed?.error?.code ?? parsed?.error?.type ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Build a tagged HTTP error so the provider-neutral retry coordinator can
 * recover from a pre-stream rejection (429 rate limit, 5xx overload, …)
 * instead of stopping the agent.
 */
function taggedHttpError(
  label: string,
  status: number,
  body: string,
): Error & { streamErrorType?: string } {
  const upstreamCode = parseHuggingFaceErrorCode(body)
  const { streamErrorType } = classifyUpstreamError({ httpStatus: status, upstreamCode })
  const err = new Error(`${label} ${status}: ${body}`) as Error & { streamErrorType?: string }
  if (streamErrorType) err.streamErrorType = streamErrorType
  return err
}

/** Register the HuggingFace adapter + catalog. Idempotent. */
export function bootstrapHuggingFace(ctx?: ProviderSetupContext): void {
  registerHuggingFaceModels(ctx?.models)
  registerProvider(huggingfaceAdapter)
}

/** Register a one-off HuggingFace slug that is not in the built-in catalog. */
export function registerHuggingFaceAdHocModel(modelId: string): void {
  registerHuggingFaceModel({ id: modelId })
}

/** This provider packaged for the {@link ProviderPlugin} registry. */
export const huggingfaceProviderPlugin: ProviderPlugin = {
  id: "huggingface",
  displayName: "HuggingFace",
  shortCode: "hf",
  register: bootstrapHuggingFace,
  registerAdHocModel: registerHuggingFaceAdHocModel,
  apiKeyAuth: huggingfaceApiKeyAuth,
  fetchSessionInfo: fetchHuggingFaceSessionInfo,
  listLiveModels: listHuggingFaceLiveModels,
  // HuggingFace's /v1/models is public, so the live catalog lists before login.
  publicModelList: true,
}
