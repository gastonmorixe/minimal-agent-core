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
  ProviderStartupContext,
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
import { fetchHuggingFaceModelCapabilities, listHuggingFaceLiveModels } from "./live-models.ts"
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

    // HuggingFace's router HARD-REJECTS the `tools` param (HTTP 400 /
    // UNSUPPORTED_OPENAI_PARAMS) for models whose backends don't support tool
    // calling (e.g. meta-llama/Llama-3.1-8B-Instruct), rather than ignoring it
    // the way it ignores an unsupported `reasoning_effort`. When the resolved
    // model's capabilities say tools are unsupported, strip them so a plain
    // chat still succeeds instead of 400-ing before generation.
    if (!model.capabilities.tools.userDefined) {
      body.tools = undefined
      body.tool_choice = undefined
    }

    const url = CHAT_COMPLETIONS_URL
    ctx.debug?.header(`POST ${url}`)
    ctx.debug?.kv("model", body.model)
    ctx.debug?.kv("surface", "chat")
    ctx.debug?.headers(headers)
    ctx.debug?.body(body)

    const networkClient = (ctx.networkClient as NetworkClient | undefined) ?? defaultNetworkClient

    const send = (payload: object) =>
      networkClient.request({
        label: "huggingface.chat.completions",
        method: "POST",
        url,
        headers,
        body: JSON.stringify(payload),
        signal: req.signal,
      })

    let response = await send(body)

    // HuggingFace's router HARD-REJECTS `tools` (pre-stream 400 /
    // UNSUPPORTED_OPENAI_PARAMS) for models whose backends don't support tool
    // calling, instead of ignoring it. The startup probe narrows caps for the
    // selected model, but a one-shot request can race ahead of it, so recover
    // here: on that specific rejection, strip tools + tool_choice and retry
    // ONCE so a plain chat still succeeds. Any other error propagates.
    if (!response.ok && (body.tools !== undefined || body.tool_choice !== undefined)) {
      const text = await response.text()
      if (isToolsUnsupportedError(response.status, text)) {
        body.tools = undefined
        body.tool_choice = undefined
        response = await send(body)
      } else {
        throw taggedHttpError("HuggingFace API", response.status, text)
      }
    }

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
 * Detect HuggingFace's "this model doesn't support the `tools` param" rejection
 * so the adapter can retry once without tools. HF returns HTTP 400 wrapping an
 * inner 422 `UNSUPPORTED_OPENAI_PARAMS` whose message names `tools` (some
 * backends instead return 405 "Tool calling is not supported"). Matches on the
 * body text so both shapes are caught.
 */
export function isToolsUnsupportedError(status: number, body: string): boolean {
  if (status !== 400 && status !== 405 && status !== 422) return false
  const lower = body.toLowerCase()
  if (!lower.includes("tool")) return false
  return (
    lower.includes("unsupported_openai_params") ||
    lower.includes("not supported") ||
    lower.includes("not support") ||
    lower.includes("does not support")
  )
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

/**
 * Startup probe: overlay EXACT per-model capabilities onto the registry for the
 * selected model, fetched from the live `/v1/models` catalog. This is what
 * makes tool-less models (e.g. meta-llama/Llama-3.1-8B-Instruct, which HF's
 * router 422-rejects the `tools` param for) correctly advertise
 * `tools.userDefined:false` so the agent never sends tool defs it can't honor,
 * and narrows context window / structured outputs / image modality to reality.
 * Best-effort + non-throwing: a fetch failure leaves the permissive default in
 * place. Fire-and-forget (the host does not await), so it self-gates on the
 * promise internally.
 */
export function probeHuggingFaceModel(ctx: ProviderStartupContext): void {
  const baseId = ctx.modelId.includes(":")
    ? ctx.modelId.slice(0, ctx.modelId.indexOf(":"))
    : ctx.modelId
  void fetchHuggingFaceModelCapabilities(ctx.auth, baseId)
    .then((caps) => {
      if (caps) registerHuggingFaceModel({ id: baseId, capabilities: caps })
    })
    .catch(() => {
      // best-effort; permissive default stays in place
    })
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
  // Overlay exact per-model caps (esp. tools on/off) for the selected model.
  onStartupProbe: probeHuggingFaceModel,
}
