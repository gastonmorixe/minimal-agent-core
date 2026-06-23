/**
 * Ollama Cloud `ProviderAdapter` — a fully self-contained provider plugin.
 *
 * Ollama Cloud (ollama.com) serves frontier open-weight models over its NATIVE
 * `/api/chat` protocol (newline-delimited JSON streaming, its own message and
 * tool shapes). This adapter owns its whole wire layer — request body, NDJSON
 * stream translation, headers — and imports NOTHING from `src/` or sibling
 * plugins. Everything it needs from the host crosses through the shared
 * contexts the agent loop hands it:
 *
 * - models + adapter registration: the {@link ProviderSetupContext} passed to
 *   `register(ctx)` (`ctx.models`, `ctx.providers`).
 * - the network client: `RunContext.networkClient` (the host's shared transport).
 * - auth: `RunContext.auth` (a Bearer API key from the provider auth store).
 *
 * This is the decoupled provider pattern: the older provider plugins reach into
 * `src/` for the registry, canonical types, and network singleton; this one
 * uses only `@minimal-agent/plugin-api` plus the agent-loop context.
 *
 * @module llm/providers/ollama/adapter
 */

import type { CanonicalEvent } from "@minimal-agent/plugin-api/llm/canonical-events"
import { isEvent } from "@minimal-agent/plugin-api/llm/canonical-events"
import type { CanonicalRequest } from "@minimal-agent/plugin-api/llm/canonical-request"
import { classifyUpstreamError } from "@minimal-agent/plugin-api/llm/errors"
import type { ProviderAuth, RunContext } from "@minimal-agent/plugin-api/llm/provider-auth"
import type {
  ProviderAdapterView,
  ProviderPlugin,
  ProviderSetupContext,
  ProviderValidationResult,
} from "@minimal-agent/plugin-api/llm/provider-plugin"
import type { NetworkClient } from "@minimal-agent/plugin-api/net/types"
import type { ModelView } from "@minimal-agent/plugin-api/types/host-capabilities"
import type { SubagentModelRecommendation } from "@minimal-agent/plugin-api/types/plugin"

import { ollamaApiKeyAuth } from "./auth.ts"
import { listOllamaLiveModels } from "./live-models.ts"
import { registerOllamaAdHocModelInto, registerOllamaModels } from "./models.ts"
import { buildOllamaChatBody } from "./request-body.ts"
import { type OllamaChatChunk, parseNdjson, translateOllamaStream } from "./response-stream.ts"
import { accumulateOllamaUsage, fetchOllamaSessionInfo } from "./session-info.ts"
import { validateOllamaRequest } from "./validate.ts"

/** Direct ollama.com cloud chat endpoint (the remote-host mode of `/api/chat`). */
const OLLAMA_CHAT_URL = "https://ollama.com/api/chat"

/** Build the auth + content headers for an Ollama Cloud chat request. */
function buildOllamaHeaders(auth: ProviderAuth): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/x-ndjson",
    "content-type": "application/json",
    "user-agent": "minimal-agent-ollama/0.1",
  }
  switch (auth.kind) {
    case "api-key":
      headers.authorization = `Bearer ${auth.key}`
      break
    case "oauth":
      headers.authorization = `Bearer ${auth.token}`
      if (auth.headers) Object.assign(headers, auth.headers)
      break
    case "custom":
      Object.assign(headers, auth.headers)
      break
  }
  return headers
}

/**
 * Parse an Ollama error code out of a non-2xx JSON body. Ollama returns
 * `{"error":"..."}` (a plain string), occasionally with a status-shaped prefix.
 */
function parseOllamaErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: string }
    return typeof parsed?.error === "string" ? parsed.error : undefined
  } catch {
    return undefined
  }
}

/**
 * Build a tagged HTTP error so the provider-neutral retry coordinator can
 * recover from a pre-stream rejection (429 / 5xx / 503). The `streamErrorType`
 * property is what the host's `run()` retry loop checks.
 */
function taggedHttpError(status: number, body: string): Error & { streamErrorType?: string } {
  const upstreamCode = parseOllamaErrorCode(body)
  const { streamErrorType } = classifyUpstreamError({ httpStatus: status, upstreamCode })
  const err = new Error(`Ollama Cloud API ${status}: ${body}`) as Error & {
    streamErrorType?: string
  }
  if (streamErrorType) err.streamErrorType = streamErrorType
  return err
}

