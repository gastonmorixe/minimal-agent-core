/**
 * Bridge between the legacy `src/client.ts` `SendOptions` / `StreamedResponse`
 * surface and the canonical `CanonicalRequest` / `CanonicalEvent` surface.
 *
 * Why this exists: `client.ts` carries ~1500 lines of carefully tuned
 * cross-cutting infrastructure (stream-idle watchdog, hard-timeout
 * watchdog, retry coordinator with overloaded/api categorization,
 * 401 keychain-first refresh, network activity observer, cache anomaly
 * detector, status-bus updates, rate-limit broadcaster). Rewriting all
 * of that against the canonical layer is high-risk; this bridge lets
 * the legacy transport keep running while exposing a canonical
 * surface to new callers (OpenAI adapter, future agent migrations).
 *
 * Two functions:
 *
 * - {@link canonicalToSendOptions}: translate a `CanonicalRequest` plus
 *   capability-aware hooks into the legacy `SendOptions` shape. Used
 *   when a canonical caller wants the legacy transport's reliability.
 *
 * - {@link sendOptionsToCanonical}: wrap a legacy `sendMessage` /
 *   `sendMessageFull` call site so it yields canonical events. Useful
 *   when migrating consumers piece by piece.
 *
 * Both are **stateless**. The mid-stream callback hooks
 * (`onThinkingDelta`, `onTextStop`, etc.) become canonical events
 * fired through a passed-in async generator.
 *
 * @module llm/adapter-legacy
 */

import type { AuthResult } from "../auth.ts"
import type {
  ContentBlock as LegacyContentBlock,
  Message as LegacyMessage,
  SendOptions as LegacySendOptions,
  StreamedResponse as LegacyStreamedResponse,
} from "../client.ts"
import type { SystemBlock } from "../headers.ts"

import type { CanonicalEvent, CanonicalUsage, StopDetails, StopReason } from "./canonical-events.ts"
import type { CanonicalBlock, CanonicalMessage } from "./canonical-messages.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import type { CanonicalToolDefinition } from "./canonical-tools.ts"

// ---------------------------------------------------------------------------
// canonical → legacy SendOptions
// ---------------------------------------------------------------------------

export interface CanonicalToLegacyOpts {
  /** Authenticated credentials in the legacy shape. */
  auth: AuthResult
  /** Pre-built system prompt (legacy `SystemBlock[]`). */
  system?: SystemBlock[]
  /** Optional network client override (tests). */
  networkClient?: LegacySendOptions["networkClient"]
  /** Optional cancellation signal forwarded to the transport. */
  signal?: AbortSignal
}

/**
 * Build a legacy `SendOptions` from a `CanonicalRequest`. Used when
 * the canonical layer wants to delegate transport to `sendMessage`.
 *
 * NOT a perfect 1:1 conversion — provider-neutral fields the legacy
 * client doesn't understand (e.g. `previousResponseId`, OpenAI-only
 * vendor opts) are silently dropped. The Anthropic-specific
 * `vendor.anthropic.*` opts are forwarded via the closest legacy
 * equivalent (e.g. `contextManagement` → `SendOptions.contextManagement`).
 */
export function canonicalToSendOptions(
  req: CanonicalRequest,
  opts: CanonicalToLegacyOpts,
): LegacySendOptions {
  const out: LegacySendOptions = {
    auth: opts.auth,
    messages: req.messages.map(canonicalMessageToLegacy),
    model: req.modelId,
    stream: req.stream ?? true,
  }
  if (opts.system) out.system = opts.system
  if (req.tools && req.tools.length > 0) out.tools = req.tools.map(canonicalToolToLegacy)
  if (req.generation?.maxOutputTokens !== undefined) {
    out.maxTokens = req.generation.maxOutputTokens
  }
  if (req.generation?.temperature !== undefined) {
    out.temperature = req.generation.temperature
  }
  // Thinking → legacy `{type:"adaptive", display?}` shape. Legacy doesn't
  // accept the canonical "off"/"extended" union directly; we map.
  if (req.thinking) {
    if (req.thinking.mode === "off") {
      out.thinking = false
    } else if (req.thinking.mode === "adaptive") {
      out.thinking = {
        type: "adaptive",
        display: req.thinking.display === "omitted" ? "omitted" : "summarized",
      }
    } else {
      // Extended-budget mode isn't representable in legacy SendOptions
      // beyond {type:"adaptive"}. Drop the budget hint with a debug log.
      out.thinking = { type: "adaptive" }
    }
  }
  if (req.effort) out.outputConfig = { effort: req.effort }
  if (req.outputFormat?.type === "json_schema") {
    out.outputConfig = {
      ...(out.outputConfig ?? {}),
      format: { type: "json_schema", schema: req.outputFormat.schema },
    }
  }
  if (req.vendor?.anthropic?.contextManagement !== undefined) {
    out.contextManagement = req.vendor.anthropic.contextManagement
  }
  if (opts.networkClient) out.networkClient = opts.networkClient
  if (opts.signal) out.signal = opts.signal
  if (req.streamIdleTimeoutMs !== undefined) out.streamIdleTimeoutMs = req.streamIdleTimeoutMs
  if (req.attemptHardTimeoutMs !== undefined) out.attemptHardTimeoutMs = req.attemptHardTimeoutMs
  return out
}

