/**
 * OpenAI Chat Completions SSE → CanonicalEvent translator.
 *
 * Wire shape per chunk (the SSE `data:` JSON):
 *
 * ```
 *   {
 *     id: "chatcmpl-…",
 *     object: "chat.completion.chunk",
 *     created: <unix>,
 *     model: "gpt-4o",
 *     choices: [{
 *       index: 0,
 *       delta: {
 *         role?: "assistant",            // first chunk only
 *         content?: "Hello",             // text delta
 *         refusal?: "...",               // refusal delta
 *         tool_calls?: [{                // tool call delta
 *           index: 0,
 *           id?: "call_abc",             // first chunk for this index
 *           type?: "function",
 *           function: { name?, arguments? }
 *         }]
 *       },
 *       finish_reason: null | "stop" | "length" | "tool_calls" | "content_filter" | "function_call"
 *     }],
 *     usage?: {                          // final chunk (with stream_options.include_usage)
 *       prompt_tokens, completion_tokens, total_tokens,
 *       prompt_tokens_details: { cached_tokens },
 *       completion_tokens_details: { reasoning_tokens }
 *     }
 *   }
 * ```
 *
 * Stream ends with `data: [DONE]` (handled by the generic SSE parser).
 *
 * Provider-neutral: the full canonical↔OpenAI-compatible-chat WIRE CONTRACT —
 * stream translation ({@link translateOpenAIChatStream}), request validation
 * ({@link validateOpenAIRequest}), body building ({@link buildOpenAIChatBody}),
 * and auth-header building ({@link buildOpenAIHeaders}). It lives in the leaf
 * package because every OpenAI-compatible gateway provider (openrouter,
 * opencode, huggingface, wafer) speaks this exact wire format, not just the
 * OpenAI adapter. Wave G relocated it here from the `plugins/llm-openai/*`
 * files (which now re-export it) so the gateways vendor ONE shared wire
 * contract instead of cross-importing the openai plugin.
 *
 * The 2 genuinely-OpenAI-specific values are PARAMETRIZED so no openai-only
 * constant leaks into the neutral contract: `buildOpenAIHeaders` takes an
 * optional `userAgent` (the openai plugin passes its own UA; a gateway passes
 * its own or none), and `buildOpenAIChatBody` takes an optional
 * `allowedServiceTiers` set (the openai plugin passes OpenAI's tier set; a
 * gateway that has no tier concept passes nothing and the field is omitted).
 * Endpoint URLs are NOT here — each provider defines its own at the fetch site.
 *
 * @module llm/openai-chat
 */

