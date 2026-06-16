/**
 * Canonical → OpenAI Chat Completions request body.
 *
 * Verified against the OpenAI API reference (https://platform.openai.com/docs/api-reference/chat).
 * Key shapes:
 *
 * - `messages[]`: role ∈ `{system, developer, user, assistant, tool}`,
 *   content is string or [parts]. Tool calls live on the assistant
 *   message under `tool_calls[]`; results live on `role:"tool"` with
 *   `tool_call_id`.
 * - `tools[]`: `{type:"function", function:{name, description, parameters, strict?}}`.
 * - `tool_choice`: `"auto" | "none" | "required"` or `{type:"function", function:{name}}`.
 * - `reasoning_effort`: `"low" | "medium" | "high"` (o-series/gpt-5).
 * - `max_completion_tokens`: replaces `max_tokens` on reasoning models.
 * - `response_format`: `{type:"text"|"json_object"|"json_schema", json_schema?:{name, schema, strict?}}`.
 *
 * @module llm/providers/openai/chat/request-body
 */

import type {
  CanonicalBlock,
  CanonicalMessage,
  ToolResultBlock,
} from "@minimal-agent/plugin-api/llm/canonical-messages"
import type {
  CanonicalToolDefinition,
  ToolChoice,
} from "@minimal-agent/plugin-api/llm/canonical-tools"

import type { CanonicalRequest } from "../../../src/llm/canonical-request.ts"
import type { ModelEntry } from "../../../src/llm/model-registry.ts"

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

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
  reasoning_effort?: "low" | "medium" | "high"
  metadata?: Record<string, string>
  user?: string
  store?: boolean
  prediction?: { type: "content"; content: string }
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

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Build the Chat Completions request body from a canonical request: maps
 * messages/tools/sampling knobs onto the chat-completions wire shape.
 */
export function buildOpenAIChatBody(
  req: CanonicalRequest,
  model: ModelEntry,
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
  // Max tokens: reasoning models use `max_completion_tokens`; everything
  // else uses `max_tokens`.
  if (req.generation?.maxOutputTokens !== undefined) {
    const cap = Math.min(req.generation.maxOutputTokens, model.capabilities.maxOutputTokens)
    if (isReasoningModel) body.max_completion_tokens = cap
    else body.max_tokens = cap
  }

  // Sampling
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

  // Reasoning effort (reasoning models only)
  if (req.effort && isReasoningModel && model.capabilities.effort.levels.includes(req.effort)) {
    body.reasoning_effort = req.effort as "low" | "medium" | "high"
  }

  // Output format
  if (req.outputFormat) {
    body.response_format = toChatResponseFormat(req.outputFormat)
  }

  // Streaming
  body.stream = req.stream ?? true
  if (body.stream) {
    // Always opt into usage in the final SSE chunk.
    body.stream_options = { include_usage: true }
  }

  // OpenAI vendor options
  const vendor = req.vendor?.openai
  if (vendor?.parallelToolCalls !== undefined) body.parallel_tool_calls = vendor.parallelToolCalls
  if (vendor?.user) body.user = vendor.user
  if (vendor?.store !== undefined) body.store = vendor.store
  if (vendor?.prediction) body.prediction = vendor.prediction

  // Metadata: only flat string→string accepted on Chat.
  if (req.metadata?.custom) body.metadata = { ...req.metadata.custom }

  return body
}

function buildChatMessages(req: CanonicalRequest): OpenAIChatMessage[] {
  const out: OpenAIChatMessage[] = []
  // System prefix → developer/system message at the head.
  if (req.system && req.system.length > 0) {
    const text = req.system
      .map((b) => (b.type === "text" ? b.text : ""))
      .filter(Boolean)
      .join("\n\n")
    if (text) out.push({ role: "system", content: text })
  }
  for (const msg of req.messages) {
    // Canonical form embeds tool results as tool_result blocks inside
    // role:"user" messages. The OpenAI Chat API requires them as
    // separate role:"tool" messages with matching tool_call_id.
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
      // If the message also has non-tool-result content, emit it as a
      // user message. The agent loop typically creates a dedicated user
      // message for tool results, so non-result content is rare, but
      // handle it for correctness.
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
  // role:"tool" — content is a string (or stringified array on the wire).
  if (msg.role === "tool") {
    const text = msg.content.map((b) => (b.type === "text" ? b.text : JSON.stringify(b))).join("\n")
    return { role: "tool", tool_call_id: msg.toolCallId, content: text }
  }
  // role:"system" mid-convo → system role (Chat allows it anywhere).
  if (msg.role === "system") {
    const text = msg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
    return { role: "system", content: text }
  }
  // user / assistant: collect tool_use blocks → tool_calls, text/image → content.
  const toolCalls: NonNullable<OpenAIChatMessage["tool_calls"]> = []
  const parts: OpenAIChatContentPart[] = []
  // tool_result blocks become separate role:"tool" messages — we emit
  // an extra message after this one.
  const toolResults: { tool_call_id: string; content: string }[] = []
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
    } else if (block.type === "tool_result") {
      const text = block.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .filter(Boolean)
        .join("\n")
      toolResults.push({ tool_call_id: block.toolUseId, content: text })
    }
    // thinking blocks: OpenAI Chat has no concept; drop silently.
    // file blocks: dropped (not supported on Chat).
  }
  // Note: `toolResults` are not emitted in this single message; callers
  // who need them should split tool_result blocks into their own
  // `role:"tool"` canonical messages. We attach them as a side-channel
  // for the adapter to flatten — see the wrapper in `request-body.ts`
  // post-processing if added later. For now, drop with a debug log
  // would be appropriate; in practice canonical callers send
  // tool_result via `role:"tool"`.

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
  source: import("@minimal-agent/plugin-api/llm/canonical-messages").ImageSource
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

// Silence unused-import warnings on CanonicalBlock when content modeling drops it
void (null as unknown as CanonicalBlock | undefined)