// ---------------------------------------------------------------------------
// legacy StreamedResponse → canonical events
// ---------------------------------------------------------------------------

/**
 * Translate a completed legacy `StreamedResponse` into the canonical
 * event sequence the agent loop would have seen on the wire. Useful
 * for tests + for piping a buffered legacy response through canonical
 * consumers.
 *
 * Does NOT emit incremental deltas (the legacy structured response is
 * already coalesced). Callers wanting streaming should use the wrap
 * helper in `runLegacyAsCanonical` below instead.
 */
export function streamedResponseToCanonicalEvents(
  resp: LegacyStreamedResponse,
  modelId: string,
): CanonicalEvent[] {
  const events: CanonicalEvent[] = []
  const messageId = "msg_legacy"
  const initialUsage: CanonicalUsage = { inputTokens: 0, outputTokens: 0 }
  events.push({
    type: "message_start",
    messageId,
    modelId,
    initialUsage,
  })
  let blockIndex = 0
  for (const block of resp.blocks) {
    switch (block.type) {
      case "text":
        events.push({ type: "text_start", index: blockIndex })
        if (block.text) events.push({ type: "text_delta", index: blockIndex, text: block.text })
        events.push({ type: "text_stop", index: blockIndex, finalText: block.text })
        blockIndex++
        break
      case "thinking":
        events.push({ type: "thinking_start", index: blockIndex })
        if (block.thinking) {
          events.push({ type: "thinking_delta", index: blockIndex, text: block.thinking })
        }
        if (block.signature) {
          events.push({ type: "thinking_signature", index: blockIndex, signature: block.signature })
        }
        events.push({ type: "thinking_stop", index: blockIndex })
        blockIndex++
        break
      case "tool_use":
        events.push({
          type: "tool_use_start",
          index: blockIndex,
          id: block.id,
          name: block.name,
        })
        // Surface the fully-assembled input as a single "delta" so consumers
        // that accumulate by JSON fragment still see it.
        const partial = JSON.stringify(block.input)
        events.push({ type: "tool_use_input_delta", index: blockIndex, partialJson: partial })
        events.push({ type: "tool_use_stop", index: blockIndex, input: block.input })
        blockIndex++
        break
      // tool_result blocks never appear in an assistant response;
      // they're user-message blocks. Skip if encountered.
      default:
        break
    }
  }
  events.push({
    type: "message_delta",
    stopReason: mapLegacyStopReason(resp.stopReason),
    stopDetails: null,
    usage: initialUsage,
  })
  events.push({ type: "message_stop" })
  return events
}

// ---------------------------------------------------------------------------
// canonical message ↔ legacy message
// ---------------------------------------------------------------------------

function canonicalMessageToLegacy(msg: CanonicalMessage): LegacyMessage {
  // Mid-conversation `role:"system"` collapses to a single string;
  // the legacy client doesn't support the role yet, so we approximate
  // by prepending a marker prefix on a user message. Callers that
  // need true mid-conv system should use the canonical path directly.
  if (msg.role === "system") {
    return {
      role: "user",
      content: [
        {
          type: "text",
          text: `<system-instruction>\n${msg.content
            .filter((b): b is { type: "text"; text: string } => b.type === "text")
            .map((b) => b.text)
            .join("\n")}\n</system-instruction>`,
        },
      ],
    }
  }
  if (msg.role === "tool") {
    // canonical role:"tool" maps to legacy role:"user" with tool_result block(s).
    return {
      role: "user",
      content: msg.content.map(canonicalBlockToLegacy).filter(Boolean) as LegacyContentBlock[],
    }
  }
  return {
    role: msg.role,
    content: msg.content.map(canonicalBlockToLegacy).filter(Boolean) as LegacyContentBlock[],
  }
}

function canonicalBlockToLegacy(block: CanonicalBlock): LegacyContentBlock | null {
  switch (block.type) {
    case "text":
      return {
        type: "text",
        text: block.text,
        ...(block.cache && { cache_control: legacyCacheControl(block.cache) }),
      }
    case "thinking":
      return {
        type: "thinking",
        thinking: block.text,
        signature: block.signature ?? "",
        ...(block.cache && { cache_control: legacyCacheControl(block.cache) }),
      }
    case "tool_use":
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
        ...(block.cache && { cache_control: legacyCacheControl(block.cache) }),
      }
    case "tool_result": {
      const inner = block.content
        .map(canonicalBlockToLegacy)
        .filter(Boolean) as LegacyContentBlock[]
      const content: string | LegacyContentBlock[] =
        inner.length === 1 && inner[0]?.type === "text" ? inner[0].text : inner
      return {
        type: "tool_result",
        tool_use_id: block.toolUseId,
        is_error: block.isError,
        content,
        ...(block.cache && { cache_control: legacyCacheControl(block.cache) }),
      }
    }
    case "image":
    case "audio":
    case "file":
      // Legacy ContentBlock doesn't support these (image is server-side
      // only via different route). Drop.
      return null
    default: {
      const _exhaustive: never = block
      throw new Error(`unhandled canonical block: ${_exhaustive}`)
    }
  }
}

