/**
 * AgentCore: port-injected agentic loop for the minimal-agent SDK.
 *
 * Extracted from `src/agent.ts` with all CLI/TUI/plugin dependencies
 * replaced by port interfaces from `src/sdk/ports.ts`. The core depends
 * only on structural interfaces; hosts (CLI, SDK, test harness) inject
 * concrete implementations at construction.
 *
 * Design principles (from software-best-design-patterns):
 *   - Dependency Inversion (DIP): core depends on ports, not concretions.
 *   - Functional core, imperative shell: pure logic inside, I/O at edges.
 *   - Single Responsibility: one reason to change (the agentic loop).
 *
 * @module sdk/agent-core
 */

import { withRollingCacheBreakpoint } from "../agent/cache.ts"
import {
  closeInterruptedToolCalls,
  repairOrphanedToolUse as repairOrphanedToolUseImpl,
  rollbackPendingTurn as rollbackPendingTurnImpl,
} from "../agent/history-repair.ts"
import {
  outputTruncatedAttachmentText,
  responseTruncatedPlaceholderText,
  streamInterruptedContinueAttachmentText,
} from "../agent/PROMPTS.ts"
import type { AskUserFn } from "../agent/preflight-pipeline.ts"
import {
  DEFAULT_REFLECTION_COOLDOWN_MS,
  DEFAULT_REFLECTION_INTERVAL,
  parseReflectionAck,
} from "../agent/reflection.ts"
import { createReflectionAckStripper } from "../agent/reflection-ack-stripper.ts"
import { detectStopNotice, type TurnNotice } from "../agent/turn-notice.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { PluginEventsPort } from "../bus/plugin-events-port.ts"
import type { StatusPort } from "../bus/status-port.ts"
import { type CacheTtl, DEFAULT_CACHE_TTL } from "../cache/cache-ttl.ts"
import { type Diagnostics, processDiagnostics } from "../diagnostics/hub.ts"
import {
  clampMaxOutputTokens,
  type EstimableTool,
  estimateRequestInputTokens,
} from "../llm/context-budget.ts"
import { fatalErrorFields } from "../llm/error-hint.ts"
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"
import { findModel, findModelForProvider } from "../llm/model-registry.ts"
import { resolveSystemPromptForModel } from "../llm/system-prompt.ts"
import type { SystemPromptOverrides } from "../llm/system-prompt-overrides.ts"
import { noteRetryRecovered, retryStallMarker } from "../llm/transport/retry.ts"
import {
  type ClassifiedError,
  classifyError,
  type RecoveryAction,
  type RetryPolicyOptions,
  SYSTEM_CLOCK,
} from "../llm/transport/retry-policy.ts"
import { selectedTransport } from "../llm/transport/select-transport.ts"
import type { SystemBlock } from "../llm/transport/types.ts"
import {
  normalizeModelForAPI,
  type SendOptions,
  type StreamBlockEdge,
  type StreamedResponse,
  type TransportFn,
} from "../llm/transport/types.ts"

import {
  adoptModel,
  buildInitialUserContent,
  compactArgsFromPending,
  compactOptsArgs,
  EMPTY_RESPONSE,
  itemEvents,
  type MaybePromise,
  type NoticeEmitter,
  nextRoundContent as nextRoundContentHelper,
  resolveEffortChange,
  resolveModelChange,
  toEventStopReason,
  toEventUsage,
  withDefaultStatusPort,
} from "./agent-core-helpers.ts"
import { appendUserTurn } from "./conversation-history.ts"
import { eventKindFilter } from "./event-filter.ts"
import type { AgentEvent, EventSink } from "./events.ts"
import type { HostPorts } from "./host-ports.ts"
import { runPorts } from "./host-ports.ts"
import { type LifecyclePort, NOOP_LIFECYCLE } from "./lifecycle.ts"
import { outputConfigSpread as buildOutputConfig } from "./output-config.ts"
import type {
  AbortSignalProvider,
  AgentCoreConfig,
  MediaResolver,
  ModeProvider,
  PromptContributor,
  SessionPersistence,
  ToolAdvertisementFilter,
  ToolDefinition,
  ToolExecutor,
  ToolRegistry,
} from "./ports.ts"
import { createPreflightAsk, type PreflightAsk } from "./preflight-ask.ts"
import { type RoundCheckpoint, TURN_START } from "./round-checkpoint.ts"
import { type RecoveryHost, recover, waitToRetry } from "./run-recovery.ts"
import { createSinkGuard, reportSinkError } from "./sink-guard.ts"
import {
  decideNext,
  MAX_INTERRUPTED_TURN_CONTINUATIONS,
  MAX_TOKENS_CONTINUATION_CAP,
  type Streaks,
  type TurnOutcome,
} from "./stop-policy.ts"
import { runToolCalls, type ToolCallHost } from "./tool-calls.ts"
import { wrapTransportWithLifecycle } from "./with-lifecycle-send.ts"

/**
 * What one `AgentCore.run` turn returns: the last model response plus how the
 * turn ended. With outcome `waiting`, `error` is the permanent error that
 * paused the run; the host fixes the cause and starts the next run.
 */
export type TurnResult = StreamedResponse & { outcome: TurnOutcome; error?: unknown }

/** Per-turn request parts that every attempt of every round reuses. */
interface RoundRequest {
  system?: SystemBlock[]
  tools?: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>
  sendOpts: Partial<SendOptions>
  onThinkingDelta?: (text: string) => MaybePromise<void>
  signal?: AbortSignal
  emitDeltas?: boolean
}

