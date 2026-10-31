/**
 * Small helpers extracted from {@link AgentCore} so that file stays under the
 * 810-line gate.
 *
 * @module sdk/agent-core-helpers
 */

import {
  sessionResumedAttachmentText,
  streamInterruptedAttachmentText,
  turnAbortedAttachmentText,
} from "../agent/PROMPTS.ts"
import { buildReflectionCheckpointBlock } from "../agent/reflection.ts"
import type { StatusPort } from "../bus/status-port.ts"
import type { StopReason } from "../llm/canonical-events.ts"
import type { ContentBlock, ToolResultBlock } from "../llm/messages.ts"
import type { RetryPolicyOptions } from "../llm/transport/retry-policy.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"

import type { AgentEvent, EventUsage } from "./events.ts"
import type { HostPorts } from "./host-ports.ts"
import { takeQueuedText } from "./host-ports.ts"
import type { PromptContributor } from "./ports.ts"

export type MaybePromise<T> = T | Promise<T>

/**
 * Apply the construction-time `statusPort` default (S23) unless the retry
 * policy already names its own.
 */
export function withDefaultStatusPort(
  policy: RetryPolicyOptions,
  fallback: StatusPort | undefined,
): RetryPolicyOptions {
  return policy.statusPort === undefined && fallback ? { ...policy, statusPort: fallback } : policy
}

/** The empty response a turn reports before any model response arrived. */
export const EMPTY_RESPONSE: StreamedResponse = { blocks: [], text: "", stopReason: null }

/**
 * The `item_started` / `item_completed` pair for each text, tool_use, and
 * thinking block. The id is the tool_use id for a tool call (so the later
 * tool_result joins on it), or `${round}:${i}` for text and thinking.
 */
export function itemEvents(blocks: StreamedResponse["blocks"], round: number): AgentEvent[] {
  const out: AgentEvent[] = []
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block === undefined) continue
    if (block.type !== "text" && block.type !== "tool_use" && block.type !== "thinking") continue
    const itemType = block.type
    const id = block.type === "tool_use" ? block.id : `${round}:${i}`
    const text =
      block.type === "tool_use"
        ? block.name
        : block.type === "text"
          ? block.text
          : (block.thinking ?? "")
    out.push({
      type: "item_started",
      itemType,
      id,
      // `label` is the pre-S19 field name; `toolName` is the declared one
      // (spec S19). Both carry the same value until phase 5 exit (S37).
      ...(block.type === "tool_use" ? { label: block.name, toolName: block.name } : {}),
    })
    out.push({ type: "item_completed", itemType, id, text })
  }
  return out
}

/** Canonical stop-reason bridge: transport already emits the union. */
export function toEventStopReason(stopReason: string | null): StopReason | null {
  return stopReason as StopReason | null
}

/**
 * Project a transport usage snapshot onto the host-facing {@link EventUsage}
 * shape (the four counters a `--json` consumer reports). Missing counters
 * default to 0 so `turn_completed.usage` is always a complete object, per the
 * frozen event contract (usage is REQUIRED on turn_completed).
 */
export function toEventUsage(usage: StreamedResponse["usage"] | undefined): EventUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    ...(usage?.cache_read_input_tokens !== undefined
      ? { cacheReadTokens: usage.cache_read_input_tokens }
      : {}),
    ...(usage?.cache_creation_input_tokens !== undefined
      ? { cacheCreationTokens: usage.cache_creation_input_tokens }
      : {}),
  }
}

/** The pieces {@link buildInitialUserContent} needs from the core. */
export interface InitialUserContentDeps {
  modeProvider?: { consumePendingAttachment?(): ContentBlock | null } | null
  promptContributors: PromptContributor[]
  mediaResolver?: { resolveUserContent(text: string): Promise<ContentBlock[]> } | null
}

