/**
 * Canonical → Anthropic Messages request contract: body building
 * ({@link buildAnthropicRequestBody}), request classification
 * ({@link classifyRequest}), and capability validation
 * ({@link validateAnthropicRequest}).
 *
 * The request-side companion to the `llm/anthropic-stream` module (the SSE
 * translator). Split into its own leaf module so each stays within the
 * per-file line budget; together they are the full canonical↔Anthropic-Messages
 * WIRE CONTRACT that every Anthropic-compatible gateway (opencode, plus the
 * anthropic adapter itself) shares.
 *
 * Provider-neutral: `classifyRequest` reads only `CanonicalRequest` fields (no
 * registry/state), and `context_management` is Anthropic WIRE FORMAT, not host
 * state. The registry-coupled `buildBetaFlags` / `beta-gates` stay in the
 * anthropic plugin — they are NOT part of this contract. No parametrization is
 * needed; the wire contract carries no anthropic-only host constant. The moved
 * functions take the leaf {@link ModelView} and return the leaf
 * {@link ProviderValidationResult}, so there is zero `src/` dependency.
 *
 * Wave G relocated this here from `plugins/llm-anthropic/{request-body,validate}.ts`
 * (which now re-export it) so a gateway vendors ONE shared contract.
 *
 * @module llm/anthropic-request
 */

import type { CanonicalBlock, CanonicalMessage } from "./canonical-messages.ts"
import type { CanonicalToolDefinition } from "./canonical-tools.ts"
import type { CanonicalRequest, ThinkingConfig } from "./canonical-request.ts"
import { CapabilityViolation } from "./errors.ts"
import { modalityViolations, stripUnsupportedModalities } from "./modality-check.ts"
import type { ProviderValidationResult } from "./provider-plugin.ts"
import type { ModelView } from "../types/host-capabilities.ts"

// ---------------------------------------------------------------------------
// Wire shapes (Anthropic-side, kept opaque to the rest of the codebase)
// ---------------------------------------------------------------------------

export interface AnthropicSystemBlock {
  type: "text"
  text: string
  cache_control?: {
    type: "ephemeral"
    ttl?: "5m" | "1h"
    scope?: "global"
  }
}

export interface AnthropicMessage {
  role: "user" | "assistant" | "system"
  content: string | AnthropicContentBlock[]
}

export type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: AnthropicCacheControl }
  | {
      type: "thinking"
      thinking: string
      signature?: string
      cache_control?: AnthropicCacheControl
    }
  | { type: "redacted_thinking"; data: string; cache_control?: AnthropicCacheControl }
  | {
      type: "tool_use"
      id: string
      name: string
      input: unknown
      cache_control?: AnthropicCacheControl
    }
  | {
      type: "tool_result"
      tool_use_id: string
      is_error?: boolean
      content: string | AnthropicContentBlock[]
      cache_control?: AnthropicCacheControl
    }
  | { type: "image"; source: AnthropicImageSource; cache_control?: AnthropicCacheControl }

export interface AnthropicCacheControl {
  type: "ephemeral"
  ttl?: "5m" | "1h"
  scope?: "global"
}

export type AnthropicImageSource =
  | { type: "url"; url: string }
  | { type: "base64"; media_type: string; data: string }

export interface AnthropicToolDef {
  name: string
  description: string
  input_schema: object
}

export interface AnthropicRequestBody {
  model: string
  messages: AnthropicMessage[]
  system?: AnthropicSystemBlock[]
  tools?: AnthropicToolDef[]
  tool_choice?: { type: "auto" | "any" | "none" | "tool"; name?: string }
  metadata?: { user_id?: string }
  max_tokens: number
  thinking?: { type: "adaptive" | "enabled" | "disabled"; budget_tokens?: number; display?: string }
  temperature?: number | null
  top_p?: number | null
  top_k?: number | null
  context_management?: { edits: Array<{ type: string; keep?: string }> }
  output_config?: {
    effort?: string
    format?: { type: string; schema?: object; name?: string; strict?: boolean }
    task_budget?: { type: string; total: number }
  }
  stream?: boolean
  speed?: "normal" | "fast"
  /** Capacity lane. Anthropic accepts `auto | standard_only`. */
  service_tier?: "auto" | "standard_only"
  diagnostics?: { previous_message_id: string | null }
}

