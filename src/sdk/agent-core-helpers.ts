/**
 * Small helpers extracted from {@link AgentCore} so that file stays under the
 * 810-line gate.
 *
 * @module sdk/agent-core-helpers
 */

import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import { createSyntheticTextResolver, textBlockOrNull } from "../agent/synthetic-text.ts"
import {
  sessionResumedText,
  streamInterruptedText,
  turnAbortedText,
} from "../agent/synthetic-texts.ts"
import type {
  ModelAdoptedNotice,
  ModelAdoptFailedNotice,
  TurnNotice,
} from "../agent/turn-notice.ts"
import type { StatusPort } from "../bus/status-port.ts"
import type { CacheTtl } from "../cache/cache-ttl.ts"
import { validateEffortForModel } from "../config/effort-resolution.ts"
import type { StopReason } from "../llm/canonical-events.ts"
import type { ContentBlock, ToolResultBlock } from "../llm/messages.ts"
import {
  findModel,
  findModelForProvider,
  resolveModel,
  resolveModelForProvider,
} from "../llm/model-registry.ts"
import { findProviderPlugin } from "../llm/provider-plugin.ts"
import { resolveSystemPromptForModel } from "../llm/system-prompt.ts"
import type { SystemPromptOverrides } from "../llm/system-prompt-overrides.ts"
import type { RetryPolicyOptions } from "../llm/transport/retry-policy.ts"
import { normalizeModelForAPI, type StreamedResponse } from "../llm/transport/types.ts"
import { NO_SIDEBAND } from "../sideband/api.ts"
import type { SidebandApi } from "../sideband/types.ts"

import type { AgentEvent, EventUsage } from "./events.ts"
import type { HookContextEntry } from "./hook-context.ts"
import type { HostPorts, PendingCompact } from "./host-ports.ts"
import { takeQueuedText } from "./host-ports.ts"
import type {
  AgentCoreConfig,
  MediaResolveContext,
  MediaResolver,
  PromptContributor,
} from "./ports.ts"
import { placeFirstMessageContext, type SessionContextTake } from "./session-context.ts"
import { copyInput } from "./tool-facts.ts"

export type MaybePromise<T> = T | Promise<T>

/** A notice dispatch sink: `AgentCore.run` emits each notice as a `notice` event. */
export type NoticeEmitter = (notice: TurnNotice) => void

/**
 * `Math.floor(value)` when `value` is a number of 0 or more, else
 * `fallback` (a negative value or a non-number is ignored).
 */
export function flooredOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && value >= 0 ? Math.floor(value) : fallback
}

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
 * The `compactWithLifecycle` fields that come from `AgentCore.compact`'s
 * caller-supplied `opts`, plus the core's `pluginEvents` port (S28) and
 * synthetic text resolver (15d.3a) when set. Split out so the method body
 * only lists the fields that need `this`.
 */
export function compactOptsArgs(
  opts?: import("../agent/context-compact.ts").CompactRequestOpts,
  pluginEvents?: import("../bus/plugin-events-port.ts").PluginEventsPort,
  text?: SyntheticTextResolver,
): Record<string, unknown> {
  return {
    ...(pluginEvents ? { pluginEvents } : {}),
    ...(text ? { text } : {}),
    reason: opts?.reason,
    preferRemote: opts?.preferRemote,
    ...(opts?.mode ? { mode: opts.mode } : {}),
    ...(opts?.keepTail !== undefined ? { keepTail: opts.keepTail } : {}),
    ...(opts?.focus ? { focus: opts.focus } : {}),
    ...(opts?.signal ? { signal: opts.signal } : {}),
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
      // `toolName` is the tool name (spec S19). The json and stream-json
      // encoders add the old `label` key on the wire (decision 38).
      // `input` is a copy (spec C2), so a sink cannot reach history through it.
      ...(block.type === "tool_use" ? { toolName: block.name, input: copyInput(block.input) } : {}),
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
 * shape. `inputTokens` and `outputTokens` default to 0, so
 * `turn_completed.usage` is always a complete object, per the frozen event
 * contract (usage is REQUIRED on turn_completed). Optional counters stay
 * absent when the provider did not report them.
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
    ...(usage?.output_tokens_details?.thinking_tokens !== undefined
      ? { reasoningTokens: usage.output_tokens_details.thinking_tokens }
      : {}),
  }
}

/** The pieces {@link buildInitialUserContent} needs from the core. */
export interface InitialUserContentDeps {
  modeProvider?: { consumePendingAttachment?(): ContentBlock | null } | null
  promptContributors: PromptContributor[]
  mediaResolver?: Pick<MediaResolver, "resolveUserContent"> | null
  /** The core's diagnostics handle, given to the media resolver per call (S20). */
  diagnostics?: MediaResolveContext["diagnostics"]
  /** The core's synthetic text resolver (markers, media texts). Omitted: "" (no provider). */
  text?: SyntheticTextResolver
  /** The core's live model, given to the media resolver per call. */
  model?: string
  /** The core's sideband API: renders the `policy` tags of the hook context. Omitted: none. */
  sideband?: Pick<SidebandApi, "render">
}