/** One attempt: the response, or the thrown error as data. */
type AttemptSend =
  | { kind: "response"; response: StreamedResponse }
  | { kind: "error"; err: unknown; yielded: boolean }

/** The request parts that size the output-token cap. */
type MaxOutputTokensContext = { system?: SystemBlock[]; tools?: EstimableTool[] }

/**
 * Terminal-agnostic agentic loop driven entirely by injected ports.
 *
 * Owns the append-only conversation history and the send/run loop, but depends
 * only on the structural ports in {@link AgentCoreConfig} (tool registry/executor,
 * transcript + event sinks, session persistence, prompt/mode/media providers).
 * No CLI/TUI/plugin imports, no `process` globals. Hosts (CLI, SDK, tests) wire
 * concrete adapters to the ports and construct the core; the same core powers an
 * interactive REPL, a `--json` event stream, or an in-process SDK call.
 */
export class AgentCore {
  readonly messages: Message[] = []
  private model: string
  private providerId?: string
  private credentialName?: string
  private auth: AuthResult
  private effort: string | undefined
  private outputSchema: object | undefined
  private speed: "normal" | "fast"
  private serviceTier: string | undefined
  private thinkingDisplay: "summarized" | "omitted" | undefined
  private sendFn: TransportFn
  private networkClient: import("../network/index.ts").NetworkClient | undefined
  private toolRegistry: ToolRegistry
  private toolFilter: ToolAdvertisementFilter | null
  private toolExecutor: ToolExecutor
  private sessionPersistence: SessionPersistence | null
  private promptContributors: PromptContributor[]
  private modeProvider: ModeProvider | null
  private mediaResolver: MediaResolver | null
  private abortSignalProvider: AbortSignalProvider | null
  private retryPolicy: RetryPolicyOptions
  /** Default `statusPort` / `pluginEvents` (S23, S28) for a call that sets neither. */
  private readonly defaultStatusPort: StatusPort | undefined
  private readonly defaultPluginEvents: PluginEventsPort | undefined
  private reflectionInterval: number = DEFAULT_REFLECTION_INTERVAL
  private reflectionCooldownMs: number = DEFAULT_REFLECTION_COOLDOWN_MS
  private cacheTtl: CacheTtl = DEFAULT_CACHE_TTL
  private systemPromptOverrides: SystemPromptOverrides | undefined
  private reflectionSilenceRemaining = 0
  /** One-shot runtime marker for the next attachments-only continuation turn. */
  private pendingTurnMarker: "aborted" | "resumed" | null = null
  private eventSink: EventSink | null
  /** Injected diagnostics handle (S20): the session scope when a runtime owns this core. */
  private readonly diagnostics: Diagnostics
  /** Which kinds `eventSink` takes (S18); read once from `eventSink.kinds`. */
  private readonly kindFilter: ReturnType<typeof eventKindFilter>
  /** Isolates the event sink. Its first throw emits one `events.sink-error` (S22). */
  private readonly sinkGuard = createSinkGuard((failure) =>
    reportSinkError("eventSink", failure, this.diagnostics),
  )
  private lifecycle: LifecyclePort
  /** The optional host ports this core was built with (S17). */
  private readonly hostPorts: HostPorts
  /** Next `ask_user` id, unique per core across every turn. */
  private askCounter = 0
  /** Where the in-flight (or last paused) turn stands, for round checkpoints (S50). */
  private checkpoint: RoundCheckpoint = TURN_START

  constructor(config: AgentCoreConfig) {
    this.model = config.model
    this.providerId = config.providerId
    this.credentialName = config.credentialName
    this.auth = config.auth
    this.lifecycle = config.lifecycle ?? NOOP_LIFECYCLE
    this.diagnostics = config.diagnostics ?? processDiagnostics()
    this.sendFn = wrapTransportWithLifecycle(config.sendFn ?? selectedTransport, this.lifecycle)
    this.networkClient = config.networkClient
    this.toolRegistry = config.toolRegistry
    this.toolFilter = config.toolFilter ?? null
    this.toolExecutor = config.toolExecutor
    this.sessionPersistence = config.sessionPersistence ?? null
    this.promptContributors = config.promptContributors ?? []
    this.modeProvider = config.modeProvider ?? null
    this.mediaResolver = config.mediaResolver ?? null
    this.abortSignalProvider = config.abortSignalProvider ?? null
    this.eventSink = config.eventSink ?? null
    this.kindFilter = eventKindFilter(this.eventSink)
    this.hostPorts = config.ports ?? {}
    if (config.initialCheckpoint) this.checkpoint = config.initialCheckpoint
    this.retryPolicy = config.retry ?? {}
    this.defaultStatusPort = config.statusPort
    this.defaultPluginEvents = config.pluginEvents
    this.effort = config.effort
    this.outputSchema = config.outputSchema
    this.speed = config.speed === "fast" ? "fast" : "normal"
    this.serviceTier = config.serviceTier
    this.thinkingDisplay = config.thinkingDisplay
    this.cacheTtl = config.cacheTtl ?? DEFAULT_CACHE_TTL
    this.systemPromptOverrides = config.systemPromptOverrides
    if (typeof config.reflectionInterval === "number" && config.reflectionInterval >= 0) {
      this.reflectionInterval = Math.floor(config.reflectionInterval)
    }
    if (typeof config.reflectionCooldownMs === "number" && config.reflectionCooldownMs >= 0) {
      this.reflectionCooldownMs = Math.floor(config.reflectionCooldownMs)
    }
    if (config.initialMessages && config.initialMessages.length > 0) {
      for (const m of config.initialMessages) this.messages.push(m)
    }
  }

