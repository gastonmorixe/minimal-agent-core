/**
 * Canonical → Ollama native `/api/chat` request body.
 *
 * Ollama's chat API (https://docs.ollama.com, https://github.com/ollama/ollama
 * /blob/main/docs/api.md) is its OWN wire format, not OpenAI- or
 * Anthropic-shaped:
 *
 * - `messages[]`: `{role, content, thinking?, images?, tool_calls?, tool_name?}`.
 *   `role ∈ {system, user, assistant, tool}`. `content` is a plain string.
 *   Images are base64 strings in a per-message `images[]` array (no data: URI
 *   prefix). Tool results come back as `role:"tool"` with the result text in
 *   `content` and the originating `tool_name`.
 * - `tools[]`: `{type:"function", function:{name, description, parameters}}`.
 * - `think`: `true|false` to toggle the reasoning trace, or a string level
 *   (`"low"|"medium"|"high"`) for models with discrete reasoning effort
 *   (gpt-oss). The trace streams back as `message.thinking`.
 * - `options`: sampling knobs (`temperature`, `top_p`, `top_k`, `seed`, `stop`,
 *   `num_predict`, `num_ctx`).
 * - `format`: `"json"` or a JSON-schema object for structured output.
 * - `stream`: boolean; the stream is newline-delimited JSON (NDJSON), not SSE.
 *
 * This builder owns the whole translation; it shares NO code with the OpenAI or
 * Anthropic wire layers (the architecture rule: a provider plugin is
 * self-contained).
 *
 * @module llm/providers/ollama/request-body
 */

import type {
  CanonicalBlock,
  CanonicalMessage,
  ImageBlock,
} from "@minimal-agent/plugin-api/llm/canonical-messages"
import type { CanonicalRequest } from "@minimal-agent/plugin-api/llm/canonical-request"
import type {
  CanonicalToolDefinition,
  ToolChoice,
} from "@minimal-agent/plugin-api/llm/canonical-tools"
import type { EffortLevel } from "@minimal-agent/plugin-api/llm/capabilities"
import type { ModelView } from "@minimal-agent/plugin-api/types/host-capabilities"

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

export interface OllamaToolCall {
  function: {
    name: string
    /** Ollama sends/accepts already-parsed arguments as an object. */
    arguments: Record<string, unknown>
  }
}

export interface OllamaWireMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string
  /** Reasoning trace (assistant turns from a thinking model). */
  thinking?: string
  /** Base64 image payloads (no data: URI prefix). */
  images?: string[]
  /** Assistant tool-call requests. */
  tool_calls?: OllamaToolCall[]
  /** On `role:"tool"` results: the tool that produced this output. */
  tool_name?: string
}

export interface OllamaTool {
  type: "function"
  function: {
    name: string
    description?: string
    parameters: object
  }
}

export interface OllamaRequestOptions {
  temperature?: number
  top_p?: number
  top_k?: number
  seed?: number
  stop?: string[]
  /** Max output tokens. */
  num_predict?: number
  /** Context window size to allocate. */
  num_ctx?: number
}