/**
 * Service tiers Anthropic's Messages API accepts on the request. The neutral
 * `req.serviceTier` (opaque string) is validated against this set; an
 * unrecognized value is dropped (not sent), so a value meant for another
 * provider (e.g. OpenAI's `priority`/`flex`) can't 400 here. `auto`
 * opportunistically uses priority capacity when available; `standard_only`
 * pins standard. NOTE: distinct from `speed`, the separate fast-dispatch flag.
 */
const ANTHROPIC_SERVICE_TIERS = new Set(["auto", "standard_only"])

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Translate a `CanonicalRequest` into the Anthropic `/v1/messages`
 * POST body. Caller passes the resolved `ModelView` so model id and
 * capabilities are accessible (e.g. for `max_tokens` clamping).
 */
export function buildAnthropicRequestBody(
  req: CanonicalRequest,
  model: ModelView,
): AnthropicRequestBody {
  const kind = classifyRequest(req)
  const body: AnthropicRequestBody = {
    model: stripContextAlias(req.modelId),
    messages: req.messages.map(toAnthropicMessage),
    max_tokens: clampMaxTokens(req.generation?.maxOutputTokens, model),
  }

  if (req.system && req.system.length > 0) {
    body.system = req.system.map(toAnthropicSystemBlock)
  }

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map(toAnthropicToolDef)
  }
  if (req.toolChoice) body.tool_choice = toAnthropicToolChoice(req.toolChoice)

  // Metadata: claude-code packs {device_id, account_uuid, session_id} into
  // a single JSON string under `user_id`. Mirror that shape.
  const meta = buildMetadata(req)
  if (meta) body.metadata = meta

  // Thinking — only when capability supports it AND request opted in.
  const thinking = mapThinking(req.thinking, model)
  if (thinking) body.thinking = thinking

  // Sampling
  applySampling(body, req, model)

  // Context management: default for conversations on models that support it.
  if (req.vendor?.anthropic?.contextManagement === null) {
    // explicit opt-out
  } else if (req.vendor?.anthropic?.contextManagement) {
    body.context_management = req.vendor.anthropic.contextManagement
  } else if (
    (kind === "conversation" || kind === "subtask") &&
    model.capabilities.thinking.adaptive
  ) {
    body.context_management = {
      edits: [{ type: "clear_thinking_20251015", keep: "all" }],
    }
  }

  // output_config — effort / format / task_budget. effort respects the
  // model's default when caller omits AND the model has any effort levels.
  const outputConfig = buildOutputConfig(req, model)
  if (outputConfig) body.output_config = outputConfig

  // stream defaults to true.
  body.stream = req.stream ?? true

  // speed: only emit "fast"; "normal" is the omit-default.
  if (req.speed === "fast" && model.capabilities.speedFast) body.speed = "fast"

  // Provider-neutral service tier -> Anthropic `service_tier`. Validate
  // against the accepted set; drop (don't send) anything else, so a value
  // intended for a different provider can't 400 here.
  if (req.serviceTier !== undefined && ANTHROPIC_SERVICE_TIERS.has(req.serviceTier)) {
    body.service_tier = req.serviceTier as NonNullable<AnthropicRequestBody["service_tier"]>
  }

  // diagnostics block (cache-diagnosis beta).
  if (req.vendor?.anthropic?.cacheDiagnostics) {
    body.diagnostics = { previous_message_id: null }
  }

  return body
}

// ---------------------------------------------------------------------------
// Translation helpers
// ---------------------------------------------------------------------------

function stripContextAlias(id: string): string {
  return id.replace(/\[(1|2)m\]/gi, "")
}

function clampMaxTokens(requested: number | undefined, model: ModelView): number {
  const cap = model.capabilities.maxOutputTokens
  if (requested === undefined) return Math.min(64_000, cap)
  return Math.min(Math.max(1, requested), cap)
}

