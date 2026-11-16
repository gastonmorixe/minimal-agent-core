/**
 * Request codec: agent {@link SendOptions} to a {@link CanonicalRequest}.
 *
 * The agent loop builds one `SendOptions` per model step. The canonical
 * transport hands a `CanonicalRequest` to the provider adapter. This module
 * maps the request fields only. Transport fields (`auth`, `networkClient`,
 * the lifecycle hooks) are not part of the request: the transport threads
 * them into the `RunContext` and the stream assembler.
 *
 * @module llm/codec/request-codec
 */

import type { CanonicalRequest, ThinkingConfig } from "../canonical-request.ts"
import type { CanonicalToolDefinition } from "../canonical-tools.ts"
import type { EffortLevel } from "../capabilities.ts"
import { getDefaultModelId } from "../model-registry.ts"
import type { SendOptions } from "../transport/types.ts"

import { messageToCanonical, systemTextToCanonical } from "./message-codec.ts"

/** Longest `outputFormat.name` (OpenAI `json_schema.name` rule). */
const OUTPUT_FORMAT_NAME_MAX = 64

/**
 * Stable `outputFormat.name` for a JSON Schema: its `title` when that is a
 * string, else `"output"`. Every char outside `[a-zA-Z0-9_-]` becomes `_`,
 * and the result is cut to 64 chars. An empty result falls back to
 * `"output"`. Provider builders decide whether to send it.
 */
export function outputFormatName(schema: object): string {
  const title = (schema as { title?: unknown }).title
  const raw = typeof title === "string" ? title : ""
  const name = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, OUTPUT_FORMAT_NAME_MAX)
  return name.length > 0 ? name : "output"
}

/**
 * Agent thinking option to canonical {@link ThinkingConfig}. Display
 * `"summarized"` is canonical `"summary"` (the Anthropic body mapper maps it back).
 */
function thinkingToCanonical(thinking: SendOptions["thinking"]): ThinkingConfig | undefined {
  if (thinking === undefined) return undefined
  if (thinking === false) return { mode: "off" }
  if (thinking.display === undefined) return { mode: "adaptive" }
  return { mode: "adaptive", display: thinking.display === "omitted" ? "omitted" : "summary" }
}

function outputFormatToCanonical(
  format: NonNullable<SendOptions["outputConfig"]>["format"],
): CanonicalRequest["outputFormat"] {
  if (format?.type !== "json_schema" || !format.schema) return undefined
  const schema = format.schema as object
  // `strict` rides the send format (`sdk/output-config.ts`). The transport
  // type does not declare it, so read it structurally.
  const strict = (format as { strict?: unknown }).strict === true
  return {
    type: "json_schema",
    schema,
    name: outputFormatName(schema),
    ...(strict ? { strict: true } : {}),
  }
}

/**
 * Map agent {@link SendOptions} to a {@link CanonicalRequest}. `modelId`
 * falls back to the default model when unset. `Agent.run` always sets it.
 */
export function sendOptionsToCanonical(opts: SendOptions): CanonicalRequest {
  const req: CanonicalRequest = {
    modelId: opts.model ?? getDefaultModelId(),
    messages: opts.messages.map(messageToCanonical),
    stream: opts.stream ?? true,
  }
  if (opts.selectedProviderId) req.providerId = opts.selectedProviderId
  // Providers classify a title request only by this marker.
  if (opts.requestType === "title") req.purpose = "title"
  if (opts.system) req.system = opts.system.map(systemTextToCanonical)
  if (opts.tools && opts.tools.length > 0) {
    // M8: a tool with no text omits `description`. The canonical type keeps
    // the key required for the provider plugins; JSON drops the missing key.
    req.tools = opts.tools.map(
      (t) =>
        ({
          name: t.name,
          ...(t.description === undefined ? {} : { description: t.description }),
          inputSchema: t.input_schema as CanonicalToolDefinition["inputSchema"],
        }) as CanonicalToolDefinition,
    )
  }
  const generation: NonNullable<CanonicalRequest["generation"]> = {}
  if (opts.maxTokens !== undefined) generation.maxOutputTokens = opts.maxTokens
  if (opts.temperature !== undefined) generation.temperature = opts.temperature
  if (Object.keys(generation).length > 0) req.generation = generation
  const thinking = thinkingToCanonical(opts.thinking)
  if (thinking) req.thinking = thinking
  if (opts.outputConfig?.effort) req.effort = opts.outputConfig.effort as EffortLevel
  const outputFormat = outputFormatToCanonical(opts.outputConfig?.format)
  if (outputFormat) req.outputFormat = outputFormat
  if (opts.speed) req.speed = opts.speed
  if (opts.serviceTier) req.serviceTier = opts.serviceTier
  if (opts.signal) req.signal = opts.signal
  if (opts.streamIdleTimeoutMs !== undefined) req.streamIdleTimeoutMs = opts.streamIdleTimeoutMs
  if (opts.attemptHardTimeoutMs !== undefined) req.attemptHardTimeoutMs = opts.attemptHardTimeoutMs
  return req
}
