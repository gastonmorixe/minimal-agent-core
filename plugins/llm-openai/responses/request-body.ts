/**
 * Canonical → OpenAI Responses API request body.
 *
 * Surface reference: https://platform.openai.com/docs/api-reference/responses
 *
 * Key differences from Chat Completions:
 *
 * - `instructions: string` replaces the system message at the head of
 *   `messages[]` — pure prefix, no role wrapping.
 * - `input` is either a string OR an array of `InputItem` (message,
 *   function_call, function_call_output, image, file, computer_call).
 * - `tools[]` are **flat** `{type:"function", name, description, parameters, strict?}`
 *   — no nested `function` wrapper. Server tools
 *   live alongside as `{type:"web_search_preview"}` etc.
 * - `reasoning: {effort, summary?}` replaces `reasoning_effort`.
 * - `max_output_tokens` replaces `max_tokens` / `max_completion_tokens`.
 * - `previous_response_id` enables stateful mode: send only the new
 *   turn's items, the server replays the chain.
 * - `store`, `include`, `metadata` work like Chat but `metadata` is
 *   string→string only.
 *
 * @module llm/providers/openai/responses/request-body
 */

import type {
  CanonicalBlock,
  CanonicalMessage,
} from "@minimal-agent/plugin-api/llm/canonical-messages"
import type {
  CanonicalToolDefinition,
  ToolChoice,
} from "@minimal-agent/plugin-api/llm/canonical-tools"
import type { ServerToolId } from "@minimal-agent/plugin-api/llm/capabilities"

import type { CanonicalRequest } from "../../../src/llm/canonical-request.ts"
import type { ModelEntry } from "../../../src/llm/model-registry.ts"

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface OpenAIResponsesRequestBody {
  model: string
  instructions?: string
  input: string | OpenAIResponsesInputItem[]
  previous_response_id?: string
  tools?: OpenAIResponsesTool[]
  tool_choice?: "auto" | "none" | "required" | { type: "function"; name: string }
  parallel_tool_calls?: boolean
  reasoning?: { effort?: "low" | "medium" | "high"; summary?: "auto" | "concise" | "detailed" }
  response_format?:
    | { type: "text" }
    | { type: "json_object" }
    | { type: "json_schema"; json_schema: { name: string; schema: object; strict?: boolean } }
  max_output_tokens?: number
  stream?: boolean
  store?: boolean
  include?: string[]
  metadata?: Record<string, string>
  user?: string
}

export type OpenAIResponsesInputItem =
  | OpenAIResponsesMessageItem
  | OpenAIResponsesFunctionCallItem
  | OpenAIResponsesFunctionCallOutputItem

export interface OpenAIResponsesMessageItem {
  type: "message"
  role: "user" | "assistant" | "system" | "developer"
  content: Array<
    | { type: "input_text"; text: string }
    | { type: "output_text"; text: string }
    | { type: "input_image"; image_url: string; detail?: "low" | "high" | "auto" }
    | { type: "input_image"; file_id: string; detail?: "low" | "high" | "auto" }
    | { type: "input_file"; file_id: string }
  >
}

export interface OpenAIResponsesFunctionCallItem {
  type: "function_call"
  call_id: string
  name: string
  arguments: string
}

export interface OpenAIResponsesFunctionCallOutputItem {
  type: "function_call_output"
  call_id: string
  output: string
}

export type OpenAIResponsesTool =
  | {
      type: "function"
      name: string
      description?: string
      parameters: object
      strict?: boolean
    }
  | { type: "web_search_preview" }
  | { type: "file_search"; vector_store_ids: string[] }
  | { type: "code_interpreter"; container: { type: "auto" } }
  | {
      type: "computer_use_preview"
      display_width: number
      display_height: number
      environment: "browser" | "windows" | "mac"
    }

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Build the Responses API request body from a canonical request: maps
 * messages, tools, reasoning, and sampling knobs onto the responses wire
 * shape.
 */
export function buildOpenAIResponsesBody(
  req: CanonicalRequest,
  model: ModelEntry,
): OpenAIResponsesRequestBody {
  const body: OpenAIResponsesRequestBody = {
    model: model.vendorIds?.firstParty ?? req.modelId,
    instructions: buildInstructions(req),
    input: buildInputItems(req),
    store: false,
  }

  // Stateful mode: client sends only the new turn(s); server replays the chain.
  if (req.previousResponseId) body.previous_response_id = req.previousResponseId

  if (req.tools && req.tools.length > 0) body.tools = req.tools.map(toResponsesTool)
  if (req.toolChoice) body.tool_choice = toResponsesToolChoice(req.toolChoice)

  // Reasoning
  const isReasoningModel = model.capabilities.effort.levels.length > 0
  if (req.thinking?.mode === "adaptive" || isReasoningModel) {
    const reasoning: NonNullable<OpenAIResponsesRequestBody["reasoning"]> = {}
    if (req.effort && model.capabilities.effort.levels.includes(req.effort)) {
      reasoning.effort = req.effort as "low" | "medium" | "high"
    }
    // Visible summary deltas opt-in
    if (
      (req.thinking?.mode === "adaptive" || req.thinking?.mode === "extended") &&
      (req.thinking.display === "visible" || req.thinking.display === "summary") &&
      model.capabilities.thinking.visible
    ) {
      reasoning.summary = "auto"
    }
    if (Object.keys(reasoning).length > 0) body.reasoning = reasoning
  }

  // Output format
  if (req.outputFormat) {
    if (req.outputFormat.type === "json_schema") {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: req.outputFormat.name ?? "response",
          schema: req.outputFormat.schema,
          strict: req.outputFormat.strict,
        },
      }
    } else {
      body.response_format = {
        type: req.outputFormat.type === "json_object" ? "json_object" : "text",
      }
    }
  }

  // Max output tokens
  if (req.generation?.maxOutputTokens !== undefined) {
    body.max_output_tokens = Math.min(
      req.generation.maxOutputTokens,
      model.capabilities.maxOutputTokens,
    )
  }

  body.stream = req.stream ?? true

  // OpenAI vendor opts
  const vendor = req.vendor?.openai
  if (vendor?.parallelToolCalls !== undefined) body.parallel_tool_calls = vendor.parallelToolCalls
  if (vendor?.store !== undefined) body.store = vendor.store
  if (vendor?.include) body.include = vendor.include
  if (vendor?.user) body.user = vendor.user
  if (req.metadata?.custom) body.metadata = { ...req.metadata.custom }

  return body
}

