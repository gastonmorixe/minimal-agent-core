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
import type { ModelAdoptedNotice, TurnNotice } from "../agent/turn-notice.ts"
import type { StatusPort } from "../bus/status-port.ts"
import { validateEffortForModel } from "../config/effort-resolution.ts"
import type { StopReason } from "../llm/canonical-events.ts"
import type { ContentBlock, ToolResultBlock } from "../llm/messages.ts"
import {
  findModel,
  findModelForProvider,
  resolveModel,
  resolveModelForProvider,
} from "../llm/model-registry.ts"
import type { RetryPolicyOptions } from "../llm/transport/retry-policy.ts"
import { normalizeModelForAPI, type StreamedResponse } from "../llm/transport/types.ts"

import type { AgentEvent, EventUsage } from "./events.ts"
import type { HostPorts, PendingCompact } from "./host-ports.ts"
import { takeQueuedText } from "./host-ports.ts"
import type { PromptContributor } from "./ports.ts"
import { copyInput } from "./tool-facts.ts"

export type MaybePromise<T> = T | Promise<T>

/** A notice dispatch sink, as `AgentCore.run`'s `onNotice` wires it internally. */
export type NoticeEmitter = (notice: TurnNotice) => void

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

/**
 * The `compactWithLifecycle` fields that come only from `AgentCore.compact`'s
 * caller-supplied `opts` (no `this` access needed), split out so the method
 * body only lists the fields that DO need `this`.
 */
export function compactOptsArgs(
  opts?: import("../agent/context-compact.ts").CompactRequestOpts,
): Record<string, unknown> {
  return {
    reason: opts?.reason,
    preferRemote: opts?.preferRemote,
    ...(opts?.mode ? { mode: opts.mode } : {}),
    ...(opts?.keepTail !== undefined ? { keepTail: opts.keepTail } : {}),
    ...(opts?.focus ? { focus: opts.focus } : {}),
    ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
    ...(opts?.writeStream ? { writeStream: opts.writeStream } : {}),
    ...(opts?.onSummaryAttempt ? { onSummaryAttempt: opts.onSummaryAttempt } : {}),
  }
}

/**
 * Narrow a queued {@link PendingCompact} plugin request into `AgentCore.compact`'s
 * options, validating the loose string fields against `compact()`'s own
 * literal unions (an invalid value is dropped rather than forwarded).
 */
export function compactArgsFromPending(
  pending: PendingCompact,
): import("../agent/context-compact.ts").CompactRequestOpts {
  const { reason, mode } = pending
  return {
    ...(reason === "manual" || reason === "auto" || reason === "exceeded" ? { reason } : {}),
    ...(mode === "remote" || mode === "tail" || mode === "local" || mode === "fork"
      ? { mode }
      : {}),
    ...(pending.keepTail !== undefined ? { keepTail: pending.keepTail } : {}),
    ...(pending.focus ? { focus: pending.focus } : {}),
  }
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
      // `input` is a copy (spec C2), so a sink cannot reach history through it.
      ...(block.type === "tool_use"
        ? { label: block.name, toolName: block.name, input: copyInput(block.input) }
        : {}),
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

/**
 * Result of a validated model (+ effort fit) change, shared by
 * `AgentCore.setModel` and the preflight `adoptModelId` auto-adoption.
 */
export interface ModelChange {
  model: string
  effort: string | undefined
  /** `true` when the model change also reset the effort to the model default. */
  effortReset: boolean
  /** The effort level that was reset, or `undefined` when nothing was reset. */
  effortFrom: string | undefined
}

/**
 * Validate `model` against the registry — scoped to `providerId` when set
 * (same-provider switching only, agent-core.ts:149/198/496), else globally
 * via {@link resolveModel} — and resolve what `currentEffort` becomes on
 * the new model. Throws on an unknown model; the caller must not assign
 * anything to its own state until this returns, so a throw leaves model
 * and effort unchanged.
 */
export function resolveModelChange(
  model: string,
  providerId: string | undefined,
  currentEffort: string | undefined,
): ModelChange {
  const entry = providerId ? resolveModelForProvider(model, providerId) : resolveModel(model)
  if (currentEffort === undefined) {
    return { model, effort: undefined, effortReset: false, effortFrom: undefined }
  }
  const validation = validateEffortForModel(currentEffort, entry.capabilities.effort.levels)
  if (validation.ok) {
    return { model, effort: currentEffort, effortReset: false, effortFrom: undefined }
  }
  return { model, effort: undefined, effortReset: true, effortFrom: currentEffort }
}

/** What the preflight `adoptModelId` auto-adoption changes, as one step. */
export interface ModelAdoption {
  model: string
  effort: string | undefined
  /** `null` when `adoptModelId` was absent or already the current model (no change, no notice). */
  notice: ModelAdoptedNotice | null
}

/**
 * The preflight `adoptModelId` auto-adoption's own checked path
 * (`AgentCore.runPreflight`): a no-op when `adoptModelId` is absent or
 * already the current model; otherwise the same validated
 * {@link resolveModelChange} the public `setModel` setter uses, plus the
 * `model_adopted` notice — emitted on EVERY automatic change where
 * `to !== from`, so a client watching the notice stream never keeps a
 * stale model value.
 */
export function adoptModel(
  model: string,
  providerId: string | undefined,
  effort: string | undefined,
  adoptModelId: string | undefined,
): ModelAdoption {
  if (!adoptModelId || adoptModelId === model) return { model, effort, notice: null }
  const change = resolveModelChange(adoptModelId, providerId, effort)
  return {
    model: change.model,
    effort: change.effort,
    notice: {
      kind: "model_adopted",
      severity: "info",
      from: model,
      to: change.model,
      effortReset: change.effortReset,
      effortFrom: change.effortFrom ?? null,
    },
  }
}

/** Effort levels the given model id declares (`[]` when unresolved). */
export function effortLevelsForModel(
  model: string,
  providerId: string | undefined,
): readonly string[] {
  const apiModel = normalizeModelForAPI(model)
  const entry = providerId
    ? (findModelForProvider(apiModel, providerId) ?? findModel(apiModel))
    : findModel(apiModel)
  return entry?.capabilities.effort.levels ?? []
}

/**
 * Validate `effort` against `model`'s declared effort levels with
 * {@link validateEffortForModel}; throws on an unsupported value
 * (including any explicit value when the model declares none).
 */
export function resolveEffortChange(
  effort: string | undefined,
  model: string,
  providerId: string | undefined,
): string | undefined {
  const validation = validateEffortForModel(effort, effortLevelsForModel(model, providerId))
  if (!validation.ok) throw new Error(validation.reason)
  return effort
}