/** Ollama Cloud adapter. Speaks Ollama's native chat surface. */
export const ollamaAdapter: ProviderAdapterView = {
  id: "ollama",
  displayName: "Ollama Cloud",
  surfaces: ["custom"],

  validate(req: CanonicalRequest, model: ModelView): ProviderValidationResult {
    return validateOllamaRequest(req, model)
  },

  async *run(
    req: CanonicalRequest,
    model: ModelView,
    ctx: RunContext,
  ): AsyncIterable<CanonicalEvent> {
    const auth = ctx.auth
    if (auth.kind === "api-key" && !auth.key) {
      throw new Error(
        "Ollama Cloud adapter: missing api-key (run `minimal-agent provider ollama login` or set OLLAMA_API_KEY)",
      )
    }

    const headers = buildOllamaHeaders(auth)
    const body = buildOllamaChatBody(req, model)
    ctx.debug?.header(`POST ${OLLAMA_CHAT_URL}`)
    ctx.debug?.kv("model", body.model)
    ctx.debug?.headers(headers)
    ctx.debug?.body(body)

    const networkClient = ctx.networkClient as NetworkClient | undefined
    if (!networkClient) {
      throw new Error("Ollama Cloud adapter: no network client on RunContext")
    }

    const response = await networkClient.request({
      label: "ollama.chat",
      method: "POST",
      url: OLLAMA_CHAT_URL,
      headers,
      body: JSON.stringify(body),
      signal: req.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw taggedHttpError(response.status, text)
    }
    if (!response.body) {
      throw new Error("Ollama Cloud API: empty response body for stream")
    }

    // Accumulate usage from the terminal message_delta so the footer can show
    // per-session token totals.
    for await (const ev of translateOllamaStream(parseNdjson<OllamaChatChunk>(response.body))) {
      if (isEvent(ev, "message_delta")) {
        accumulateOllamaUsage({
          inputTokens: ev.usage.inputTokens,
          outputTokens: ev.usage.outputTokens,
        })
      }
      yield ev
    }
  },

  /**
   * Recommend Ollama Cloud models per abstract sub-agent role from THIS
   * provider's own catalog by tag. scout → a `cheap` model; balanced → a
   * non-cheap tools model. `deep` is left unmapped (the caller falls back to
   * the lead's own model for deep work).
   */
  recommendSubagentModels(): SubagentModelRecommendation[] {
    const recs: SubagentModelRecommendation[] = []
    if (catalogScoutId) recs.push({ role: "scout", modelId: catalogScoutId })
    if (catalogBalancedId && catalogBalancedId !== catalogScoutId) {
      recs.push({ role: "balanced", modelId: catalogBalancedId })
    }
    return recs
  },
}

// Role picks captured at registration so `recommendSubagentModels` needs no
// registry read (it would require a `models:read` capability the setup ctx
// doesn't carry). Set in `bootstrapOllama`.
let catalogScoutId: string | undefined
let catalogBalancedId: string | undefined

// The setup-context model registrar, captured at registration so the host's
// `registerAdHocModel(modelId)` hook (called WITHOUT a ctx) can still register
// a live-only cloud slug the static catalog doesn't know yet.
let capturedModels: ProviderSetupContext["models"] | undefined

/**
 * Register the Ollama Cloud catalog + adapter through the setup context. This
 * is the decoupled registration path: a plugin reaches host state ONLY through
 * `ctx.models` / `ctx.providers`. When the host calls `register()` with no
 * context (the legacy no-arg activation path), this no-ops — the live provider
 * loader always passes a context (`activateDiscoveredProviders`).
 */
export function bootstrapOllama(ctx?: ProviderSetupContext): void {
  if (!ctx?.models || !ctx.providers) return
  capturedModels = ctx.models
  const ids = registerOllamaModels(ctx.models)
  // Capture role picks for recommendSubagentModels: the two `cheap`-tagged
  // small models are scouts; the first 1M-context flagship is balanced.
  catalogScoutId = ids.find((id) => id === "gpt-oss:20b") ?? ids.find((id) => id.includes("flash"))
  catalogBalancedId = ids.find((id) => id === "deepseek-v4-flash") ?? ids[0]
  ctx.providers.register(ollamaAdapter)
}

/**
 * Register a one-off Ollama Cloud slug the static catalog doesn't know (e.g. a
 * brand-new cloud model surfaced by the live `/api/tags` list). Uses the
 * registrar captured at `bootstrapOllama` time, so selecting the new slug with
 * `--provider ollama` works even before it lands in the built-in catalog.
 * No-ops if registration hasn't happened yet (the registrar isn't captured).
 */
export function registerOllamaAdHocModel(modelId: string): void {
  if (!capturedModels) return
  registerOllamaAdHocModelInto(capturedModels, modelId)
}

/** This provider packaged for the {@link ProviderPlugin} registry. */
export const ollamaProviderPlugin: ProviderPlugin = {
  id: "ollama",
  displayName: "Ollama Cloud",
  shortCode: "ol",
  register: bootstrapOllama,
  registerAdHocModel: registerOllamaAdHocModel,
  listLiveModels: listOllamaLiveModels,
  apiKeyAuth: ollamaApiKeyAuth,
  fetchSessionInfo: fetchOllamaSessionInfo,
}
