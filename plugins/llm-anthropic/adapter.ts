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

import { listModels } from "../../src/client/list-models.ts"
import type { CanonicalEvent } from "../../src/llm/canonical-events.ts"
import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import { findModelByTags, type ModelEntry, registerProvider } from "../../src/llm/model-registry.ts"
import {
  type PreflightIssue,
  type PreflightResolution,
  type ProviderAdapter,
  type ProviderAuth,
  type RunContext,
  type SurfaceId,
  type ValidationResult,
} from "../../src/llm/provider.ts"
import type { ProviderPlugin, ProviderStartupContext } from "../../src/llm/provider-plugin.ts"
import { parseSse } from "../../src/llm/streaming/sse-parser.ts"
import { defaultNetworkClient, type NetworkClient } from "../../src/network/index.ts"
import type { SubagentModelRecommendation } from "../../src/plugins/types.ts"

import { applyBootstrapOverrides, fetchBootstrap } from "./bootstrap.ts"
import { buildAnthropicHeaders } from "./headers.ts"
import { anthropicMediaLimits } from "./media-limits.ts"
import { registerAnthropicModels } from "./models.ts"
import { buildAnthropicRequestBody } from "./request-body.ts"
import { type AnthropicStreamEvent, translateAnthropicStream } from "./response-stream.ts"
import { fetchAnthropicSessionInfo, primeAnthropicSessionInfo } from "./session-info.ts"
import { resolveAnthropicSystemPrompt } from "./system-prompt.ts"
import {
  applyMismatchResolution,
  buildMismatchIssue,
  findThinkingMismatches,
  ISSUE_THINKING_MODEL_MISMATCH,
} from "./thinking-preflight.ts"
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

  /**
   * Anthropic media walls (32 MB request, 5 MB/item, format set, item
   * count by context tier). This hook is how CORE learns the limits —
   * core's fallback is the neutral conservative floor in
   * `src/media/default-limits.ts`, never an Anthropic import.
   */
  mediaLimits(model: ModelEntry) {
    return anthropicMediaLimits({ contextWindow: model.capabilities.contextWindow })
  },

  /**
   * Preflight: detect thinking-block signatures that were produced by a
   * different model than the request's `modelId`. Returns one issue
   * when any such mismatch is found (so the agent only opens one modal
   * per send even if the conversation has many stale blocks). Returns
   * `[]` when the request is clean.
   *
   * Why this is the only issue today: model-signed thinking is the
   * single class of validation error we can fix BEFORE the round-trip.
   * Everything else (overload, rate limit, auth) needs server feedback.
   */
  preflight(req: CanonicalRequest, _model: ModelEntry): PreflightIssue[] {
    const mismatches = findThinkingMismatches(req.messages, req.modelId)
    if (mismatches.length === 0) return []
    return [buildMismatchIssue(mismatches, req.modelId)]
  },

  /**
   * Apply the user's resolution to a {@link ISSUE_THINKING_MODEL_MISMATCH}
   * issue. Delegates to the pure `applyMismatchResolution` helper and
   * translates its outcome into the canonical {@link PreflightResolution}
   * shape.
   */
  applyResolution(req: CanonicalRequest, issueCode: string, optionId: string): PreflightResolution {
    if (issueCode !== ISSUE_THINKING_MODEL_MISMATCH) {
      throw new Error(
        `anthropicAdapter.applyResolution: unknown issue code "${issueCode}" (expected "${ISSUE_THINKING_MODEL_MISMATCH}")`,
      )
    }
    const outcome = applyMismatchResolution(req, optionId)
    if (outcome.kind === "cancel") return { kind: "cancel" }
    if (outcome.kind === "unknown-option") {
      throw new Error(
        `anthropicAdapter.applyResolution: unknown option id "${outcome.optionId}" for ${issueCode}`,
      )
    }
    return {
      kind: "modify-request",
      request: { ...req, messages: outcome.messages },
      ...(outcome.adoptModelId !== undefined ? { adoptModelId: outcome.adoptModelId } : {}),
    }
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

  /**
   * Recommend Anthropic models for each abstract sub-agent role, picked from
   * THIS provider's own registered catalog by tier tag (never a hardcoded SKU,
   * so a model rename can't strand it). scout → Haiku, balanced → Sonnet,
   * deep → Opus, each restricted to a `production` model. A role with no
   * matching production model is omitted (the caller falls back to the lead's
   * model). Anthropic's models use adaptive thinking, so we leave `thinking`
   * unset and let effort default per the model.
   */
  recommendSubagentModels(): SubagentModelRecommendation[] {
    const byTier: Array<{ role: string; tag: string }> = [
      { role: "scout", tag: "haiku" },
      { role: "balanced", tag: "sonnet" },
      { role: "deep", tag: "opus" },
    ]
    const recs: SubagentModelRecommendation[] = []
    for (const { role, tag } of byTier) {
      const model = findModelByTags("anthropic", [tag, "production"])
      if (model) recs.push({ role, modelId: model.id })
    }
    return recs
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
   * Plan-auth (OAuth) requests get the mandatory billing + Claude-Code
   * identity preamble the Anthropic server validates; api-key/custom auth
   * keeps the agent's neutral identity. See `./system-prompt.ts`.
   */
  resolveSystemPrompt: resolveAnthropicSystemPrompt,
  /**
   * Version token for dense labels: "claude-<family>-<maj>[-min]…" →
   * "maj.min" / "maj" (fable has no minor digit). Returns undefined for
   * ids outside this scheme so core's generic fallback applies.
   */
  modelVersionToken(modelId: string): string | undefined {
    const m = modelId.match(/^claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:-(\d+))?/)
    if (!m) return undefined
    return m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1]
  },
  /**
   * Live catalog via GET /v1/models?beta=true (incl. the synthesized
   * `[1m]` context-window variants). Implements the neutral
   * `ProviderPlugin.listLiveModels` hook so `--list-models`/the picker
   * never import Anthropic code. Auth kinds map 1:1 onto the legacy
   * AuthResult shape this plugin's HTTP layer still speaks.
   */
  async listLiveModels(auth) {
    // Custom-header auth has no single credential to forward to the legacy
    // HTTP layer; report "no live list" and let the registry fallback serve.
    if (auth.kind === "custom") return []
    const legacyAuth =
      auth.kind === "oauth"
        ? ({ type: "oauth", token: auth.token } as const)
        : ({ type: "api-key", token: auth.key } as const)
    const models = await listModels(legacyAuth)
    return models.map((m) => ({
      id: m.id,
      displayName: m.display_name,
      createdAt: m.created_at?.slice(0, 10),
    }))
  },
  /**
   * Provider-neutral session metadata (5h/7d quota windows, context window,
   * model label) for the status bar. **Cache-only** — non-blocking. The
   * cold-start probe lives in {@link primeSessionInfo}. See `./session-info.ts`.
   */
  fetchSessionInfo: fetchAnthropicSessionInfo,
  /**
   * Cold-start quota cache warmup, issued fire-and-forget by the agent boot.
   * A bounded 1-token Haiku POST whose response headers populate the cache
   * AND emit `quota.headersReceived`, so the status-bar slot's first tick
   * (which is cache-only) finds fresh data without ever blocking on the
   * network. Self-deduplicating. See `./session-info.ts`.
   */
  primeSessionInfo: primeAnthropicSessionInfo,
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