function legacyCacheControl(hint: NonNullable<CanonicalBlock["cache"]>): {
  type: "ephemeral"
  ttl?: "5m" | "1h"
  scope?: "global"
} {
  const out: { type: "ephemeral"; ttl?: "5m" | "1h"; scope?: "global" } = { type: "ephemeral" }
  if (hint.ttl) out.ttl = hint.ttl
  if (hint.scope) out.scope = hint.scope
  return out
}

function canonicalToolToLegacy(tool: CanonicalToolDefinition): {
  name: string
  description: string
  input_schema: unknown
} {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

function mapLegacyStopReason(reason: string | null): StopReason | null {
  switch (reason) {
    case null:
      return null
    case "end_turn":
      return "end_turn"
    case "tool_use":
      return "tool_use"
    case "max_tokens":
      return "max_tokens"
    case "stop_sequence":
      return "stop_sequence"
    case "refusal":
      return "refusal"
    case "pause_turn":
      return "pause_turn"
    default:
      return "error"
  }
}

// ---------------------------------------------------------------------------
// runLegacyAsCanonical — live streaming bridge
// ---------------------------------------------------------------------------

/**
 * Run a legacy `sendMessage` (or `sendMessageOnce`) call site and
 * yield canonical events live, as the underlying stream progresses.
 *
 * The supplied `legacyRunner` is the legacy iterator factory; we wrap
 * it with text-block tracking + a final `MessageDeltaEvent`.
 *
 * **Limitation**: the legacy client doesn't separately surface
 * thinking-block start/stop events on its iterator — only via the
 * callback hooks (`onThinkingDelta`, `onThinkingStop`). To get faithful
 * thinking events here you need to wire those into the
 * `onThinkingDelta` / `onTextStop` / etc. callbacks on the underlying
 * SendOptions and have them push into a shared queue we drain.
 *
 * For the OpenAI adapter we use this bridge only as a fallback — its
 * primary path is its own native SSE translator (see
 * `providers/openai/`).
 *
 * @yields Canonical events reconstructed from the legacy stream + callback queue.
 */
export async function* runLegacyAsCanonical(opts: {
  legacyRun: () => AsyncGenerator<string, LegacyStreamedResponse, undefined>
  modelId: string
  /** Stream events captured by the legacy callbacks. Pre-populated by the caller. */
  eventQueue?: AsyncIterable<CanonicalEvent>
}): AsyncIterable<CanonicalEvent> {
  // Emit a synthetic message_start.
  yield {
    type: "message_start",
    messageId: "msg_legacy",
    modelId: opts.modelId,
    initialUsage: { inputTokens: 0, outputTokens: 0 },
  }
  // If the caller pre-wired callbacks into a queue, drain it concurrently.
  if (opts.eventQueue) {
    for await (const ev of opts.eventQueue) yield ev
  } else {
    // Otherwise emit text deltas as one synthetic text block.
    let textIndex: number | null = null
    const gen = opts.legacyRun()
    while (true) {
      const next = await gen.next()
      if (next.done) {
        const resp = next.value
        if (textIndex !== null) {
          yield { type: "text_stop", index: textIndex }
        }
        // Surface tool_use blocks from the structured response.
        let blockIdx = (textIndex ?? -1) + 1
        for (const block of resp.blocks) {
          if (block.type === "tool_use") {
            yield {
              type: "tool_use_start",
              index: blockIdx,
              id: block.id,
              name: block.name,
            }
            yield {
              type: "tool_use_input_delta",
              index: blockIdx,
              partialJson: JSON.stringify(block.input),
            }
            yield { type: "tool_use_stop", index: blockIdx, input: block.input }
            blockIdx++
          }
        }
        yield {
          type: "message_delta",
          stopReason: mapLegacyStopReason(resp.stopReason),
          stopDetails: null,
          usage: { inputTokens: 0, outputTokens: 0 },
        }
        break
      }
      const chunk = next.value
      if (chunk && textIndex === null) {
        textIndex = 0
        yield { type: "text_start", index: textIndex }
      }
      if (chunk && textIndex !== null) {
        yield { type: "text_delta", index: textIndex, text: chunk }
      }
    }
  }
  yield { type: "message_stop" }
}

// ---------------------------------------------------------------------------
// Re-exports for test ergonomics
// ---------------------------------------------------------------------------

export type { StopDetails, StopReason }
