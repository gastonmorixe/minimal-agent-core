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
  repairOrphanedToolUse as repairOrphanedToolUseImpl,
  rollbackPendingTurn as rollbackPendingTurnImpl,
} from "../agent/history-repair.ts"
import {
  outputTruncatedAttachmentText,
  responseTruncatedPlaceholderText,
  sessionResumedAttachmentText,
  streamInterruptedAttachmentText,
  streamInterruptedContinueAttachmentText,
  turnAbortedAttachmentText,
} from "../agent/PROMPTS.ts"
import { type AskUserFn, runPreflightPipeline } from "../agent/preflight-pipeline.ts"
import {
  buildReflectionCheckpointBlock,
  DEFAULT_REFLECTION_COOLDOWN_MS,
  DEFAULT_REFLECTION_INTERVAL,
  parseReflectionAck,
} from "../agent/reflection.ts"
import { createReflectionAckStripper } from "../agent/reflection-ack-stripper.ts"
import { detectStopNotice, formatTurnNoticePlain, type TurnNotice } from "../agent/turn-notice.ts"
import type { AuthResult } from "../auth/auth.ts"
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
  type StreamedResponse,
  type TransportFn,
} from "../llm/transport/types.ts"

import {
  EMPTY_RESPONSE,
  itemEvents,
  type MaybePromise,
  toEventStopReason,
  toEventUsage,
} from "./agent-core-helpers.ts"
import { appendUserTurn } from "./conversation-history.ts"
import type { AgentEvent, EventSink } from "./events.ts"
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
  TranscriptSink,
} from "./ports.ts"
import { type RecoveryHost, recover, waitToRetry } from "./run-recovery.ts"
import { createSinkGuard, reportSinkError } from "./sink-guard.ts"
import {
  decideNext,
  MAX_INTERRUPTED_TURN_CONTINUATIONS,
  MAX_TOKENS_CONTINUATION_CAP,
  type Streaks,
  type TurnOutcome,
} from "./stop-policy.ts"
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
  onThinkingStart?: () => MaybePromise<void>
  onThinkingDelta?: (text: string) => MaybePromise<void>
  onThinkingStop?: () => MaybePromise<void>
  onTextStop?: () => MaybePromise<void>
  signal?: AbortSignal
  emitDeltas?: boolean
}