/**
 * Build a turn's initial user content: orphan-repair results, then the
 * runtime marker (abort / session-resumed), the mode attachment, turn
 * attachments, save echoes, and finally the user's own text (resolved
 * through the media resolver when one is wired). Skipped entirely by the
 * caller on an S50 round-level `resume` (nothing new was typed).
 */
export async function buildInitialUserContent(
  deps: InitialUserContentDeps,
  opts: {
    userText: string
    orphanRepair: ToolResultBlock[]
    turnMarker: "aborted" | "resumed" | null
  },
): Promise<ContentBlock[]> {
  const content: ContentBlock[] = [...opts.orphanRepair]
  if (opts.turnMarker === "aborted") {
    content.push({ type: "text", text: turnAbortedAttachmentText() })
  } else if (opts.turnMarker === "resumed") {
    content.push({ type: "text", text: sessionResumedAttachmentText() })
  }
  const modeAttach = deps.modeProvider?.consumePendingAttachment?.() ?? null
  if (modeAttach) content.push(modeAttach)
  for (const contributor of deps.promptContributors) {
    for (const b of contributor.turnAttachments?.() ?? []) content.push(b)
  }
  for (const contributor of deps.promptContributors) {
    for (const e of contributor.saveEchoes?.() ?? []) content.push(e)
  }
  if (opts.userText.length > 0) {
    if (deps.mediaResolver) {
      content.push(...(await deps.mediaResolver.resolveUserContent(opts.userText)))
    } else {
      content.push({ type: "text", text: opts.userText })
    }
  }
  return content
}

/** The pieces {@link nextRoundContent} needs from the core. */
export interface NextRoundContentDeps {
  modeProvider?: { consumePendingAttachment?(): ContentBlock | null } | null
  promptContributors: PromptContributor[]
  sessionPersistence?: { appendUser(content: ContentBlock[]): string } | null
  reflectionInterval: number
  reflectionCooldownMs: number
  reflectionSilenceRemaining: number
}

/**
 * The user message after a tool round: tool results, then the salvage
 * attachment, the mode attachment, save echoes, queued host text (through
 * the `inputQueue` port), and the reflection checkpoint when one is due
 * (through the `reflectionGate` port). Returns the content plus the new
 * `reflectionSilenceRemaining`, since a due-but-silenced checkpoint
 * decrements it, and `queuedText` (when any was injected) so the caller can
 * emit its `user_message` event (S18).
 */
export async function nextRoundContent(
  deps: NextRoundContentDeps,
  toolResults: ToolResultBlock[],
  salvaged: boolean,
  round: number,
  ports: HostPorts,
): Promise<{
  content: ContentBlock[]
  reflectionSilenceRemaining: number
  queuedText: string | null
}> {
  const content: ContentBlock[] = [...toolResults]
  if (salvaged) content.push({ type: "text", text: streamInterruptedAttachmentText() })
  const modeAttach = deps.modeProvider?.consumePendingAttachment?.() ?? null
  if (modeAttach) content.push(modeAttach)
  for (const contributor of deps.promptContributors) {
    for (const e of contributor.saveEchoes?.() ?? []) content.push(e)
  }
  const queuedText = takeQueuedText(ports.inputQueue)
  if (queuedText) {
    content.push({ type: "text", text: queuedText })
    deps.sessionPersistence?.appendUser([{ type: "text", text: queuedText }])
    ports.inputQueue?.injected?.(queuedText)
  }
  let reflectionSilenceRemaining = deps.reflectionSilenceRemaining
  if (deps.reflectionInterval > 0 && round % deps.reflectionInterval === 0) {
    if (reflectionSilenceRemaining > 0) {
      reflectionSilenceRemaining -= 1
    } else {
      await ports.reflectionGate?.beforeCheckpoint(round)
      content.push(buildReflectionCheckpointBlock(round, deps.reflectionCooldownMs))
    }
  }
  return { content, reflectionSilenceRemaining, queuedText }
}