import type { CanonicalEvent, CanonicalUsage, StopReason } from "./canonical-events.ts"
import type {
  CanonicalBlock,
  CanonicalMessage,
  ImageSource,
  ToolResultBlock,
} from "./canonical-messages.ts"
import type { CanonicalToolDefinition, ToolChoice } from "./canonical-tools.ts"
import { CapabilityViolation } from "./errors.ts"
import { modalityViolations, stripUnsupportedModalities } from "./modality-check.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import type { ProviderAuth } from "./provider-auth.ts"
import type { ProviderValidationResult } from "./provider-plugin.ts"
import type { ModelView } from "../types/host-capabilities.ts"

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface OpenAIChatChunk {
  id: string
  object: "chat.completion.chunk"
  created: number
  model: string
  choices: Array<{
    index: number
    delta: {
      role?: "assistant"
      content?: string | null
      refusal?: string | null
      /** DeepSeek-style chain-of-thought reasoning. */
      reasoning_content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: "function"
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
    completion_tokens_details?: { reasoning_tokens?: number }
  }
}

// ---------------------------------------------------------------------------
// Translator
// ---------------------------------------------------------------------------

/**
 * Yield canonical events from a stream of OpenAI Chat chunks.
 *
 * Maintains:
 * - Synthesized `message_start` on the first chunk (Chat doesn't send
 *   one explicitly; we mint a `msg_chatcmpl-…` id from the chunk id).
 * - Per-tool-call accumulation by `tool_calls[i].index`. First chunk
 *   for an index carries `id` + `function.name`; subsequent chunks
 *   stream `function.arguments` fragments.
 * - One text "block" for all content deltas (Chat has no separate
 *   start/stop markers within the assistant message).
 * - finish_reason → canonical StopReason.
 * - Final usage chunk (`choices: []` + `usage`) → MessageDeltaEvent.
 *
 * @yields Canonical events translated from each Chat Completions chunk.
 */
export async function* translateOpenAIChatStream(
  chunks: AsyncIterable<OpenAIChatChunk>,
): AsyncIterable<CanonicalEvent> {
  let messageStartEmitted = false
  let textIndex: number | null = null
  let thinkingIndex: number | null = null
  // Index → block index for tool calls
  const toolBlockIndex = new Map<number, number>()
  const toolNames = new Map<number, string>()
  const toolJson = new Map<number, string>()
  let nextBlockIndex = 0
  let stopReason: StopReason | null = null
  let lastUsage: CanonicalUsage = { inputTokens: 0, outputTokens: 0 }
  let modelId: string | undefined

  for await (const chunk of chunks) {
    modelId ??= chunk.model
    if (!messageStartEmitted) {
      messageStartEmitted = true
      yield {
        type: "message_start",
        messageId: chunk.id,
        modelId: chunk.model,
        initialUsage: lastUsage,
      }
    }

    // Capture usage from any chunk that has it. Some OpenAI-compatible APIs
    // (OpenCode Go, DeepSeek) send usage in the same chunk as the final
    // finish_reason/choice rather than a separate usage-only chunk.
    if (chunk.usage) {
      lastUsage = mapUsage(chunk.usage)
    }

    // Usage-only trailing chunk (OpenAI standard): choices empty, usage set.
    if (chunk.choices.length === 0 && chunk.usage) {
      continue
    }

    const choice = chunk.choices[0]
    if (!choice) continue

    const delta = choice.delta ?? {}

    // Text content
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (textIndex === null) {
        textIndex = nextBlockIndex++
        yield { type: "text_start", index: textIndex }
      }
      yield { type: "text_delta", index: textIndex, text: delta.content }
    }

    // Refusal content
    if (typeof delta.refusal === "string" && delta.refusal.length > 0) {
      yield { type: "refusal_delta", text: delta.refusal }
    }

    // Reasoning content (DeepSeek-style thinking). Streamed as thinking
    // blocks — `reasoning_content` is the model's internal chain-of-thought.
    if (delta.reasoning_content !== undefined) {
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        if (thinkingIndex === null) {
          thinkingIndex = nextBlockIndex++
          yield { type: "thinking_start", index: thinkingIndex }
        }
        yield { type: "thinking_delta", index: thinkingIndex, text: delta.reasoning_content }
      } else if (thinkingIndex !== null) {
        yield { type: "thinking_stop", index: thinkingIndex }
        thinkingIndex = null
      }
    }

    // Tool call deltas
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        // First chunk for this tool-call index: open the block.
        if (!toolBlockIndex.has(tc.index)) {
          const blockIdx = nextBlockIndex++
          toolBlockIndex.set(tc.index, blockIdx)
          toolJson.set(tc.index, "")
          const id = tc.id ?? `call_${tc.index}`
          const name = tc.function?.name ?? "unknown"
          toolNames.set(tc.index, name)
          yield { type: "tool_use_start", index: blockIdx, id, name }
        }
        // Stream the function name if it lands late (rare).
        if (tc.function?.name && toolNames.get(tc.index) === "unknown") {
          toolNames.set(tc.index, tc.function.name)
        }
        // Stream the arguments JSON fragment.
        if (tc.function?.arguments) {
          const blockIdx = toolBlockIndex.get(tc.index) ?? -1
          toolJson.set(tc.index, (toolJson.get(tc.index) ?? "") + tc.function.arguments)
          yield {
            type: "tool_use_input_delta",
            index: blockIdx,
            partialJson: tc.function.arguments,
          }
        }
      }
    }

    // Finish reason → close any open blocks + record stop reason.
    if (choice.finish_reason) {
      stopReason = mapFinishReason(choice.finish_reason)
      if (thinkingIndex !== null) {
        yield { type: "thinking_stop", index: thinkingIndex }
        thinkingIndex = null
      }
      if (textIndex !== null) {
        yield { type: "text_stop", index: textIndex }
        textIndex = null
      }
      // Close any open tool_use blocks with their parsed input.
      for (const [tcIndex, blockIdx] of toolBlockIndex.entries()) {
        const raw = toolJson.get(tcIndex) ?? ""
        let input: unknown
        try {
          input = raw ? JSON.parse(raw) : {}
        } catch {
          input = { _raw: raw }
        }
        yield { type: "tool_use_stop", index: blockIdx, input }
      }
      toolBlockIndex.clear()
      toolJson.clear()
      toolNames.clear()
    }
  }

  // Emit the terminal MessageDeltaEvent + MessageStopEvent.
  yield {
    type: "message_delta",
    stopReason,
    stopDetails: stopReason === "refusal" ? { type: "content_filter" } : null,
    usage: lastUsage,
  }
  yield { type: "message_stop" }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapUsage(usage: NonNullable<OpenAIChatChunk["usage"]>): CanonicalUsage {
  const out: CanonicalUsage = {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
  }
  if (usage.prompt_tokens_details?.cached_tokens !== undefined) {
    out.cacheReadTokens = usage.prompt_tokens_details.cached_tokens
  }
  if (usage.completion_tokens_details?.reasoning_tokens !== undefined) {
    out.reasoningTokens = usage.completion_tokens_details.reasoning_tokens
  }
  return out
}