/** One attempt: the response, or the thrown error as data. */
type AttemptSend =
  | { kind: "response"; response: StreamedResponse }
  | { kind: "error"; err: unknown; yielded: boolean }

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
  private transcriptSink: TranscriptSink
  private sessionPersistence: SessionPersistence | null
  private promptContributors: PromptContributor[]
  private modeProvider: ModeProvider | null
  private mediaResolver: MediaResolver | null
  private abortSignalProvider: AbortSignalProvider | null
  private retryPolicy: RetryPolicyOptions
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
  /** Isolates the event sink. Its first throw emits one `events.sink-error` (S22). */
  private readonly sinkGuard = createSinkGuard((failure) =>
    reportSinkError("eventSink", failure, this.diagnostics),
  )
  private lifecycle: LifecyclePort

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
    this.transcriptSink = config.transcriptSink
    this.sessionPersistence = config.sessionPersistence ?? null
    this.promptContributors = config.promptContributors ?? []
    this.modeProvider = config.modeProvider ?? null
    this.mediaResolver = config.mediaResolver ?? null
    this.abortSignalProvider = config.abortSignalProvider ?? null
    this.eventSink = config.eventSink ?? null
    this.retryPolicy = config.retry ?? {}
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

  setModel(model: string): void {
    this.model = model
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
      reason: opts?.reason,
      preferRemote: opts?.preferRemote,
      ...(opts?.mode ? { mode: opts.mode } : {}),
      ...(opts?.keepTail !== undefined ? { keepTail: opts.keepTail } : {}),
      ...(opts?.focus ? { focus: opts.focus } : {}),
      ...(opts?.onProgress ? { onProgress: opts.onProgress } : {}),
      ...(opts?.writeStream ? { writeStream: opts.writeStream } : {}),
      ...(opts?.onSummaryAttempt ? { onSummaryAttempt: opts.onSummaryAttempt } : {}),
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

  private resolveMaxOutputTokens(ctx?: {
    system?: SystemBlock[]
    tools?: EstimableTool[]
  }): number | undefined {
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
      policy: this.retryPolicy,
      diagnostics: this.diagnostics,
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

  private emitTurnCompleted(round: number, response: StreamedResponse): void {
    this.emit({
      type: "turn_completed",
      turn: round,
      stopReason: toEventStopReason(response.stopReason),
      usage: toEventUsage(response.usage),
    })
  }

  /**
   * Drain a queued `context:compact` plugin request between rounds.
   * Queue-only: never compacts mid-turn, runs the existing path here.
   */
  private async drainPendingCompact(): Promise<void> {
    const { takePendingCompact } = await import("../plugins/host/providers/context-compact.ts")
    const pending = takePendingCompact()
    if (pending === null) return
    const { reason, mode } = pending
    await this.compact({
      ...(reason === "manual" || reason === "auto" || reason === "exceeded" ? { reason } : {}),
      ...(mode === "remote" || mode === "tail" || mode === "local" || mode === "fork"
        ? { mode }
        : {}),
      ...(pending.keepTail !== undefined ? { keepTail: pending.keepTail } : {}),
      ...(pending.focus ? { focus: pending.focus } : {}),
    })
  }

  private async runPreflight(askUser: AskUserFn): Promise<void> {
    const result = await runPreflightPipeline({
      messages: this.messages,
      modelId: this.model,
      askUser,
    })
    if (result.cancelled) this.stopAborted()
    if (result.adoptModelId) this.model = result.adoptModelId
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
        ...req.sendOpts,
        ...(req.onThinkingStart ? { onThinkingStart: req.onThinkingStart } : {}),
        ...(onThinkingDelta ? { onThinkingDelta } : {}),
        ...(req.onThinkingStop ? { onThinkingStop: req.onThinkingStop } : {}),
        ...(req.onTextStop ? { onTextStop: req.onTextStop } : {}),
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
   * The user message after a tool round: tool results, then the salvage
   * attachment, the mode attachment, save echoes, queued user text, and the
   * reflection checkpoint when one is due.
   */
  private async nextRoundContent(
    toolResults: ToolResultBlock[],
    salvaged: boolean,
    round: number,
    hooks: {
      drainQueuedUserText?: (() => string | null) | undefined
      onQueueInject?: ((text: string) => void) | undefined
      beforeReflectionCheckpoint?: ((round: number) => MaybePromise<void>) | undefined
    },
  ): Promise<ContentBlock[]> {
    const content: ContentBlock[] = [...toolResults]
    if (salvaged) content.push({ type: "text", text: streamInterruptedAttachmentText() })
    const modeAttach = this.modeProvider?.consumePendingAttachment?.() ?? null
    if (modeAttach) content.push(modeAttach)
    for (const contributor of this.promptContributors) {
      for (const e of contributor.saveEchoes?.() ?? []) content.push(e)
    }
    const queuedText = hooks.drainQueuedUserText?.() ?? null
    if (queuedText && queuedText.trim().length > 0) {
      content.push({ type: "text", text: queuedText })
      this.sessionPersistence?.appendUser([{ type: "text", text: queuedText }])
      hooks.onQueueInject?.(queuedText)
    }
    if (this.reflectionInterval > 0 && round % this.reflectionInterval === 0) {
      if (this.reflectionSilenceRemaining > 0) {
        this.reflectionSilenceRemaining -= 1
      } else {
        await hooks.beforeReflectionCheckpoint?.(round)
        content.push(buildReflectionCheckpointBlock(round, this.reflectionCooldownMs))
      }
    }
    return content
  }

  /** Run one turn. A fatal non-abort throw is emitted as an `error` event, then rethrown. */
  async *run(
    userText: string,
    opts?: Partial<SendOptions> & {
      onThinkingStart?: () => MaybePromise<void>
      onThinkingChunk?: (chunk: string) => MaybePromise<void>
      onThinkingStop?: () => MaybePromise<void>
      onTextStop?: () => MaybePromise<void>
      drainQueuedUserText?: () => string | null
      onQueueInject?: (text: string) => void
      signal?: AbortSignal
      askUser?: AskUserFn
      /**
       * Opt in to realtime token-delta events (`text_delta` / `thinking_delta`)
       * on the {@link EventSink}. OFF by default so the buffered `json` mode and
       * the frozen SDK golden (which do not opt in) see no deltas — only the
       * live `stream-json` path passes `true`. Additive: when off, the emitted
       * event stream is byte-identical to before Phase 3.
       */
      emitDeltas?: boolean
      /**
       * Host-side notice renderer (Tier 2). When set, semantic
       * {@link TurnNotice}s are handed to the host instead of (or in addition
       * to) a plain transcript line.
       */
      onNotice?: (notice: TurnNotice) => MaybePromise<void>
      /**
       * Tier-2 hook before a reflection-checkpoint attachment is injected.
       * InteractiveSession uses this for the Esc-skippable wall-clock cooldown.
       * Headless / `--json` leave it unset (no pause).
       */
      beforeReflectionCheckpoint?: (round: number) => MaybePromise<void>
    },
  ): AsyncGenerator<string, TurnResult, undefined> {
    try {
      return yield* this.runTurn(userText, opts)
    } catch (err) {
      const fields = fatalErrorFields(err)
      if (fields) this.emit({ type: "error", ...fields })
      throw err
    }
  }

  private async *runTurn(...[userText, opts]: Parameters<AgentCore["run"]>) {
    const {
      onThinkingStart,
      onThinkingChunk,
      onThinkingStop,
      onTextStop,
      drainQueuedUserText,
      onQueueInject,
      signal,
      askUser,
      emitDeltas,
      onNotice,
      beforeReflectionCheckpoint,
      ...sendOpts
    } = opts ?? {}
    const thinkingStart = onThinkingStart
    const onThinkingDelta = onThinkingChunk ?? sendOpts.onThinkingDelta
    const thinkingStop = onThinkingStop
    const textStop = onTextStop
    const writeTranscript = (line: string): void => {
      this.transcriptSink.write(line)
    }
    // Surface a semantic {@link TurnNotice}: emit it on the structured
    // event stream (so `--json` consumers get category / attempt / message
    // as data) AND write a style-free one-liner to the transcript sink
    // (the human progress channel). The core writes NO ANSI here : any
    // terminal styling is a host concern, applied by whoever renders the
    // event or transcript downstream.
    const emitNotice = (notice: TurnNotice): void => {
      this.emit({ type: "notice", notice })
      if (onNotice) {
        void onNotice(notice)
      } else {
        writeTranscript(`\n  ${formatTurnNoticePlain(notice)}`)
      }
    }

    const initialUserContent: ContentBlock[] = []

    const orphanRepair = this.repairOrphanedToolUse()
    for (const b of orphanRepair) initialUserContent.push(b)

    // Runtime markers follow orphan-repair results because tool_result blocks
    // must be immediately after their matching tool_use.
    const turnMarker = this.pendingTurnMarker
    this.pendingTurnMarker = null
    if (turnMarker === "aborted") {
      initialUserContent.push({ type: "text", text: turnAbortedAttachmentText() })
    } else if (turnMarker === "resumed") {
      initialUserContent.push({ type: "text", text: sessionResumedAttachmentText() })
    }

    const initialModeAttach = this.modeProvider?.consumePendingAttachment?.() ?? null
    if (initialModeAttach) initialUserContent.push(initialModeAttach)

    for (const contributor of this.promptContributors) {
      const blocks = contributor.turnAttachments?.() ?? []
      for (const b of blocks) initialUserContent.push(b)
    }

    for (const contributor of this.promptContributors) {
      const echoes = contributor.saveEchoes?.() ?? []
      for (const e of echoes) initialUserContent.push(e)
    }

    if (userText.length > 0) {
      if (this.mediaResolver) {
        initialUserContent.push(...(await this.mediaResolver.resolveUserContent(userText)))
      } else {
        initialUserContent.push({ type: "text", text: userText })
      }
    }

    appendUserTurn(this.messages, initialUserContent)

    const userRecordContent =
      orphanRepair.length > 0
        ? initialUserContent.filter((b) => b.type !== "tool_result")
        : initialUserContent
    if (userRecordContent.length > 0) {
      this.sessionPersistence?.appendUser(userRecordContent)
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
      ...(thinkingStart ? { onThinkingStart: thinkingStart } : {}),
      ...(onThinkingDelta ? { onThinkingDelta } : {}),
      ...(thinkingStop ? { onThinkingStop: thinkingStop } : {}),
      ...(textStop ? { onTextStop: textStop } : {}),
      ...(signal ? { signal } : {}),
      ...(emitDeltas ? { emitDeltas } : {}),
    }
    const clock = this.retryPolicy.clock ?? SYSTEM_CLOCK
    let rounds = 0
    let streaks: Streaks = { maxTokens: 0, interrupted: 0 }
    this.reflectionSilenceRemaining = 0
    let outcome: TurnOutcome = "completed"
    let pausedOn: ClassifiedError | undefined
    let lastResponse: StreamedResponse = EMPTY_RESPONSE

    // The one agent loop. Each round sends the history, streams the
    // response, runs tool calls, and asks `decideNext` what to do next.
    // Nothing here counts rounds or retries toward a limit.
    rounds: for (;;) {
      if (signal?.aborted) this.stopAborted()
      await this.drainPendingCompact()
      rounds++
      // A new assistant turn (one model response) begins. `turn` is the
      // monotonic round index per the frozen event contract.
      this.emit({ type: "turn_started", turn: rounds })
      if (askUser) await this.runPreflight(askUser)

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
      const toolResults: ToolResultBlock[] = []
      for (const tool of toolBlocks) {
        const result = await this.toolExecutor.execute(tool, signal)
        const toolResult: ToolResultBlock = {
          type: "tool_result",
          tool_use_id: tool.id,
          content: result.content,
          is_error: result.isError,
        }
        toolResults.push(toolResult)
        this.sessionPersistence?.appendToolResult(toolResult)
        // The tool result joins back to its item_started on the SAME id
        // (the tool_use block id), per the frozen correlation contract.
        this.emit({ type: "tool_result", id: tool.id, name: tool.name, isError: result.isError })
      }
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
      const content = await this.nextRoundContent(toolResults, decision.salvaged, rounds, {
        drainQueuedUserText,
        onQueueInject,
        beforeReflectionCheckpoint,
      })
      this.messages.push({ role: "user", content })
    }

    if (pausedOn) {
      // Row 11: pause, do not end the session. The host fixes the cause and
      // starts the next run on the same history.
      const fields = fatalErrorFields(pausedOn.error) ?? { message: String(pausedOn.error) }
      this.emit({ type: "error", ...fields, recoverable: false })
      this.emit({ type: "status", phase: "waiting_for_host", cause: pausedOn.cause })
      outcome = "waiting"
    }
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
