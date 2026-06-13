/**
 * Canonical → Anthropic Messages request body.
 *
 * Verified against `cli.patched.cjs` L657214+ (the `NH()` request
 * assembler) and the live 2026-05-28 captures in
 * `.node-net-dbg/1779992683022-28-MAY-2026-THURSDAY--14h24m43s-EDT/`.
 *
 * The body follows this top-level order on the wire (preserved here
 * for snapshot stability):
 *
 *   model, messages, system, tools, tool_choice, metadata,
 *   max_tokens, thinking, [temperature?], context_management,
 *   output_config, [speed?], diagnostics?
 *
 * Sampling fields (`temperature`, `top_p`, `top_k`) are omitted by
 * default; opt into Stainless-style `null`s via
 * `req.vendor?.anthropic?.mirrorStainlessNulls`.
 *
 * @module llm/providers/anthropic/request-body
 */

import type { CanonicalBlock, CanonicalMessage } from "../../src/llm/canonical-messages.ts"
import type { CanonicalRequest, ThinkingConfig } from "../../src/llm/canonical-request.ts"
import type { CanonicalToolDefinition } from "../../src/llm/canonical-tools.ts"
import type { ModelEntry } from "../../src/llm/model-registry.ts"

import { classifyRequest } from "./beta-flags.ts"

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
  diagnostics?: { previous_message_id: string | null }
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Translate a `CanonicalRequest` into the Anthropic `/v1/messages`
 * POST body. Caller passes the resolved `ModelEntry` so model id and
 * capabilities are accessible (e.g. for `max_tokens` clamping).
 */
export function buildAnthropicRequestBody(
  req: CanonicalRequest,
  model: ModelEntry,
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

function clampMaxTokens(requested: number | undefined, model: ModelEntry): number {
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
  src: import("../../src/llm/canonical-messages.ts").ImageSource,
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
  hint: import("../../src/llm/canonical-messages.ts").CanonicalCacheHint,
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
  choice: import("../../src/llm/canonical-tools.ts").ToolChoice,
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
  model: ModelEntry,
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

function applySampling(body: AnthropicRequestBody, req: CanonicalRequest, model: ModelEntry): void {
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
  model: ModelEntry,
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