export interface OllamaChatRequestBody {
  model: string
  messages: OllamaWireMessage[]
  stream: boolean
  tools?: OllamaTool[]
  /** `true|false` or a discrete effort level for reasoning-effort models. */
  think?: boolean | EffortLevel
  /** `"json"` or a JSON-schema object for structured output. */
  format?: "json" | object
  options?: OllamaRequestOptions
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Build the Ollama `/api/chat` request body from a canonical request. Maps
 * messages, tools, thinking, sampling, and output-format onto Ollama's native
 * wire shape.
 */
export function buildOllamaChatBody(
  req: CanonicalRequest,
  model: ModelView,
): OllamaChatRequestBody {
  const body: OllamaChatRequestBody = {
    model: model.vendorIds?.firstParty ?? req.modelId,
    messages: buildOllamaMessages(req),
    stream: req.stream ?? true,
  }

  // Tools (user-defined only; Ollama has no server tools we map).
  if (req.tools && req.tools.length > 0) {
    const tools = req.tools.filter((t) => !t.server).map(toOllamaTool)
    if (tools.length > 0) body.tools = tools
  }

  // Thinking. A model with discrete effort levels (gpt-oss) takes a string
  // level; an adaptive-thinking model takes a boolean. `mode:"off"` disables.
  body.think = resolveThink(req, model)

  // Output format (structured output).
  if (req.outputFormat) {
    const fmt = toOllamaFormat(req.outputFormat)
    if (fmt !== undefined) body.format = fmt
  }

  // Sampling + token limits → options block (omit when empty).
  const options = buildOptions(req, model)
  if (options) body.options = options

  return body
}

/**
 * Resolve the `think` field. Returns `undefined` (omit) when the model does not
 * think or the caller neither asked for nor disabled it.
 */
function resolveThink(req: CanonicalRequest, model: ModelView): boolean | EffortLevel | undefined {
  const caps = model.capabilities
  const canThink = caps.thinking.adaptive || caps.effort.levels.length > 0
  if (!canThink) return undefined

  // Explicit disable wins.
  if (req.thinking?.mode === "off") return false

  // `req.thinking` is now either undefined or an "on" mode (adaptive/extended).
  const askedToThink = req.thinking !== undefined

  // Discrete reasoning-effort models (gpt-oss): pass the level string.
  if (caps.effort.levels.length > 0) {
    if (req.effort && caps.effort.levels.includes(req.effort)) return req.effort
    // Asked to think but no/invalid level → default level.
    if (askedToThink) return caps.effort.default
    return undefined
  }

  // Adaptive-thinking models: boolean toggle.
  if (askedToThink) return true
  return undefined
}

function buildOptions(req: CanonicalRequest, model: ModelView): OllamaRequestOptions | undefined {
  const caps = model.capabilities
  const gen = req.generation
  const options: OllamaRequestOptions = {}
  let any = false
  if (gen?.temperature !== undefined && caps.acceptsTemperature) {
    options.temperature = gen.temperature
    any = true
  }
  if (gen?.topP !== undefined && caps.acceptsTopP) {
    options.top_p = gen.topP
    any = true
  }
  if (gen?.topK !== undefined && caps.acceptsTopK) {
    options.top_k = gen.topK
    any = true
  }
  if (gen?.seed !== undefined && caps.acceptsSeed) {
    options.seed = gen.seed
    any = true
  }
  if (gen?.stop && gen.stop.length > 0 && caps.acceptsStopSequences) {
    options.stop = gen.stop
    any = true
  }
  if (gen?.maxOutputTokens !== undefined) {
    options.num_predict = Math.min(gen.maxOutputTokens, caps.maxOutputTokens)
    any = true
  }
  return any ? options : undefined
}

/**
 * Flatten canonical messages into Ollama wire messages. The system prefix
 * (`req.system`) becomes a leading `role:"system"` message; tool_result blocks
 * become `role:"tool"` messages; assistant tool_use blocks become `tool_calls`.
 */
function buildOllamaMessages(req: CanonicalRequest): OllamaWireMessage[] {
  const out: OllamaWireMessage[] = []

  if (req.system && req.system.length > 0) {
    const text = blocksToText(req.system)
    if (text) out.push({ role: "system", content: text })
  }

  for (const msg of req.messages) {
    appendMessage(out, msg)
  }
  return out
}

function appendMessage(out: OllamaWireMessage[], msg: CanonicalMessage): void {
  // role:"tool" canonical message (OpenAI-style) → Ollama tool message.
  if (msg.role === "tool") {
    out.push({
      role: "tool",
      content: blocksToText(msg.content),
      ...(msg.toolCallId ? { tool_name: msg.toolCallId } : {}),
    })
    return
  }

  // tool_result blocks (canonical pairing lives in a user message) → each a
  // separate Ollama role:"tool" message.
  const toolResults = msg.content.filter((b) => b.type === "tool_result")
  if (toolResults.length > 0) {
    for (const tr of toolResults) {
      if (tr.type !== "tool_result") continue
      out.push({
        role: "tool",
        content: tr.content.map((c) => (c.type === "text" ? c.text : "")).join("\n"),
        tool_name: tr.toolUseId,
      })
    }
    const rest = msg.content.filter((b) => b.type !== "tool_result")
    if (rest.length === 0) return
    appendMessage(out, { ...msg, content: rest })
    return
  }

  if (msg.role === "system") {
    out.push({ role: "system", content: blocksToText(msg.content) })
    return
  }

  // user / assistant.
  const wire: OllamaWireMessage = {
    role: msg.role === "user" ? "user" : "assistant",
    content: "",
  }
  const textParts: string[] = []
  const thinkingParts: string[] = []
  const images: string[] = []
  const toolCalls: OllamaToolCall[] = []

  for (const block of msg.content) {
    if (block.type === "text") {
      textParts.push(block.text)
    } else if (block.type === "thinking") {
      if (block.text) thinkingParts.push(block.text)
    } else if (block.type === "image") {
      const b64 = imageToBase64(block)
      if (b64) images.push(b64)
    } else if (block.type === "tool_use") {
      toolCalls.push({
        function: {
          name: block.name,
          arguments: toArgsObject(block.input),
        },
      })
    }
    // redacted_thinking / audio / file: Ollama's chat API has no slot; drop.
  }

  wire.content = textParts.join("")
  if (thinkingParts.length > 0) wire.thinking = thinkingParts.join("")
  if (images.length > 0) wire.images = images
  if (toolCalls.length > 0) wire.tool_calls = toolCalls
  out.push(wire)
}

function blocksToText(blocks: CanonicalBlock[]): string {
  return blocks
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n\n")
}

/** Extract a base64 image payload (no data: URI prefix) from an image block. */
function imageToBase64(block: ImageBlock): string | null {
  const src = block.source
  if (src.kind === "base64") return src.data
  // url / file_id sources can't be inlined as base64 for Ollama; skip.
  return null
}

function toArgsObject(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object") return input as Record<string, unknown>
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input)
      if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>
    } catch {
      // fall through
    }
  }
  return {}
}

function toOllamaTool(tool: CanonicalToolDefinition): OllamaTool {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema as object,
    },
  }
}

function toOllamaFormat(
  fmt: NonNullable<CanonicalRequest["outputFormat"]>,
): "json" | object | undefined {
  if (fmt.type === "json_schema") return fmt.schema
  if (fmt.type === "json_object") return "json"
  return undefined
}

// `ToolChoice` is part of the canonical surface but Ollama's chat API exposes
// no tool_choice knob, so it is intentionally not translated. Referenced here
// to document the deliberate omission.
export type { ToolChoice }