  getModel(): string {
    return this.model
  }

  /** Current reasoning effort, or `undefined` for the model default. */
  getEffort(): string | undefined {
    return this.effort
  }

  /**
   * Switch the model for every request from the NEXT model request onward
   * (that can be inside the same turn, after a tool round — an in-flight
   * request keeps its model and effort). Validates `model` against the
   * registry via {@link resolveModelChange}, scoped to {@link providerId}
   * when this core was built with one (same-provider switching only);
   * throws on an unknown model, with model AND effort left unchanged.
   * When the new model does not support the current effort level, the
   * effort resets to the model default (`undefined`) in this same
   * synchronous step — never a half-applied state, and no notice (the
   * caller already knows it changed the model). The automatic preflight
   * adoption path ({@link runPreflight}) shares this same checked logic.
   */
  setModel(model: string): void {
    const change = resolveModelChange(model, this.providerId, this.effort)
    ;({ model: this.model, effort: this.effort } = change)
  }

  /**
   * Switch the reasoning effort for every request from the NEXT model
   * request onward. Validates `effort` against the CURRENT model's
   * declared effort levels ({@link resolveEffortChange}); throws on an
   * unsupported value (including any explicit value when the model
   * declares no effort levels), with state unchanged. `undefined` always
   * passes (the model default).
   */
  setEffort(effort: string | undefined): void {
    this.effort = resolveEffortChange(effort, this.model, this.providerId)
  }

  history(): Message[] {
    return [...this.messages]
  }

  /**
   * Replace model-facing history in place (compaction / preflight).
   * Shared with legacy {@link Agent} via context-compact helpers.
   */
  replaceMessages(next: Message[]): void {
    // Inline to avoid a circular import at module load; the helper is pure.
    this.messages.length = 0
    for (const m of next) this.messages.push(m)
  }

  /**
   * Compact model-facing history:
   * prefer provider remote compact, else local checkpoint.
   */
  async compact(
    opts?: import("../agent/context-compact.ts").CompactRequestOpts,
  ): Promise<import("../agent/context-compact.ts").CompactStats> {
    const { compactWithLifecycle } = await import("./lifecycle-compact.ts")
    return compactWithLifecycle({
      messages: this.messages,
      model: this.model,
      providerId: this.providerId,
      auth: this.auth,
      ...(this.credentialName ? { credentialName: this.credentialName } : {}),
      networkClient: this.networkClient,
      diagnostics: this.diagnostics,
      lifecycle: this.lifecycle,
      ...compactOptsArgs(opts, this.defaultPluginEvents),
      appendNote: (text) => this.sessionPersistence?.appendNote(text),
      appendCompact: (rec) => this.sessionPersistence?.appendCompact?.(rec),
    })
  }

  /**
   * Emit one structured {@link AgentEvent} to the configured sink, if any.
   *
   * Best-effort and NON-THROWING: a sink that throws must never abort the
   * agent loop. `emit` is called from inside `run()` at the lifecycle seams,
   * so a throwing consumer (a broken `--json` writer, a full pipe) is
   * caught by the sink guard. Its first throw emits one `events.sink-error`
   * diagnostic; later throws are counted. No-op when no sink was configured.
   */
  private emit(event: AgentEvent): void {
    const sink = this.eventSink
    if (!sink) return
    if (!this.kindFilter.accepts(event.type)) return
    this.sinkGuard.call(() => sink.emit(event))
  }

  /**
   * Wrap the caller's `onThinkingDelta` so that, on the realtime path
   * (`emitDeltas`), each streamed reasoning chunk is ALSO emitted as a
   * `thinking_delta` event keyed to this turn. When `emitDeltas` is off (the
   * default, buffered `json`, and the frozen golden) the original callback is
   * returned untouched, so transport behavior and the golden event stream are
   * byte-identical. Returns `undefined` when there is nothing to forward AND no
   * deltas to emit, so the send options omit the callback entirely.
   */
  private wrapThinkingDelta(
    inner: ((text: string) => MaybePromise<void>) | undefined,
    emitDeltas: boolean | undefined,
    round: number,
  ): ((text: string) => MaybePromise<void>) | undefined {
    if (!emitDeltas) return inner
    const id = `${round}:thinking`
    return (text: string): MaybePromise<void> => {
      if (text.length > 0) this.emit({ type: "thinking_delta", id, text })
      return inner?.(text)
    }
  }

  /**
   * The transport's block-edge hook for one round on the realtime path: each
   * edge becomes a `block_started` or `block_stopped` event, with the same
   * per-turn id as the block's deltas.
   */
  private blockEdgeEmitter(round: number): (edge: StreamBlockEdge) => void {
    return ({ block, edge }) => {
      const id = `${round}:${block}`
      this.emit({ type: edge === "start" ? "block_started" : "block_stopped", itemType: block, id })
    }
  }

  rollbackPendingTurn(): boolean {
    return rollbackPendingTurnImpl(this.messages)
  }

  notePreviousTurnAborted(): void {
    this.pendingTurnMarker = "aborted"
  }

  /** Request one attachments-only continuation turn, used by `/continue`. */
  noteSessionResumed(): void {
    this.pendingTurnMarker = "resumed"
  }