function mapFinishReason(reason: string): StopReason {
  switch (reason) {
    case "stop":
      return "end_turn"
    case "length":
      return "max_tokens"
    case "tool_calls":
    case "function_call":
      return "tool_use"
    case "content_filter":
      return "refusal"
    default:
      return "error"
  }
}

// ===========================================================================
// Auth headers (buildOpenAIHeaders)
// ===========================================================================

/** Options for {@link buildOpenAIHeaders}. */
export interface OpenAIHeadersOpts {
  auth: ProviderAuth
  /** Optional explicit `OpenAI-Beta` header value. */
  beta?: string
  /**
   * Optional `user-agent` header. Provider-specific, so the neutral contract
   * takes it as a parameter: the OpenAI adapter passes its own UA
   * (`minimal-agent-openai/0.1`), a gateway passes its own or omits it. When
   * absent, no `user-agent` header is set.
   */
  userAgent?: string
}

/**
 * Build the auth + content headers for a Chat/Responses API request. The URL
 * is NOT built here (each provider defines its own endpoint); this only shapes
 * the OpenAI-compatible auth + content-type + optional beta/user-agent headers.
 */
export function buildOpenAIHeaders(opts: OpenAIHeadersOpts): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  }
  if (opts.userAgent) headers["user-agent"] = opts.userAgent

  switch (opts.auth.kind) {
    case "api-key":
      headers.authorization = `Bearer ${opts.auth.key}`
      if (opts.auth.organization) headers["openai-organization"] = opts.auth.organization
      if (opts.auth.project) headers["openai-project"] = opts.auth.project
      break
    case "oauth":
      headers.authorization = `Bearer ${opts.auth.token}`
      if (opts.auth.headers) Object.assign(headers, opts.auth.headers)
      break
    case "custom":
      Object.assign(headers, opts.auth.headers)
      break
  }

  if (opts.beta) headers["openai-beta"] = opts.beta
  return headers
}

// ===========================================================================
// Request validation (validateOpenAIRequest)
// ===========================================================================

/**
 * Provider preflight validation: checks a canonical request against the
 * resolved model's declared capabilities and returns the violations found.
 * Pure: no network, no I/O. Safe to call before dispatch. Provider-neutral —
 * every OpenAI-compatible gateway shares these capability rules.
 */
