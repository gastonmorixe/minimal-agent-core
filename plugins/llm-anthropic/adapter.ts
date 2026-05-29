/**
 * Anthropic `ProviderAdapter` implementation.
 *
 * Wires the building blocks (headers, request body, validation, SSE
 * translator) into the canonical `ProviderAdapter` shape. Dispatches
 * via the network client provided in `RunContext` (defaulting to the
 * package's `defaultNetworkClient` when none supplied).
 *
 * Retry / 401-refresh / stream-watchdog are intentionally NOT here :
 * those are provider-neutral and live one layer up. This adapter
 * focuses on the wire format.
 *
 * @module llm/providers/anthropic/adapter
 */

import { defaultNetworkClient, type NetworkClient } from "../../src/network/index.ts"
import type { CanonicalEvent } from "../../src/llm/canonical-events.ts"
import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import { type ModelEntry, registerProvider } from "../../src/llm/model-registry.ts"
import {
  type ProviderAdapter,
  type ProviderAuth,
  type RunContext,
  type SurfaceId,
  type ValidationResult,
} from "../../src/llm/provider.ts"
import type { ProviderPlugin, ProviderStartupContext } from "../../src/llm/provider-plugin.ts"
import { parseSse } from "../../src/llm/streaming/sse-parser.ts"

import { applyBootstrapOverrides, fetchBootstrap } from "./bootstrap.ts"
import { buildAnthropicHeaders } from "./headers.ts"
import { registerAnthropicModels } from "./models.ts"
import { buildAnthropicRequestBody } from "./request-body.ts"
import { type AnthropicStreamEvent, translateAnthropicStream } from "./response-stream.ts"
import { validateAnthropicRequest } from "./validate.ts"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MESSAGES_URL = "https://api.anthropic.com/v1/messages?beta=true"

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Anthropic Messages adapter. Singleton; register once at module
 * load.
 */
export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  displayName: "Anthropic",
  surfaces: ["anthropic-messages"] satisfies ReadonlyArray<SurfaceId>,

  validate(req, model): ValidationResult {
    return validateAnthropicRequest(req, model)
  },

  async *run(
    req: CanonicalRequest,
    model: ModelEntry,
    ctx: RunContext,
  ): AsyncIterable<CanonicalEvent> {
    const auth = ctx.auth
    if (auth.kind === "api-key" && auth.organization === undefined && !auth.key) {
      throw new Error("Anthropic adapter: missing api-key")
    }
    if (auth.kind === "oauth" && !auth.token) {
      throw new Error("Anthropic adapter: missing oauth token")
    }

    const { headers, betaFlags } = buildAnthropicHeaders({
      req,
      model,
      auth,
      sessionId: ctx.sessionId,
    })
    const body = buildAnthropicRequestBody(req, model)
    const serialized = JSON.stringify(body)

    ctx.debug?.header(`POST ${MESSAGES_URL}`)
    ctx.debug?.kv("model", body.model)
    ctx.debug?.kv("stream", String(body.stream ?? true))
    ctx.debug?.kv("max_tokens", String(body.max_tokens))
    ctx.debug?.kv("beta", betaFlags.join(","))
    ctx.debug?.headers(headers)
    ctx.debug?.body(body)

    const networkClient = (ctx.networkClient as NetworkClient | undefined) ?? defaultNetworkClient
    const response = await networkClient.request({
      label: "messages.send",
      method: "POST",
      url: MESSAGES_URL,
      headers,
      body: serialized,
      signal: req.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Anthropic API ${response.status}: ${text}`)
    }
    if (!response.body) {
      throw new Error("Anthropic API: empty response body for stream")
    }

    yield* translateAnthropicStream(parseSse<AnthropicStreamEvent>(response.body))
  },
}

/**
 * Register the Anthropic adapter + its model catalog into the global
 * registry. Idempotent. Call once at application start (typically
 * from `src/index.ts` or test setup).
 */
export function bootstrapAnthropic(): void {
  registerAnthropicModels()
  registerProvider(anthropicAdapter)
}

/** This provider packaged for the {@link ProviderPlugin} registry. */
export const anthropicProviderPlugin: ProviderPlugin = {
  id: "anthropic",
  displayName: "Anthropic",
  shortCode: "anth",
  register: bootstrapAnthropic,
  /**
   * Fire-and-forget `/api/claude_cli/bootstrap` probe (v2.1.154+). Overlays
   * any server-shipped `additional_model_costs` onto the registry so
   * Anthropic can ship a new model id without a CLI release. Self-gates:
   * `fetchBootstrap` returns null for non-OAuth auth, and
   * `applyBootstrapOverrides` no-ops on null. Failures are swallowed; local
   * pricing tables stay authoritative. Relocated here from `src/index.ts`
   * so the entrypoint names no provider.
   */
  onStartupProbe(ctx: ProviderStartupContext): void {
    void (async () => {
      const registry = await import("../../src/llm/model-registry.ts")
      const resp = await fetchBootstrap({ auth: ctx.auth, modelId: ctx.modelId })
      applyBootstrapOverrides(resp, registry)
    })().catch(() => {
      // Tolerated: bootstrap is a UX improvement, not a correctness
      // requirement. Local pricing tables remain authoritative.
    })
  },
}

export type { ProviderAuth }