  /** Persist a free-form session note (metadata; not folded into model history). */
  appendNote(text: string): void {
    this.sessionPersistence?.appendNote(text)
  }

  /** Reflection cooldown duration used by Tier-2 InteractiveSession. */
  getReflectionCooldownMs(): number {
    return this.reflectionCooldownMs
  }

  pushSystemMessage(text: string): void {
    this.messages.push({ role: "system", content: text })
  }

  repairOrphanedToolUse(): ToolResultBlock[] {
    return repairOrphanedToolUseImpl(this.messages, null)
  }

  private resolveMaxOutputTokens(ctx?: MaxOutputTokensContext): number | undefined {
    const apiModel = normalizeModelForAPI(this.model)
    const entry = this.providerId
      ? (findModelForProvider(apiModel, this.providerId) ?? findModel(apiModel))
      : findModel(apiModel)
    if (!entry) return undefined
    const modelMax = entry.capabilities.maxOutputTokens
    const contextWindow = entry.capabilities.contextWindow
    if (!entry.capabilities.outputTokensShareContextWindow) return modelMax
    const inputTokens = estimateRequestInputTokens({
      modelId: apiModel,
      estimateTokens: entry.estimateTokens,
      messages: this.messages,
      ...(ctx?.system ? { system: ctx.system } : {}),
      ...(ctx?.tools ? { tools: ctx.tools } : {}),
    })
    return clampMaxOutputTokens({ modelMax, contextWindow, inputTokens })
  }

  /** What the retry and recovery steps need from this core. */
  private recoveryHost(): RecoveryHost {
    return {
      emitStatus: (status) => this.emit({ type: "status", ...status }),
      compact: (opts) => this.compact(opts),
      diagnostics: this.diagnostics,
      policy: withDefaultStatusPort(this.retryPolicy, this.defaultStatusPort),
    }
  }

  /** What the tool-call step (S19) needs from this core. */
  private toolCallHost(): ToolCallHost {
    return {
      executor: this.toolExecutor,
      persistence: this.sessionPersistence,
      emit: (event) => this.emit(event),
      wantsToolOutput: this.kindFilter.wantsToolOutput,
      // Same clock the retry policy uses (tests inject one so `durationMs` is
      // deterministic there too); defaults to the system clock.
      now: () => (this.retryPolicy.clock ?? SYSTEM_CLOCK).now(),
    }
  }

  /** Stop-table row 1: emit `error` "aborted" and throw `AbortError`. */
  private stopAborted(): never {
    this.emit({ type: "error", message: "aborted" })
    throw Object.assign(new Error("aborted"), { name: "AbortError" })
  }

  /** Append one user message to history and persist it. */
  private appendUserContent(content: ContentBlock[]): void {
    this.messages.push({ role: "user", content })
    this.sessionPersistence?.appendUser(content)
  }

  /**
   * Round checkpoint (S50): remember where the turn stands, and persist it
   * through the session so a crash or a restart can resume the turn at the
   * next round. A no-op on the in-memory side beyond bookkeeping when the
   * host supplies no session persistence, or persistence has no round
   * checkpoint method.
   */
  private checkpointRound(round: number, streaks: Streaks = TURN_START.streaks): void {
    this.checkpoint = { round, streaks }
    this.sessionPersistence?.appendRoundCheckpoint?.(this.checkpoint)
  }

  private emitTurnCompleted(round: number, response: StreamedResponse): void {
    this.emit({
      type: "turn_completed",
      turn: round,
      stopReason: toEventStopReason(response.stopReason),
      usage: toEventUsage(response.usage),
    })
  }

  /**
   * Drain a queued plugin compact request between rounds, from the host's
   * `compactSource` port (S17, S27). Queue-only: never compacts mid-turn.
   * A no-op when the host supplies no port.
   */
  private async drainPendingCompact(ports: HostPorts): Promise<void> {
    const pending = ports.compactSource?.take() ?? null
    if (pending === null) return
    await this.compact(compactArgsFromPending(pending))
  }

  private async runPreflight(preflightAsk: PreflightAsk, emitNotice: NoticeEmitter): Promise<void> {
    const result = await preflightAsk(this.messages, this.model, this.providerId)
    if (result.cancelled) this.stopAborted()
    const adoption = adoptModel(this.model, this.providerId, this.effort, result.adoptModelId)
    ;({ model: this.model, effort: this.effort } = adoption)
    if (adoption.notice) emitNotice(adoption.notice)
    if (result.messages !== this.messages) this.replaceMessages(result.messages)
  }