export function validateOpenAIRequest(
  req: CanonicalRequest,
  model: ModelView,
): ProviderValidationResult {
  const errors: CapabilityViolation[] = []
  const caps = model.capabilities

  if (req.generation?.temperature !== undefined && !caps.acceptsTemperature) {
    errors.push(
      new CapabilityViolation("acceptsTemperature", `model ${model.id} rejects temperature`),
    )
  }
  if (req.generation?.topP !== undefined && !caps.acceptsTopP) {
    errors.push(new CapabilityViolation("acceptsTopP", `model ${model.id} rejects top_p`))
  }
  if (req.generation?.topK !== undefined && !caps.acceptsTopK) {
    errors.push(new CapabilityViolation("acceptsTopK", `model ${model.id} has no top_k`))
  }
  if (req.generation?.seed !== undefined && !caps.acceptsSeed) {
    errors.push(new CapabilityViolation("acceptsSeed", `model ${model.id} rejects seed`))
  }

  const thinking = req.thinking
  if (thinking) {
    if (thinking.mode === "adaptive" && !caps.thinking.adaptive) {
      errors.push(
        new CapabilityViolation(
          "thinking.adaptive",
          `model ${model.id} doesn't stream adaptive reasoning on this surface (use the Responses surface)`,
        ),
      )
    }
    if (thinking.mode === "extended" && !caps.thinking.extended) {
      errors.push(
        new CapabilityViolation(
          "thinking.extended",
          `model ${model.id} doesn't support extended thinking with budget_tokens (use effort)`,
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
          `model ${model.id} can't surface visible reasoning deltas on this surface`,
        ),
      )
    }
  }

  if (req.effort && !caps.effort.levels.includes(req.effort)) {
    errors.push(
      new CapabilityViolation(
        "effort",
        `model ${model.id} reasoning levels are [${caps.effort.levels.join(", ")}], not "${req.effort}"`,
      ),
    )
  }

  const hasMidConvSystem = req.messages.some((m) => m.role === "system")
  if (hasMidConvSystem && !caps.midConversationSystem) {
    errors.push(
      new CapabilityViolation(
        "midConversationSystem",
        `model ${model.id} rejects role:"system" inside messages[]`,
      ),
    )
  }

  if (req.speed === "fast" && !caps.speedFast) {
    errors.push(
      new CapabilityViolation("speedFast", `model ${model.id} doesn't support speed:"fast"`),
    )
  }

  if (req.outputFormat?.type === "json_schema" && !caps.structuredOutputs) {
    errors.push(
      new CapabilityViolation(
        "structuredOutputs",
        `model ${model.id} doesn't support structured outputs`,
      ),
    )
  }

  const last = req.messages[req.messages.length - 1]
  if (
    last?.role === "assistant" &&
    !caps.assistantPrefill &&
    last.content.some((b) => b.type === "text" && b.text.length > 0)
  ) {
    errors.push(
      new CapabilityViolation("assistantPrefill", `model ${model.id} rejects assistant prefill`),
    )
  }

  if (req.previousResponseId && !caps.serverSideHistory) {
    errors.push(
      new CapabilityViolation(
        "serverSideHistory",
        `model ${model.id} (Chat surface) doesn't accept previousResponseId; send full messages[]`,
      ),
    )
  }

  errors.push(...modalityViolations(req.messages, caps, model.id))

  if (errors.length === 0) return { ok: true, errors }

  const allModality = errors.every((e) => e.capability === "modalities")
  if (allModality) {
    const cleaned = stripUnsupportedModalities(req.messages, caps)
    return { ok: false, errors, degrade: { ...req, messages: cleaned } }
  }

  return { ok: false, errors }
}

// ===========================================================================
// Request body (buildOpenAIChatBody)
// ===========================================================================