function toAnthropicSystemBlock(block: CanonicalBlock): AnthropicSystemBlock {
  if (block.type !== "text") {
    // Anthropic system[] only accepts text blocks. Other types are silently
    // dropped here; validate() would surface the issue first.
    return { type: "text", text: "" }
  }
  const out: AnthropicSystemBlock = { type: "text", text: block.text }
  if (block.cache) {
    out.cache_control = { type: "ephemeral", ttl: block.cache.ttl, scope: block.cache.scope }
  }
  return out
}

function toAnthropicMessage(msg: CanonicalMessage): AnthropicMessage {
  // Quota-probe shortcut: a single text block → string content.
  if (
    msg.role === "user" &&
    msg.content.length === 1 &&
    msg.content[0]?.type === "text" &&
    msg.content[0].cache === undefined
  ) {
    // Only collapse to a string when the caller did so explicitly via
    // userTextString() helper - otherwise preserve the array form, which
    // is what the live capture sends.
  }

  // Mid-conversation system role: serialize content to a single string.
  if (msg.role === "system") {
    const text = stringifySystemContent(msg.content)
    return { role: "system", content: text }
  }

  // assistant / user messages with array content
  const blocks = msg.content.map(toAnthropicContentBlock).filter(Boolean) as AnthropicContentBlock[]
  return { role: msg.role === "tool" ? "user" : msg.role, content: blocks }
}

function stringifySystemContent(content: CanonicalBlock[]): string {
  return content
    .map((b) => {
      if (b.type === "text") return b.text
      // Provider rejects non-text in role:"system" mid-conversation.
      // We coerce to JSON to surface what was passed; validate() should
      // catch this upstream.
      return JSON.stringify(b)
    })
    .join("\n")
}

function toAnthropicContentBlock(block: CanonicalBlock): AnthropicContentBlock | null {
  switch (block.type) {
    case "text": {
      const out: AnthropicContentBlock = { type: "text", text: block.text }
      if (block.cache) out.cache_control = toAnthropicCacheControl(block.cache)
      return out
    }
    case "thinking": {
      const out: AnthropicContentBlock = {
        type: "thinking",
        thinking: block.text,
        signature: block.signature,
      }
      if (block.cache) out.cache_control = toAnthropicCacheControl(block.cache)
      return out
    }
    case "redacted_thinking": {
      const out: AnthropicContentBlock = { type: "redacted_thinking", data: block.data }
      if (block.cache) out.cache_control = toAnthropicCacheControl(block.cache)
      return out
    }
    case "tool_use": {
      const out: AnthropicContentBlock = {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      }
      if (block.cache) out.cache_control = toAnthropicCacheControl(block.cache)
      return out
    }
    case "tool_result": {
      const innerBlocks = block.content
        .map(toAnthropicContentBlock)
        .filter(Boolean) as AnthropicContentBlock[]
      const out: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        is_error: block.isError,
        content:
          innerBlocks.length === 1 && innerBlocks[0]?.type === "text"
            ? innerBlocks[0].text
            : innerBlocks,
      }
      if (block.cache) out.cache_control = toAnthropicCacheControl(block.cache)
      return out
    }
    case "image": {
      const source = toAnthropicImageSource(block.source)
      if (!source) return null
      const out: AnthropicContentBlock = { type: "image", source }
      if (block.cache) out.cache_control = toAnthropicCacheControl(block.cache)
      return out
    }
    case "audio":
    case "file":
      // Audio + file inputs are not natively supported on the Messages API.
      // validate() flags this; here we drop.
      return null
    default:
      return null
  }
}

function toAnthropicImageSource(
  src: import("@minimal-agent/plugin-api/llm/canonical-messages").ImageSource,
): AnthropicImageSource | null {
  switch (src.kind) {
    case "url":
      return { type: "url", url: src.url }
    case "base64":
      return { type: "base64", media_type: src.mediaType, data: src.data }
    case "file_id":
      // Anthropic doesn't host files (yet) — drop.
      return null
    default: {
      throw new Error(`unhandled image source kind: ${String(src satisfies never)}`)
    }
  }
}