  /**
   * One send of the current history. Streams the text (reflection acks
   * stripped) and returns the response, or the thrown error as data so the
   * loop can decide from its class.
   *
   * @yields Cleaned text deltas.
   */
  private async *sendAttempt(
    req: RoundRequest,
    round: number,
  ): AsyncGenerator<string, AttemptSend, undefined> {
    const maxOutputTokens = this.resolveMaxOutputTokens({
      ...(req.system ? { system: req.system } : {}),
      ...(req.tools ? { tools: req.tools } : {}),
    })
    // On the realtime path, forward the transport's thinking chunks as
    // `thinking_delta` events too (keyed to this turn). When emitDeltas is
    // off this is exactly the original callback, so transport behavior and
    // the frozen golden are unchanged.
    const onThinkingDelta = this.wrapThinkingDelta(req.onThinkingDelta, req.emitDeltas, round)
    const ackStripper = createReflectionAckStripper()
    let yielded = false
    const out = (text: string): string => {
      yielded = true
      if (req.emitDeltas) this.emit({ type: "text_delta", id: `${round}:text`, text })
      return text
    }
    try {
      const gen = this.sendFn({
        auth: this.auth,
        messages: withRollingCacheBreakpoint(this.messages, this.cacheTtl),
        model: this.model,
        selectedProviderId: this.providerId,
        ...(this.credentialName ? { credentialName: this.credentialName } : {}),
        ...(this.networkClient ? { networkClient: this.networkClient } : {}),
        diagnostics: this.diagnostics,
        ...(req.tools ? { tools: req.tools } : {}),
        ...(req.system ? { system: req.system } : {}),
        ...(maxOutputTokens !== undefined ? { maxTokens: maxOutputTokens } : {}),
        ...buildOutputConfig({ effort: this.effort, outputSchema: this.outputSchema }),
        ...(this.speed === "fast" ? { speed: "fast" as const } : {}),
        ...(this.serviceTier ? { serviceTier: this.serviceTier } : {}),
        ...(this.thinkingDisplay
          ? { thinking: { type: "adaptive" as const, display: this.thinkingDisplay } }
          : {}),
        // Construction-time defaults (S23, S28); a per-call value in
        // req.sendOpts below wins.
        ...(this.defaultStatusPort ? { statusPort: this.defaultStatusPort } : {}),
        ...(this.defaultPluginEvents ? { pluginEvents: this.defaultPluginEvents } : {}),
        ...req.sendOpts,
        ...(onThinkingDelta ? { onThinkingDelta } : {}),
        ...(req.emitDeltas ? { onBlockEdge: this.blockEdgeEmitter(round) } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      })
      while (true) {
        const { done, value } = await gen.next()
        if (done) {
          const tail = ackStripper.flush()
          if (tail.length > 0) yield out(tail)
          return {
            kind: "response",
            response: (value as StreamedResponse | undefined) ?? EMPTY_RESPONSE,
          }
        }
        const cleaned = ackStripper.write(value)
        if (cleaned.length > 0) yield out(cleaned)
      }
    } catch (err) {
      return { kind: "error", err, yielded }
    }
  }

  /**
   * Record a model response: history, session log, the item events, and a
   * reflection ack the model wrote in its text.
   */
  private recordResponse(
    response: StreamedResponse,
    round: number,
    emitNotice: (notice: TurnNotice) => void,
  ): void {
    if (response.blocks.length > 0) {
      this.messages.push({ role: "assistant", content: response.blocks })
      this.sessionPersistence?.appendAssistant(response.blocks, response.stopReason, response.usage)
      for (const ev of itemEvents(response.blocks, round)) this.emit(ev)
    }
    if (this.reflectionInterval > 0 && response.text.length > 0) {
      const ack = parseReflectionAck(response.text)
      if (ack !== null && ack.silenceFor > 0) {
        this.reflectionSilenceRemaining = ack.silenceFor
        emitNotice({
          kind: "reflection_ack",
          severity: "info",
          silenceFor: ack.silenceFor,
          reason: ack.reason,
          fromToolFallback: false,
        })
      }
    }
  }

  /** A reflection ack sent as a `reflection-ack` tool call (fallback path). */
  private noteReflectionAckTool(
    toolBlocks: ToolUseBlock[],
    emitNotice: (notice: TurnNotice) => void,
  ): void {
    if (this.reflectionSilenceRemaining !== 0 || this.reflectionInterval <= 0) return
    const ackTool = toolBlocks.find((b) => b.name === "reflection-ack")
    if (!ackTool) return
    const silenceForRaw = ackTool.input["silence-for"]
    const reason = typeof ackTool.input.reason === "string" ? ackTool.input.reason : ""
    const silenceFor =
      typeof silenceForRaw === "string"
        ? Number.parseInt(silenceForRaw, 10)
        : typeof silenceForRaw === "number"
          ? Math.floor(silenceForRaw)
          : 1
    if (Number.isFinite(silenceFor) && silenceFor > 0) {
      this.reflectionSilenceRemaining = silenceFor
      emitNotice({
        kind: "reflection_ack",
        severity: "info",
        silenceFor,
        reason,
        fromToolFallback: true,
      })
    }
  }

  /**
   * The user message after a tool round (see {@link nextRoundContentHelper}
   * in `./agent-core-helpers.ts`). Writes back the reflection silence
   * countdown that building it may have decremented.
   */
  private async nextRoundContent(
    toolResults: ToolResultBlock[],
    salvaged: boolean,
    round: number,
    ports: HostPorts,
  ): Promise<ContentBlock[]> {
    const { content, reflectionSilenceRemaining, queuedText } = await nextRoundContentHelper(
      {
        modeProvider: this.modeProvider,
        promptContributors: this.promptContributors,
        sessionPersistence: this.sessionPersistence,
        reflectionInterval: this.reflectionInterval,
        reflectionCooldownMs: this.reflectionCooldownMs,
        reflectionSilenceRemaining: this.reflectionSilenceRemaining,
      },
      toolResults,
      salvaged,
      round,
      ports,
    )
    this.reflectionSilenceRemaining = reflectionSilenceRemaining
    if (queuedText) this.emit({ type: "user_message", text: queuedText, queued: true })
    return content
  }

  /**
   * Run one turn. A fatal non-abort throw is emitted as an `error` event,
   * then rethrown. Either way, `run_finished` closes the run (stop-table
   * row 1: `error` "aborted", then `run_finished`).
   */
  async *run(
    userText: string,
    opts?: Partial<SendOptions> & {
      signal?: AbortSignal
      askUser?: AskUserFn
      /**
       * Opt in to realtime token-delta events (`text_delta` / `thinking_delta`)
       * and their `block_started` / `block_stopped` edges on the
       * {@link EventSink}. OFF by default so the buffered `json` mode and
       * the frozen SDK golden (which do not opt in) see no deltas — only the
       * live `stream-json` path passes `true`. Additive: when off, the emitted
       * event stream is byte-identical to before Phase 3.
       */
      emitDeltas?: boolean
      /**
       * Continue the turn a permanent error paused (outcome `waiting`), or
       * that a crash or a restart left unfinished, from its last completed
       * round checkpoint (S50) instead of starting a new turn. `userText`
       * is ignored when the checkpoint has rounds already: the host fixed
       * the cause and nothing new was typed.
       */
      resume?: boolean
    },
  ): AsyncGenerator<string, TurnResult, undefined> {
    let aborted = false
    try {
      const result = yield* this.runTurn(userText, opts)
      this.emit({ type: "run_finished", outcome: result.outcome })
      return result
    } catch (err) {
      const fields = fatalErrorFields(err)
      if (fields) this.emit({ type: "error", ...fields })
      aborted = err instanceof Error && err.name === "AbortError"
      this.emit({ type: "run_finished", outcome: aborted ? "aborted" : "failed" })
      throw err
    } finally {
      // Decision 31: a user abort clears the round checkpoint, so a resume
      // never continues a turn the user cancelled. A crash keeps it.
      aborted ||= Boolean(opts?.signal?.aborted)
      if (aborted && this.checkpoint.round > 0) this.checkpointRound(0)
    }
  }

  private async *runTurn(...[userText, opts]: Parameters<AgentCore["run"]>) {
    // The block-edge hook is the core's own seam to the transport (it
    // becomes `block_started` / `block_stopped` events). A host value is
    // dropped here, so it never reaches the transport.
    const { signal, askUser, emitDeltas, resume, onBlockEdge: _hostEdge, ...sendOpts } = opts ?? {}
    const onThinkingDelta = sendOpts.onThinkingDelta
    // Surface a semantic {@link TurnNotice} as a `notice` event only. The
    // host renders it (the CLI styles it, `--json` prints it as data).
    const emitNotice = (notice: TurnNotice): void => {
      this.emit({ type: "notice", notice })
    }

    // The host's optional ports (S17). A per-run `askUser` wins over the
    // built port for this one run.
    const ports = runPorts(this.hostPorts, { askUser })
    const preflightAsk = createPreflightAsk({
      port: ports.askUser,
      nextAskId: () => `ask:${this.askCounter++}`,
      emit: (event) => this.emit(event),
      emitNotice,
      signal,
      diagnostics: this.diagnostics,
    })

    // S50: `resume` continues an unfinished turn (a crash, a restart, or a
    // permanent error cut it) from its last completed round checkpoint. That
    // round's send-ready history is on disk, so no new user content is built
    // or appended. `userText` is skipped: nothing new was typed.
    const resuming = Boolean(resume) && this.checkpoint.round > 0
    let initialUserContent: ContentBlock[] = []
    // Decision 31: a tool call that ran at a kill gets a synthetic error
    // result. It never runs again by itself. The model checks its effects.
    if (resuming) {
      for (const b of closeInterruptedToolCalls(this.messages)) {
        this.sessionPersistence?.appendToolResult(b)
      }
    }

    if (!resuming) {
      // Runtime markers follow orphan-repair results because tool_result
      // blocks must be immediately after their matching tool_use.
      const orphanRepair = this.repairOrphanedToolUse()
      const turnMarker = this.pendingTurnMarker
      this.pendingTurnMarker = null
      initialUserContent = await buildInitialUserContent(
        {
          modeProvider: this.modeProvider,
          promptContributors: this.promptContributors,
          mediaResolver: this.mediaResolver,
          diagnostics: this.diagnostics,
        },
        { userText, orphanRepair, turnMarker },
      )

      appendUserTurn(this.messages, initialUserContent)

      const userRecordContent =
        orphanRepair.length > 0
          ? initialUserContent.filter((b) => b.type !== "tool_result")
          : initialUserContent
      if (userRecordContent.length > 0) {
        this.sessionPersistence?.appendUser(userRecordContent)
      }
      if (userText.length > 0) this.emit({ type: "user_message", text: userText })
    }

    const afterParts: string[] = []
    const sessionParts: string[] = []
    for (const contributor of this.promptContributors) {
      for (const b of contributor.afterInstructionsBlocks?.() ?? []) {
        if (b.type === "text" && b.text) afterParts.push(b.text)
      }
      for (const b of contributor.systemPromptBlocks?.() ?? []) {
        if (b.type === "text" && b.text) sessionParts.push(b.text)
      }
    }

    const system = resolveSystemPromptForModel(normalizeModelForAPI(this.model), {
      afterInstructions: afterParts.length > 0 ? afterParts.join("\n") : undefined,
      sessionContext: sessionParts.length > 0 ? sessionParts.join("\n") : undefined,
      reflectionInterval: this.reflectionInterval,
      reflectionCooldownMs: this.reflectionCooldownMs,
      blobStoreEnabled: false,
      cacheTtl: this.cacheTtl,
      ...(this.providerId ? { providerId: this.providerId } : {}),
      overrides: this.systemPromptOverrides,
    })

    const allTools: ToolDefinition[] = this.toolRegistry.list()
    // Advertisement-time filter (CLI `--tools` / SDK allow-list). Mode
    // gating is deliberately NOT applied here — modes keep the tool schema
    // byte-stable and refuse at dispatch. Prefer `config.toolFilter`; the
    // deprecated ModeProvider.filterTools is a last-resort fallback only.
    const advertisedTools =
      this.toolFilter?.filter(allTools) ?? this.modeProvider?.filterTools?.(allTools) ?? allTools

    const mergedTools: Array<{
      name: string
      description: string
      input_schema: Record<string, unknown>
    }> = advertisedTools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }))

    const req: RoundRequest = {
      system,
      tools: mergedTools,
      sendOpts,
      ...(onThinkingDelta ? { onThinkingDelta } : {}),
      ...(signal ? { signal } : {}),
      ...(emitDeltas ? { emitDeltas } : {}),
    }
    const clock = this.retryPolicy.clock ?? SYSTEM_CLOCK
    let rounds = resuming ? this.checkpoint.round : 0
    let streaks: Streaks = resuming ? this.checkpoint.streaks : { maxTokens: 0, interrupted: 0 }
    this.reflectionSilenceRemaining = 0
    let outcome: TurnOutcome = "completed"
    let pausedOn: ClassifiedError | undefined
    let lastResponse: StreamedResponse = EMPTY_RESPONSE

    // The one agent loop. Each round sends the history, streams the
    // response, runs tool calls, and asks `decideNext` what to do next.
    // Nothing here counts rounds or retries toward a limit.
    rounds: for (;;) {
      if (signal?.aborted) this.stopAborted()
      await this.drainPendingCompact(ports)
      rounds++
      // A new assistant turn (one model response) begins. `turn` is the
      // monotonic round index per the frozen event contract.
      this.emit({ type: "turn_started", turn: rounds })
      await this.runPreflight(preflightAsk, emitNotice)

      // Send the round. A retry or a recovery sends the same history again.
      const recoveriesTried: RecoveryAction[] = []
      const startedAt = clock.now()
      let lastCause = "unknown"
      let response: StreamedResponse | undefined
      for (let attempt = 1; response === undefined; attempt++) {
        const sent = yield* this.sendAttempt(req, rounds)
        if (sent.kind === "response") {
          if (attempt > 1) {
            noteRetryRecovered(this.diagnostics, attempt - 1, clock.now() - startedAt, lastCause)
          }
          response = sent.response
          break
        }
        if (signal?.aborted) this.stopAborted()
        const error = classifyError(sent.err)
        // An error with no class is a bug, not a wire failure: it propagates.
        if (!error) throw sent.err
        const d = decideNext({ aborted: false, streaks, recoveriesTried }, { kind: "error", error })
        if (d.kind === "stop") {
          pausedOn = error
          break rounds
        }
        if (d.kind !== "retry" && d.kind !== "recover") {
          throw new Error(`no row ${d.row} for errors`)
        }
        lastCause = error.cause
        if (sent.yielded) {
          const marker = retryStallMarker(attempt + 1)
          if (emitDeltas) this.emit({ type: "text_delta", id: `${rounds}:text`, text: marker })
          yield marker
        }
        if (d.kind === "recover") {
          recoveriesTried.push(d.action)
          if (!(await recover(this.recoveryHost(), d.action, error))) {
            pausedOn = error
            break rounds
          }
        }
        try {
          await waitToRetry(this.recoveryHost(), error, attempt, clock.now() - startedAt, signal)
        } catch (err) {
          if (signal?.aborted) this.stopAborted()
          throw err
        }
      }

      lastResponse = response
      this.recordResponse(lastResponse, rounds, emitNotice)
      const toolBlocks = lastResponse.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use")
      this.noteReflectionAckTool(toolBlocks, emitNotice)

      // Provider stop notices (refusal, content filter): surface them, or the
      // turn ends silently. Pure projection; no retry, no history change.
      const stopNotice = detectStopNotice(lastResponse.stopReason, lastResponse.stopDetails)
      if (stopNotice) emitNotice(stopNotice)

      const decision = decideNext(
        { aborted: Boolean(signal?.aborted), streaks, recoveriesTried },
        {
          kind: "response",
          response: {
            stopReason: lastResponse.stopReason,
            toolUseCount: toolBlocks.length,
            terminalLess: lastResponse.stopDetails?.type === "stream_closed_without_terminal",
          },
        },
      )
      streaks = decision.streaks
      switch (decision.kind) {
        case "stop": {
          if (decision.outcome === "aborted") this.stopAborted()
          if (decision.outcome === "truncated") {
            // D20 guards: a degenerate-output streak ends the turn, not the run.
            emitNotice(
              decision.reason === "max_tokens"
                ? { kind: "max_tokens_capped", severity: "warn", cap: MAX_TOKENS_CONTINUATION_CAP }
                : {
                    kind: "stream_interrupted_capped",
                    severity: "warn",
                    cap: MAX_INTERRUPTED_TURN_CONTINUATIONS,
                  },
            )
            outcome = "truncated"
            break rounds
          }
          // Row 13. A mode switch queued during the turn starts one more round.
          const pendingMode = this.modeProvider?.consumePendingAttachment?.() ?? null
          if (pendingMode != null && !signal?.aborted) {
            this.appendUserContent([pendingMode])
            this.checkpointRound(rounds, streaks)
            continue rounds
          }
          // Natural exit: the model returned no tool calls. The turn settled,
          // so emit turn_completed with the final stop reason + usage.
          this.emitTurnCompleted(rounds, lastResponse)
          break rounds
        }
        case "continue": {
          // Rows 3 and 5: a continuation with a new body, never a replay.
          const maxTokens = decision.reason === "max_tokens"
          emitNotice({
            kind: maxTokens ? "max_tokens_continuing" : "stream_interrupted_continuing",
            severity: "warn",
            attempt: decision.attempt,
            cap: maxTokens ? MAX_TOKENS_CONTINUATION_CAP : MAX_INTERRUPTED_TURN_CONTINUATIONS,
          })
          if (lastResponse.blocks.length === 0) {
            const placeholder: ContentBlock[] = [
              { type: "text", text: responseTruncatedPlaceholderText() },
            ]
            this.messages.push({ role: "assistant", content: placeholder })
            this.sessionPersistence?.appendAssistant(
              placeholder,
              lastResponse.stopReason,
              lastResponse.usage,
            )
          }
          const text = maxTokens
            ? outputTruncatedAttachmentText()
            : streamInterruptedContinueAttachmentText()
          this.appendUserContent([{ type: "text", text }])
          this.checkpointRound(rounds, streaks)
          continue rounds
        }
        case "run_tools":
          break
        case "retry":
        case "recover":
          throw new Error(`no row ${decision.row} for responses`)
        default: {
          const _exhaustive: never = decision
          throw new Error(`unhandled stop decision: ${JSON.stringify(_exhaustive)}`)
        }
      }

      // Rows 2 and 7: run the tool calls.
      if (decision.salvaged) {
        emitNotice({
          kind: "stream_interrupted_salvaged",
          severity: "warn",
          completedToolCalls: toolBlocks.length,
        })
      } else if (lastResponse.stopReason === "max_tokens") {
        emitNotice({ kind: "max_tokens_salvaged", severity: "warn" })
      }
      const toolResults = await runToolCalls(this.toolCallHost(), toolBlocks, signal)
      // Row 2 effect: one successful tool call resets the max_tokens streak.
      if (toolResults.some((r) => !r.is_error)) streaks = { ...streaks, maxTokens: 0 }

      const { checkToolDidBatch } = await import("../agent/tool-batch-gate.ts")
      const batchGate = await checkToolDidBatch(this.lifecycle, toolBlocks, toolResults)
      if (batchGate.halted) {
        const refused = decideNext(
          { aborted: false, streaks, recoveriesTried },
          { kind: "tool_batch_refused", reason: batchGate.reason },
        )
        this.emit({ type: "error", message: batchGate.reason })
        await this.lifecycle.turnEnd?.({ ok: false, error: batchGate.reason })
        outcome = refused.kind === "stop" ? refused.outcome : "failed"
        break rounds
      }

      // A turn that executed tools also settled here (next iteration is a
      // fresh model response). Emit turn_completed before looping.
      this.emitTurnCompleted(rounds, lastResponse)
      const content = await this.nextRoundContent(toolResults, decision.salvaged, rounds, ports)
      this.messages.push({ role: "user", content })
      // S50: the round's response, its tool results, and the next round's
      // user content are all persisted above. Checkpoint now, so a crash
      // right after this point resumes at the next round.
      this.checkpointRound(rounds, streaks)
    }

    if (pausedOn) {
      // Row 11: pause, do not end the session. The host fixes the cause and
      // starts the next run on the same history.
      const fields = fatalErrorFields(pausedOn.error) ?? { message: String(pausedOn.error) }
      this.emit({ type: "error", ...fields, recoverable: false })
      this.emit({ type: "status", phase: "waiting_for_host", cause: pausedOn.cause })
      outcome = "waiting"
    }
    // S50 resume safety: a settled turn (every outcome but `waiting`) clears
    // any round checkpoint it, or an earlier resumed process, left behind,
    // so a stale one is never mistaken for an unfinished turn.
    if (outcome !== "waiting" && this.checkpoint.round > 0) this.checkpointRound(0)
    const aborted = Boolean(signal?.aborted)
    void this.lifecycle.turnEnd?.({
      ok: !aborted && outcome !== "waiting",
      ...(aborted ? { aborted: true } : {}),
      ...(pausedOn ? { error: fatalErrorFields(pausedOn.error)?.message ?? "paused" } : {}),
    })
    return { ...lastResponse, outcome, ...(pausedOn ? { error: pausedOn.error } : {}) }
  }

  /**
   * One round trip with no tools: append the user text and stream one reply
   * (reflection acks stripped). It does not loop and does not retry; a
   * failure throws. Tool-using turns go through {@link AgentCore.run}.
   *
   * @yields Cleaned text deltas.
   */
  async *send(
    userText: string,
    opts?: Partial<SendOptions>,
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    this.messages.push({ role: "user", content: [{ type: "text", text: userText }] })
    const sent = yield* this.sendAttempt({ sendOpts: opts ?? {} }, 0)
    if (sent.kind === "error") throw sent.err
    if (sent.response.blocks.length > 0) {
      this.messages.push({ role: "assistant", content: sent.response.blocks })
    }
    return sent.response
  }
}