export interface OpenAIChatRequestBody {
  model: string
  messages: OpenAIChatMessage[]
  tools?: OpenAIChatTool[]
  tool_choice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } }
  parallel_tool_calls?: boolean
  response_format?: OpenAIChatResponseFormat
  max_tokens?: number
  max_completion_tokens?: number
  temperature?: number
  top_p?: number
  seed?: number
  stop?: string | string[]
  stream?: boolean
  stream_options?: { include_usage: boolean }
  reasoning_effort?: "low" | "medium" | "high" | "max"
  metadata?: Record<string, string>
  user?: string
  store?: boolean
  prediction?: { type: "content"; content: string }
  service_tier?: "auto" | "default" | "flex" | "scale" | "priority"
}

export interface OpenAIChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool"
  content?: string | OpenAIChatContentPart[] | null
  name?: string
  tool_call_id?: string
  tool_calls?: Array<{
    id: string
    type: "function"
    function: { name: string; arguments: string }
  }>
  refusal?: string
}

export type OpenAIChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "low" | "high" | "auto" } }
  | { type: "input_audio"; input_audio: { data: string; format: string } }

export interface OpenAIChatTool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: object
    strict?: boolean
  }
}

export type OpenAIChatResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: { name: string; schema: object; strict?: boolean } }

/**
 * Build the Chat Completions request body from a canonical request: maps
 * messages/tools/sampling knobs onto the chat-completions wire shape.
 *
 * `allowedServiceTiers` parametrizes the ONE openai-specific value: the OpenAI
 * adapter passes its tier set (`{auto,default,flex,scale,priority}`); a gateway
 * with no service-tier concept passes nothing and the `service_tier` field is
 * omitted from the body. This keeps the neutral contract free of any
 * openai-only constant.
 */
export function buildOpenAIChatBody(
  req: CanonicalRequest,
  model: ModelView,
  allowedServiceTiers?: ReadonlySet<string>,
): OpenAIChatRequestBody {
  const body: OpenAIChatRequestBody = {
    model: model.vendorIds?.firstParty ?? req.modelId,
    messages: buildChatMessages(req),
  }

  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.filter((t) => !t.server).map(toChatTool)
  }
  if (req.toolChoice) body.tool_choice = toChatToolChoice(req.toolChoice)

  const isReasoningModel = model.capabilities.effort.levels.length > 0
  if (req.generation?.maxOutputTokens !== undefined) {
    const cap = Math.min(req.generation.maxOutputTokens, model.capabilities.maxOutputTokens)
    if (isReasoningModel) body.max_completion_tokens = cap
    else body.max_tokens = cap
  }

  if (req.generation?.temperature !== undefined && model.capabilities.acceptsTemperature) {
    body.temperature = req.generation.temperature
  }
  if (req.generation?.topP !== undefined && model.capabilities.acceptsTopP) {
    body.top_p = req.generation.topP
  }
  if (req.generation?.seed !== undefined && model.capabilities.acceptsSeed) {
    body.seed = req.generation.seed
  }
  if (req.generation?.stop && model.capabilities.acceptsStopSequences) {
    body.stop = req.generation.stop
  }

  if (req.effort && isReasoningModel && model.capabilities.effort.levels.includes(req.effort)) {
    body.reasoning_effort = req.effort as OpenAIChatRequestBody["reasoning_effort"]
  }

  if (req.outputFormat) {
    body.response_format = toChatResponseFormat(req.outputFormat)
  }

  body.stream = req.stream ?? true
  if (body.stream) {
    body.stream_options = { include_usage: true }
  }

  const vendor = req.vendor?.openai
  if (vendor?.parallelToolCalls !== undefined) body.parallel_tool_calls = vendor.parallelToolCalls
  if (vendor?.user) body.user = vendor.user
  if (vendor?.store !== undefined) body.store = vendor.store
  if (vendor?.prediction) body.prediction = vendor.prediction

  if (req.metadata?.custom) body.metadata = { ...req.metadata.custom }

  // Provider-neutral service tier → OpenAI `service_tier`, gated on the caller's
  // allowed set (openai passes its tier set; gateways without the concept omit).
  const tier = vendor?.serviceTier ?? req.serviceTier
  if (tier !== undefined && allowedServiceTiers?.has(tier)) {
    body.service_tier = tier as NonNullable<OpenAIChatRequestBody["service_tier"]>
  }

  return body
}