function toAnthropicCacheControl(
  hint: import("@minimal-agent/plugin-api/llm/canonical-messages").CanonicalCacheHint,
): AnthropicCacheControl {
  const out: AnthropicCacheControl = { type: "ephemeral" }
  if (hint.ttl) out.ttl = hint.ttl
  if (hint.scope) out.scope = hint.scope
  return out
}

function toAnthropicToolDef(tool: CanonicalToolDefinition): AnthropicToolDef {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as object,
  }
}

function toAnthropicToolChoice(
  choice: import("@minimal-agent/plugin-api/llm/canonical-tools").ToolChoice,
): AnthropicRequestBody["tool_choice"] {
  switch (choice.type) {
    case "auto":
      return { type: "auto" }
    case "none":
      return { type: "none" }
    case "any":
      return { type: "any" }
    case "tool":
      return { type: "tool", name: choice.name }
    default: {
      throw new Error(`unhandled tool choice: ${String(choice satisfies never)}`)
    }
  }
}

function buildMetadata(req: CanonicalRequest): { user_id?: string } | undefined {
  const md = req.metadata
  if (!md) return undefined
  // Pack the way claude-code does: a single JSON string under user_id
  // with device_id, account_uuid, session_id keys.
  const payload: Record<string, string> = {}
  if (md.deviceId) payload.device_id = md.deviceId
  if (md.accountId) payload.account_uuid = md.accountId
  if (md.sessionId) payload.session_id = md.sessionId
  if (Object.keys(payload).length === 0 && !md.userId) return undefined
  if (md.userId && Object.keys(payload).length === 0) {
    return { user_id: md.userId }
  }
  return { user_id: JSON.stringify(payload) }
}

function mapThinking(
  config: ThinkingConfig | undefined,
  model: ModelView,
): AnthropicRequestBody["thinking"] | undefined {
  if (!config) {
    // Default behavior on adaptive-capable models: enabled adaptive,
    // display omitted. claude-code 2.1.154 sends `{type:"adaptive"}`
    // by default on opus-4-7/4-8.
    if (model.capabilities.thinking.adaptive) return { type: "adaptive" }
    if (model.capabilities.thinking.extended) {
      // Without an explicit budget we don't set extended thinking; legacy
      // models simply omit thinking too.
    }
    return undefined
  }
  switch (config.mode) {
    case "off":
      return undefined
    case "adaptive": {
      const out: AnthropicRequestBody["thinking"] = { type: "adaptive" }
      if (config.display && model.capabilities.thinking.visible) {
        // canonical "summary" → wire "summarized"; "visible" → "summarized"
        // (Anthropic only exposes the binary visible/omitted right now).
        out.display = config.display === "omitted" ? "omitted" : "summarized"
      }
      return out
    }
    case "extended":
      return {
        type: "enabled",
        budget_tokens: config.budgetTokens,
        display: config.display === "omitted" ? "omitted" : undefined,
      }
    default: {
      throw new Error(`unhandled thinking mode: ${String(config satisfies never)}`)
    }
  }
}

function applySampling(body: AnthropicRequestBody, req: CanonicalRequest, model: ModelView): void {
  const gen = req.generation
  const mirror = req.vendor?.anthropic?.mirrorStainlessNulls ?? false
  if (gen?.temperature !== undefined && model.capabilities.acceptsTemperature) {
    body.temperature = gen.temperature
  } else if (mirror) {
    body.temperature = null
  }
  if (gen?.topP !== undefined && model.capabilities.acceptsTopP) {
    body.top_p = gen.topP
  } else if (mirror) {
    body.top_p = null
  }
  if (gen?.topK !== undefined && model.capabilities.acceptsTopK) {
    body.top_k = gen.topK
  } else if (mirror) {
    body.top_k = null
  }
}