/**
 * Build a turn's initial user content: orphan-repair results, then the
 * runtime marker (abort / session-resumed), the mode attachment, turn
 * attachments, save echoes, and finally the user's own text (resolved
 * through the media resolver when one is wired). Skipped entirely by the
 * caller on an S50 round-level `resume` (nothing new was typed).
 *
 * Hook context: `session` (the session context take) and `turnContext` (the
 * `turn.willStart` entries) go around the user text, see
 * {@link placeFirstMessageContext}.
 */
export async function buildInitialUserContent(
  deps: InitialUserContentDeps,
  opts: {
    userText: string
    orphanRepair: ToolResultBlock[]
    turnMarker: "aborted" | "resumed" | null
    session?: SessionContextTake
    turnContext?: readonly HookContextEntry[] | undefined
  },
): Promise<ContentBlock[]> {
  const content: ContentBlock[] = [...opts.orphanRepair]
  // A marker with no text (bare core: no provider owns the kind) adds no
  // block: an empty text block is invalid on some providers (follow-up 15b).
  const marker =
    opts.turnMarker === "aborted"
      ? turnAbortedText(deps.text)
      : opts.turnMarker === "resumed"
        ? sessionResumedText(deps.text)
        : ""
  if (marker) content.push({ type: "text", text: marker })
  const modeAttach = deps.modeProvider?.consumePendingAttachment?.() ?? null
  if (modeAttach) content.push(modeAttach)
  for (const contributor of deps.promptContributors) {
    for (const b of contributor.turnAttachments?.() ?? []) content.push(b)
  }
  for (const contributor of deps.promptContributors) {
    for (const e of contributor.saveEchoes?.() ?? []) content.push(e)
  }
  const userAt = content.length
  if (opts.userText.length > 0) {
    if (deps.mediaResolver) {
      const ctx = {
        ...(deps.diagnostics ? { diagnostics: deps.diagnostics } : {}),
        ...(deps.text ? { syntheticText: deps.text } : {}),
        ...(deps.model ? { modelId: deps.model } : {}),
      }
      content.push(...(await deps.mediaResolver.resolveUserContent(opts.userText, ctx)))
    } else {
      content.push({ type: "text", text: opts.userText })
    }
  }
  placeFirstMessageContext(
    deps.sideband ?? NO_SIDEBAND,
    content,
    userAt,
    opts.session ?? { before: "", after: "" },
    opts.turnContext,
  )
  return content
}

/** What {@link buildTurnSystemPrompt} reads from the core. */
export interface TurnSystemDeps {
  model: string
  providerId?: string
  promptContributors: readonly PromptContributor[]
  /** The executor writes raw-output blobs: send the tool-output-conventions slot. */
  blobStoreEnabled: boolean
  cacheTtl: CacheTtl
  overrides: SystemPromptOverrides | undefined
}

/**
 * Resolve a turn's system blocks from the prompt contributors. Hook session
 * context never goes here (it rides the first user message), so the system
 * bytes and the cache prefix stay stable.
 */
export function buildTurnSystemPrompt(deps: TurnSystemDeps) {
  const afterParts: string[] = []
  const sessionParts: string[] = []
  for (const contributor of deps.promptContributors) {
    for (const b of contributor.afterInstructionsBlocks?.() ?? []) {
      if (b.type === "text" && b.text) afterParts.push(b.text)
    }
    for (const b of contributor.systemPromptBlocks?.() ?? []) {
      if (b.type === "text" && b.text) sessionParts.push(b.text)
    }
  }
  return resolveSystemPromptForModel(normalizeModelForAPI(deps.model), {
    afterInstructions: afterParts.length > 0 ? afterParts.join("\n") : undefined,
    sessionContext: sessionParts.length > 0 ? sessionParts.join("\n") : undefined,
    blobStoreEnabled: deps.blobStoreEnabled,
    cacheTtl: deps.cacheTtl,
    ...(deps.providerId ? { providerId: deps.providerId } : {}),
    overrides: deps.overrides,
  })
}

/** The pieces {@link nextRoundContent} needs from the core. */
export interface NextRoundContentDeps {
  modeProvider?: { consumePendingAttachment?(): ContentBlock | null } | null
  promptContributors: PromptContributor[]
  sessionPersistence?: { appendUser(content: ContentBlock[]): string } | null
  /** The core's synthetic text resolver for the attachments. Omitted: "" (no provider). */
  text?: SyntheticTextResolver
}