function buildInstructions(req: CanonicalRequest): string {
  if (!req.system || req.system.length === 0) return ""
  return req.system
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n\n")
}

function buildInputItems(req: CanonicalRequest): OpenAIResponsesInputItem[] {
  const items: OpenAIResponsesInputItem[] = []
  for (const msg of req.messages) {
    appendCanonicalMessage(items, msg)
  }
  return items
}

function appendCanonicalMessage(items: OpenAIResponsesInputItem[], msg: CanonicalMessage): void {
  if (msg.role === "tool") {
    for (const block of msg.content) {
      if (block.type === "tool_result") {
        const text = block.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .filter(Boolean)
          .join("\n")
        items.push({
          type: "function_call_output",
          call_id: block.toolUseId,
          output: text,
        })
      }
    }
    return
  }

  // Collect tool_use blocks → function_call items. Text/image → message item.
  const parts: OpenAIResponsesMessageItem["content"] = []
  for (const block of msg.content) {
    switch (block.type) {
      case "text":
        parts.push({
          type: msg.role === "assistant" ? "output_text" : "input_text",
          text: block.text,
        })
        break
      case "image":
        if (block.source.kind === "url") {
          parts.push({
            type: "input_image",
            image_url: block.source.url,
            detail: block.source.detail,
          })
        } else if (block.source.kind === "base64") {
          parts.push({
            type: "input_image",
            image_url: `data:${block.source.mediaType};base64,${block.source.data}`,
            detail: block.source.detail,
          })
        } else if (block.source.kind === "file_id") {
          // OpenAI Responses accepts an uploaded image by file id.
          parts.push({
            type: "input_image",
            file_id: block.source.fileId,
            detail: block.source.detail,
          })
        }
        break
      case "file":
        if (block.source.kind === "file_id") {
          parts.push({ type: "input_file", file_id: block.source.fileId })
        }
        break
      case "tool_use":
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: typeof block.input === "string" ? block.input : JSON.stringify(block.input),
        })
        break
      case "tool_result": {
        const text = block.content
          .map((c) => (c.type === "text" ? c.text : ""))
          .filter(Boolean)
          .join("\n")
        items.push({
          type: "function_call_output",
          call_id: block.toolUseId,
          output: text,
        })
        break
      }
      case "thinking":
      case "audio":
        // Not represented as input items on Responses.
        break
    }
  }
  if (parts.length > 0) {
    items.push({
      type: "message",
      role:
        msg.role === "user"
          ? "user"
          : msg.role === "assistant"
            ? "assistant"
            : msg.role === "system"
              ? "system"
              : "developer",
      content: parts,
    })
  }
}

function toResponsesTool(tool: CanonicalToolDefinition): OpenAIResponsesTool {
  if (tool.server) {
    return mapServerTool(tool.server)
  }
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema as object,
    strict: tool.strict,
  }
}

function mapServerTool(id: ServerToolId): OpenAIResponsesTool {
  switch (id) {
    case "web_search":
      return { type: "web_search_preview" }
    case "code_interpreter":
      return { type: "code_interpreter", container: { type: "auto" } }
    case "file_search":
      return { type: "file_search", vector_store_ids: [] }
    case "computer_use":
      return {
        type: "computer_use_preview",
        display_width: 1024,
        display_height: 768,
        environment: "browser",
      }
    case "advisor":
      // Anthropic-only concept; coerce to a no-op (drop) by falling through.
      return { type: "web_search_preview" }
    default: {
      throw new Error(`unhandled server tool: ${String(id satisfies never)}`)
    }
  }
}

function toResponsesToolChoice(choice: ToolChoice): OpenAIResponsesRequestBody["tool_choice"] {
  switch (choice.type) {
    case "auto":
      return "auto"
    case "none":
      return "none"
    case "any":
      return "required"
    case "tool":
      return { type: "function", name: choice.name }
    default: {
      throw new Error(`unhandled tool choice: ${String(choice satisfies never)}`)
    }
  }
}

// Silence unused-import warning when sub-types are referenced via spec docs only.
void (null as unknown as CanonicalBlock | undefined)