function buildOutputConfig(
  req: CanonicalRequest,
  model: ModelView,
): AnthropicRequestBody["output_config"] | undefined {
  const out: NonNullable<AnthropicRequestBody["output_config"]> = {}

  // effort: explicit > model default (only when model has any levels).
  if (req.effort && model.capabilities.effort.levels.includes(req.effort)) {
    out.effort = req.effort
  } else if (
    req.effort === undefined &&
    model.capabilities.effort.levels.length > 0 &&
    // Title/quota requests don't set effort
    req.outputFormat?.type !== "json_schema" &&
    (req.generation?.maxOutputTokens ?? 0) !== 1
  ) {
    out.effort = model.capabilities.effort.default
  }

  if (req.outputFormat?.type === "json_schema") {
    out.format = {
      type: "json_schema",
      schema: req.outputFormat.schema,
      name: req.outputFormat.name,
      strict: req.outputFormat.strict,
    }
  }

  if (req.vendor?.anthropic?.taskBudget) {
    out.task_budget = {
      type: req.vendor.anthropic.taskBudget.type,
      total: req.vendor.anthropic.taskBudget.total,
    }
  }

  return Object.keys(out).length > 0 ? out : undefined
}

// ---------------------------------------------------------------------------
// Request classification (classifyRequest) — pure canonical-read
// ---------------------------------------------------------------------------

/**
 * The kind of request, used to pick Anthropic beta-gate opt-ins and the
 * `context_management` wire shape. Pure classification from canonical fields.
 */
export type AnthropicRequestKind = "quota" | "title" | "subtask" | "conversation"

/** Classify the canonical request into one of the {@link AnthropicRequestKind}. */
export function classifyRequest(req: CanonicalRequest): AnthropicRequestKind {
  const onlyMsg = req.messages.length === 1 ? req.messages[0] : undefined
  if (
    req.generation?.maxOutputTokens === 1 &&
    !req.tools?.length &&
    !req.system?.length &&
    onlyMsg?.role === "user"
  ) {
    return "quota"
  }
  if (req.outputFormat?.type === "json_schema" && (req.tools?.length ?? 0) === 0) {
    return "title"
  }
  const has1hCache = hasAny1hTtl(req)
  if ((req.tools?.length ?? 0) <= 1 && !has1hCache) {
    return "subtask"
  }
  return "conversation"
}