function buildChatMessages(req: CanonicalRequest): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = []
  if (req.system && req.system.length > 0) {
    const text = req.system
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n\n")
    if (text) out.push({ role: "system", content: text })
  }
  for (const msg of req.messages) {
    const toolResultBlocks = msg.content.filter(
      (b): b is ToolResultBlock => b.type === "tool_result",
    )
    if (toolResultBlocks.length > 0) {
      for (const tr of toolResultBlocks) {
        const text = tr.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .filter(Boolean)
          .join("\n")
        out.push({ role: "tool", tool_call_id: tr.toolUseId, content: text })
      }
      const nonResultBlocks = msg.content.filter((b) => b.type !== "tool_result")
      if (nonResultBlocks.length > 0) {
        out.push(canonicalMessageToChat({ ...msg, content: nonResultBlocks }))
      }
    } else {
      out.push(canonicalMessageToChat(msg))
    }
  }
  return out
}

function canonicalMessageToChat(msg: CanonicalMessage): OpenAIChatMessage {
  if (msg.role === "tool") {
    const text = msg.content.map((b) => (b.type === "text" ? b.text : JSON.stringify(b))).join("\n")
    return { role: "tool", tool_call_id: msg.toolCallId, content: text }
  }
  if (msg.role === "system") {
    const text = msg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
    return { role: "system", content: text }
  }
  const toolCalls: NonNullable<OpenAIChatMessage["tool_calls"]> = []
  const parts: OpenAIChatContentPart[] = []
  for (const block of msg.content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text })
    } else if (block.type === "image") {
      const part = imageToChatPart(block)
      if (part) parts.push(part)
    } else if (block.type === "audio") {
      if (block.source.kind === "base64") {
        parts.push({
          type: "input_audio",
          input_audio: { data: block.source.data, format: block.source.format },
        })
      }
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
        },
      })
    }
  }

  const result: OpenAIChatMessage = {
    role: msg.role === "user" ? "user" : "assistant",
  }
  if (parts.length === 1 && parts[0]?.type === "text") {
    result.content = parts[0].text
  } else if (parts.length > 0) {
    result.content = parts
  } else if (toolCalls.length === 0) {
    result.content = ""
  }
  if (toolCalls.length > 0) result.tool_calls = toolCalls
  return result
}

function imageToChatPart(block: {
  source: ImageSource
  type: "image"
}): OpenAIChatContentPart | null {
  const src = block.source
  if (src.kind === "url")
    return { type: "image_url", image_url: { url: src.url, detail: src.detail } }
  if (src.kind === "base64") {
    return {
      type: "image_url",
      image_url: { url: `data:${src.mediaType};base64,${src.data}`, detail: src.detail },
    }
  }
  return null
}

function toChatTool(tool: CanonicalToolDefinition): OpenAIChatTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as object,
      strict: tool.strict,
    },
  }
}

function toChatToolChoice(choice: ToolChoice): OpenAIChatRequestBody["tool_choice"] {
  switch (choice.type) {
    case "auto":
      return "auto"
    case "none":
      return "none"
    case "any":
      return "required"
    case "tool":
      return { type: "function", function: { name: choice.name } }
    default: {
      throw new Error(`unhandled tool choice: ${String(choice satisfies never)}`)
    }
  }
}

function toChatResponseFormat(
  fmt: NonNullable<CanonicalRequest["outputFormat"]>,
): OpenAIChatResponseFormat {
  if (fmt.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: fmt.name ?? "response",
        schema: fmt.schema,
        strict: fmt.strict,
      },
    }
  }
  return fmt.type === "json_object" ? { type: "json_object" } : { type: "text" }
}

// Silence unused-import warning on CanonicalBlock (kept for parity with the
// source module's content modeling).
void (null as unknown as CanonicalBlock | undefined)