/**
 * The user message after a tool round: tool results, then the salvage
 * attachment, the mode attachment, save echoes, queued host text (through
 * the `inputQueue` port). Returns the content plus `queuedText` (when any
 * was injected) so the caller can emit its `user_message` event (S18).
 */
export async function nextRoundContent(
  deps: NextRoundContentDeps,
  toolResults: ToolResultBlock[],
  salvaged: boolean,
  ports: HostPorts,
): Promise<{
  content: ContentBlock[]
  queuedText: string | null
}> {
  const content: ContentBlock[] = [...toolResults]
  // A synthetic text that is "" (no provider) adds no block (follow-up 15e.1c).
  const salvageNote = salvaged ? textBlockOrNull(streamInterruptedText(deps.text)) : null
  if (salvageNote) content.push(salvageNote)
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
  return { content, queuedText }
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
 * the new model. The lookup uses the base id without a `[1m]` / `[2m]`
 * suffix ({@link normalizeModelForAPI}), the same as
 * {@link effortLevelsForModel}. The returned `model` keeps the raw id, so
 * the suffix still selects the large context window. Throws on an unknown
 * model; the caller must not assign anything to its own state until this
 * returns, so a throw leaves model and effort unchanged.
 */
export function resolveModelChange(
  model: string,
  providerId: string | undefined,
  currentEffort: string | undefined,
): ModelChange {
  const apiModel = normalizeModelForAPI(model)
  const entry = providerId ? resolveModelForProvider(apiModel, providerId) : resolveModel(apiModel)
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
  notice: ModelAdoptedNotice | ModelAdoptFailedNotice | null
}

/**
 * The preflight `adoptModelId` auto-adoption's own checked path
 * (`AgentCore.runPreflight`): a no-op when `adoptModelId` is absent or
 * already the current model; otherwise the same validated
 * {@link resolveModelChange} the public `setModel` setter uses, plus the
 * `model_adopted` notice — emitted on EVERY automatic change where
 * `to !== from`, so a client watching the notice stream never keeps a
 * stale model value.
 *
 * A provider preflight can name a live-only model that the static
 * registry does not know. So when the lookup fails, the provider plugin
 * first gets a chance to register the id ad hoc
 * (`ProviderPlugin.registerAdHocModel`, the same step startup does for
 * `--model`). When the id is still unknown, this never throws: it keeps
 * the current model and effort and returns a `model_adopt_failed` warn
 * notice, so the turn goes on.
 */
export function adoptModel(
  model: string,
  providerId: string | undefined,
  effort: string | undefined,
  adoptModelId: string | undefined,
): ModelAdoption {
  if (!adoptModelId || adoptModelId === model) return { model, effort, notice: null }
  let change: ModelChange
  try {
    change = resolveAdoptedModel(adoptModelId, providerId, effort)
  } catch (e) {
    return {
      model,
      effort,
      notice: {
        kind: "model_adopt_failed",
        severity: "warn",
        model,
        requested: adoptModelId,
        reason: e instanceof Error ? e.message : String(e),
      },
    }
  }
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

/**
 * {@link resolveModelChange}, with one retry after the provider plugin
 * registers an unknown id ad hoc. Throws when the id is still unknown.
 */
function resolveAdoptedModel(
  model: string,
  providerId: string | undefined,
  effort: string | undefined,
): ModelChange {
  try {
    return resolveModelChange(model, providerId, effort)
  } catch (e) {
    const plugin = providerId ? findProviderPlugin(providerId) : undefined
    if (!plugin?.registerAdHocModel) throw e
    plugin.registerAdHocModel(normalizeModelForAPI(model))
    return resolveModelChange(model, providerId, effort)
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

/**
 * The sideband API and the one synthetic text resolver of a core (design
 * step 5). The API is `config.sideband`, else `NO_SIDEBAND`. The resolver is
 * the host's (the loader's) when given, else one built here from the
 * providers that gives the API to each provider as the third argument.
 *
 * Thus an explicit `sideband` (e.g. `BuildAgentCoreDeps.sideband`) reaches
 * the providers only with explicit providers. With a host resolver (the
 * loader's, used when the caller gives no providers), each provider gets the
 * API of that resolver (the loader's `sideband()`), not `config.sideband`.
 * `loader.sideband-contexts.test.ts` pins this.
 */
export function coreTextOf(
  config: AgentCoreConfig,
  diagnostics: Parameters<typeof createSyntheticTextResolver>[1],
): {
  sb: NonNullable<AgentCoreConfig["sideband"]>
  text: NonNullable<AgentCoreConfig["syntheticTextResolver"]>
} {
  const sideband = config.sideband ?? NO_SIDEBAND
  const syntheticText =
    config.syntheticTextResolver ??
    createSyntheticTextResolver(config.syntheticTextProviders ?? [], diagnostics, () => sideband)
  return { sb: sideband, text: syntheticText }
}