function hasAny1hTtl(req: CanonicalRequest): boolean {
  const checkBlocks = (blocks?: { cache?: { ttl?: string } }[]) =>
    !!blocks?.some((b) => b.cache?.ttl === "1h")
  if (checkBlocks(req.system as { cache?: { ttl?: string } }[] | undefined)) return true
  for (const msg of req.messages) {
    if (msg.cache?.ttl === "1h") return true
    if (Array.isArray(msg.content) && checkBlocks(msg.content as { cache?: { ttl?: string } }[])) {
      return true
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// Request validation (validateAnthropicRequest) — pure canonical-validation
// ---------------------------------------------------------------------------
/**
 * Provider preflight validation: checks a canonical request against the
 * resolved model's declared capabilities (thinking, effort, speed, media,
 * mid-conversation system) and returns the violations found.
 */
export function validateAnthropicRequest(
  req: CanonicalRequest,
  model: ModelView,
): ProviderValidationResult {
  const errors: CapabilityViolation[] = []
  const caps = model.capabilities

  // Sampling
  if (req.generation?.temperature !== undefined && !caps.acceptsTemperature) {
    errors.push(
      new CapabilityViolation(
        "acceptsTemperature",
        `model ${model.id} rejects temperature (adaptive-only)`,
      ),
    )
  }
  if (req.generation?.topP !== undefined && !caps.acceptsTopP) {
    errors.push(new CapabilityViolation("acceptsTopP", `model ${model.id} rejects top_p`))
  }
  if (req.generation?.topK !== undefined && !caps.acceptsTopK) {
    errors.push(new CapabilityViolation("acceptsTopK", `model ${model.id} rejects top_k`))
  }
  if (req.generation?.seed !== undefined && !caps.acceptsSeed) {
    errors.push(new CapabilityViolation("acceptsSeed", `model ${model.id} rejects seed`))
  }

  // Thinking
  const thinking = req.thinking
  if (thinking) {
    if (thinking.mode === "adaptive" && !caps.thinking.adaptive) {
      errors.push(
        new CapabilityViolation(
          "thinking.adaptive",
          `model ${model.id} doesn't support adaptive thinking`,
        ),
      )
    }
    if (thinking.mode === "extended" && !caps.thinking.extended) {
      errors.push(
        new CapabilityViolation(
          "thinking.extended",
          `model ${model.id} doesn't support extended thinking with budget_tokens (use adaptive)`,
        ),
      )
    }
    if (
      (thinking.mode === "adaptive" || thinking.mode === "extended") &&
      (thinking.display === "visible" || thinking.display === "summary") &&
      !caps.thinking.visible
    ) {
      errors.push(
        new CapabilityViolation(
          "thinking.visible",
          `model ${model.id} can't surface visible thinking deltas`,
        ),
      )
    }
  }

  // Effort
  if (req.effort && !caps.effort.levels.includes(req.effort)) {
    errors.push(
      new CapabilityViolation(
        "effort",
        `model ${model.id} effort levels are [${caps.effort.levels.join(", ")}], not "${req.effort}"`,
      ),
    )
  }

  // Mid-conversation system messages
  const hasMidConvSystem = req.messages.some((m) => m.role === "system")
  if (hasMidConvSystem && !caps.midConversationSystem) {
    errors.push(
      new CapabilityViolation(
        "midConversationSystem",
        `model ${model.id} rejects role:"system" inside messages[] (no mid-conversation-system beta)`,
      ),
    )
  }

  // Speed
  if (req.speed === "fast" && !caps.speedFast) {
    errors.push(
      new CapabilityViolation("speedFast", `model ${model.id} doesn't support speed:"fast"`),
    )
  }

  // Output format
  if (req.outputFormat?.type === "json_schema" && !caps.structuredOutputs) {
    errors.push(
      new CapabilityViolation(
        "structuredOutputs",
        `model ${model.id} doesn't support output_config.format`,
      ),
    )
  }

  // 1M alias on a model that doesn't support it
  if (req.modelId.includes("[1m]") && model.capabilities.contextWindow < 1_000_000) {
    errors.push(
      new CapabilityViolation(
        "contextWindow",
        `model ${model.id} can't honor the [1m] context alias`,
      ),
    )
  }

  // Assistant prefill (last assistant message with partial content)
  const last = req.messages[req.messages.length - 1]
  if (
    last?.role === "assistant" &&
    !caps.assistantPrefill &&
    last.content.some((b) => b.type === "text" && b.text.length > 0)
  ) {
    errors.push(
      new CapabilityViolation(
        "assistantPrefill",
        `model ${model.id} rejects assistant prefill (use output_config.format instead)`,
      ),
    )
  }

  // Server-side history pointer is OpenAI-only
  if (req.previousResponseId) {
    errors.push(
      new CapabilityViolation(
        "serverSideHistory",
        "Anthropic Messages doesn't accept previousResponseId; send full messages[]",
      ),
    )
  }

  // Multimodal input gating (image/audio/file) — shared across providers.
  errors.push(...modalityViolations(req.messages, caps, model.id))

  if (errors.length === 0) return { ok: true, errors }

  // Degrade offer: when the ONLY violation is a fast-mode request against a
  // model with no fast tier, the same request without `speed` is valid.
  // Mirrors the legacy transport's behavior (client.ts drops the field +
  // beta with a diag.warn) so flipping transports never turns a sticky
  // --fast into a hard failure.
  if (errors.length === 1 && errors[0]?.capability === "speedFast") {
    const { speed: _dropped, ...rest } = req
    return { ok: false, errors, degrade: rest }
  }

  // Degrade offer: when the ONLY violations are modality mismatches, offer a
  // message list with those blocks stripped so the caller can continue the
  // conversation instead of hard-failing. This is the key enabler for
  // --resume with a different model: a session created with a vision model
  // can resume under a text-only model because images are stripped before
  // the first send.
  const allModality = errors.every((e) => e.capability === "modalities")
  if (allModality) {
    const cleaned = stripUnsupportedModalities(req.messages, caps)
    return {
      ok: false,
      errors,
      degrade: { ...req, messages: cleaned },
    }
  }

  return { ok: false, errors }
}
