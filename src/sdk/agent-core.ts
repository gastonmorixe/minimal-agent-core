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

import {
  closeInterruptedToolCalls,
  repairOrphanedToolUse as repairOrphanedToolUseImpl,
  rollbackPendingTurn as rollbackPendingTurnImpl,
} from "../agent/history-repair.ts"
import type { AskUserFn } from "../agent/preflight-pipeline.ts"
import { createSyntheticTextResolver } from "../agent/synthetic-text.ts"
import { appendRoundTurnContent } from "../agent/turn-content.ts"
import { detectStopNotice, type TurnNotice } from "../agent/turn-notice.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { PluginEventsPort } from "../bus/plugin-events-port.ts"
import type { StatusPort } from "../bus/status-port.ts"
import { type CacheTtl, DEFAULT_CACHE_TTL } from "../cache/cache-ttl.ts"
import { type Diagnostics, processDiagnostics } from "../diagnostics/hub.ts"
import { fatalErrorFields } from "../llm/error-hint.ts"
import type { ContentBlock, Message, ToolResultBlock, ToolUseBlock } from "../llm/messages.ts"
import type { SystemPromptOverrides } from "../llm/system-prompt-overrides.ts"
import { noteRetryRecovered } from "../llm/transport/retry.ts"
import {
  type ClassifiedError,
  classifyError,
  type RecoveryAction,
  type RetryPolicyOptions,
  SYSTEM_CLOCK,
} from "../llm/transport/retry-policy.ts"
import { selectedTransport } from "../llm/transport/select-transport.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"

import {
  adoptModel,
  buildTurnSystemPrompt,
  compactOptsArgs,
  EMPTY_RESPONSE,
  type NoticeEmitter,
  nextRoundContent as nextRoundContentHelper,
  resolveEffortChange,
  toEventStopReason,
  toEventUsage,
  withDefaultStatusPort,
} from "./agent-core-helpers.ts"
import {
  advertisedToolSchemas,
  appendInitialUserTurn,
  type ResponseRecordDeps,
  recordModelResponse,
} from "./agent-core-round.ts"
import { type CacheSendState, createCacheSendState } from "./cache-send-policy.ts"
import {
  cappedNotice,
  continuingNotice,
  noteContinuationStop,
  planContinuation,
} from "./continuation.ts"
import { drainPendingCompact } from "./drain-pending-compact.ts"
import { eventKindFilter } from "./event-filter.ts"
import type { AgentEvent, EventSink } from "./events.ts"
import type { HookContextEntry } from "./hook-context.ts"
import { compactSessionFacts, toolExecContext } from "./host-facts.ts"
import { type HostPorts, runPorts } from "./host-ports.ts"
import { type LifecyclePort, NOOP_LIFECYCLE } from "./lifecycle.ts"
import type {
  AbortSignalProvider,
  AgentCoreConfig,
  MediaResolver,
  ModeProvider,
  PromptContributor,
  SessionPersistence,
  ToolAdvertisementFilter,
  ToolExecutor,
  ToolRegistry,
} from "./ports.ts"
import { createPreflightAsk, type PreflightAsk } from "./preflight-ask.ts"
import { type RoundCheckpoint, TURN_START } from "./round-checkpoint.ts"
import { type OutputStrictConfig, RunOutputStrict } from "./run-output-strict.ts"
import { type RecoveryHost, recover, waitToRetry } from "./run-recovery.ts"
import {
  emptyRunTemperature,
  type RunTemperatureState,
  startRunTemperature,
} from "./run-temperature.ts"
import { type AttemptSend, type RoundRequest, sendAttemptInto } from "./send-attempt.ts"
import { insertSessionTake, SessionContextQueue, sessionTakeBlocks } from "./session-context.ts"
import { createSinkGuard, reportSinkError } from "./sink-guard.ts"
import { decideNext, type Streaks, type TurnOutcome } from "./stop-policy.ts"
import { adoptionChange, TargetChange, type TargetChangeListener } from "./target-change.ts"
import type { SwitchTargetCredentialNames } from "./target-credential-names.ts"
import {
  defaultModelFor,
  registeredModelsFor,
  resolveTargetSwitch,
  type TargetSelection,
  type TargetState,
  type TargetSwitch,
  targetSwitchNotice,
  targetsEqual,
} from "./target-switch.ts"
import { persistSyntheticToolResult, runToolCalls, type ToolCallHost } from "./tool-calls.ts"
import { resolveMaxStopHookHalts, STOP_END, TurnStopGate } from "./turn-stop-hook.ts"
import { wrapTransportWithLifecycle } from "./with-lifecycle-send.ts"
import type { WrapUpState } from "./wrap-up.ts"
import { isWrapUpAbort, runWrapUpTurn, throwIfWrapUp, wrapUpAsAbort } from "./wrap-up.ts"

/**
 * What one `AgentCore.run` turn returns: the last model response plus how the
 * turn ended. With outcome `waiting`, `error` is the permanent error that
 * paused the run; the host fixes the cause and starts the next run.
 */
export type TurnResult = StreamedResponse & { outcome: TurnOutcome; error?: unknown }

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
  private readonly credentialNames: SwitchTargetCredentialNames | undefined
  private auth: AuthResult
  private effort: string | undefined
  private outputSchema: object | undefined
  /**
   * Per-run `outputSchema` override (D1). Set for the life of one
   * {@link run} only, and cleared in its `finally` (success, error, or
   * abort). While set, every model request of that run uses it instead of
   * the session-level {@link outputSchema}, which is never changed.
   */
  private runOutputSchema: object | undefined
  /** One-shot schema for the NEXT {@link run}, from {@link setNextRunOutputSchema}. */
  private pendingRunOutputSchema: object | undefined
  /**
   * Per-run sampling temperature (D4). Same life as {@link runOutputSchema}:
   * `value` is set at the start of one {@link run} and cleared in its
   * `finally`. `pending` is the one-shot from {@link setNextRunTemperature}.
   */
  private runTemp: RunTemperatureState = emptyRunTemperature()
  /** Strict structured output (R2): session value, per-run value (same life as D1), one-shot. */
  private readonly strict: RunOutputStrict
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
  /** The core's one synthetic text resolver, shared with tool runs and the ModeManager. */
  readonly syntheticText: NonNullable<AgentCoreConfig["syntheticTextResolver"]>
  private modeProvider: ModeProvider | null
  private mediaResolver: MediaResolver | null
  private abortSignalProvider: AbortSignalProvider | null
  private retryPolicy: RetryPolicyOptions
  /** Default `statusPort` / `pluginEvents` (S23, S28) for a call that sets neither. */
  private readonly defaultStatusPort: StatusPort | undefined
  private readonly defaultPluginEvents: PluginEventsPort | undefined
  private cacheTtl: CacheTtl = DEFAULT_CACHE_TTL
  private readonly cacheSend: CacheSendState
  private systemPromptOverrides: SystemPromptOverrides | undefined
  private readonly turnContentProviders: NonNullable<AgentCoreConfig["turnContentProviders"]>
  /** One-shot runtime marker for the next attachments-only continuation turn. */
  private pendingTurnMarker: "aborted" | "resumed" | null = null
  /** The run signal, the round request and the round, for a wrap-up (`wrap-up.ts`). */
  private wrapUp: WrapUpState = {}
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
  /** One-shot session context entries for the next request ({@link addSessionContext}). */
  private readonly sessionContext = new SessionContextQueue()
  /** Consecutive `turn.willStop` halts one turn honors (`maxStopHookHalts`). */
  private readonly maxStopHookHalts: number
  /**
   * Concurrency cap of a wave (`AgentCoreConfig.maxConcurrentToolCalls`).
   * `runToolCalls` gets it through {@link ToolCallHost.maxConcurrentToolCalls}
   * and checks it there (omitted or invalid: 1, the serial path).
   */
  private readonly maxConcurrentToolCalls: number | undefined
  /** Host facts for the loop hook payloads (`AgentCoreConfig.sessionFacts`). */
  private readonly sessionFacts: AgentCoreConfig["sessionFacts"]
  /** What a change of the live target does (version, wait wake, listeners, thinking). */
  private readonly targetChange = new TargetChange({
    persist: (entry) => this.sessionPersistence?.appendTargetSwitch?.(entry),
    listenerFailed: (err) =>
      this.diagnostics.warn("agent.target-listener", `target listener failed: ${String(err)}`),
  })

  constructor(config: AgentCoreConfig & OutputStrictConfig) {
    this.strict = new RunOutputStrict(config.outputStrict)
    this.model = config.model
    this.providerId = config.providerId
    this.credentialName = config.credentialName
    this.credentialNames = config.credentialNames
    this.auth = config.auth
    this.lifecycle = config.lifecycle ?? NOOP_LIFECYCLE
    this.maxStopHookHalts = resolveMaxStopHookHalts(config.maxStopHookHalts)
    this.maxConcurrentToolCalls = config.maxConcurrentToolCalls
    this.sessionFacts = config.sessionFacts
    this.diagnostics = config.diagnostics ?? processDiagnostics()
    this.sendFn = wrapTransportWithLifecycle(config.sendFn ?? selectedTransport, this.lifecycle)
    this.networkClient = config.networkClient
    this.toolRegistry = config.toolRegistry
    this.toolFilter = config.toolFilter ?? null
    this.toolExecutor = config.toolExecutor
    this.sessionPersistence = config.sessionPersistence ?? null
    this.promptContributors = config.promptContributors ?? []
    this.turnContentProviders = config.turnContentProviders ?? []
    // One resolver per core: the loader's when the host passes it, else one
    // built here from the providers (owner check and diagnostics run once).
    this.syntheticText =
      config.syntheticTextResolver ??
      createSyntheticTextResolver(config.syntheticTextProviders ?? [], this.diagnostics)
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
    this.cacheSend = createCacheSendState(config)
    this.systemPromptOverrides = config.systemPromptOverrides
    if (config.initialMessages && config.initialMessages.length > 0) {
      for (const m of config.initialMessages) this.messages.push(m)
    }
  }

  getModel(): string {
    return this.model
  }
  getProviderId(): string | undefined {
    return this.providerId
  }
  getCredentialName(): string | undefined {
    return this.credentialName
  }
  getTarget(): TargetState {
    return {
      ...(this.credentialName !== undefined ? { credentialName: this.credentialName } : {}),
      ...(this.providerId !== undefined ? { providerId: this.providerId } : {}),
      model: this.model,
      effort: this.effort,
    }
  }

  /** Current reasoning effort, or `undefined` for the model default. */
  getEffort(): string | undefined {
    return this.effort
  }

  /**
   * Switch the model for every request from the NEXT model request onward
   * (that can be inside the same turn, after a tool round — an in-flight
   * request keeps its model and effort). The same checked step as
   * {@link switchTarget} with only `model` set: scoped to {@link providerId}
   * (same-provider switching only), throws on an unknown model with model
   * AND effort unchanged, and resets an effort that the new model does not
   * support to the model default. No notice (the caller already knows it
   * changed the model). The target-change steps of {@link switchTarget} apply.
   */
  setModel(model: string): void {
    this.changeTarget({ model }, false)
  }

  /**
   * Switch the reasoning effort for every request from the NEXT model
   * request onward. Validates `effort` against the CURRENT model's
   * declared effort levels ({@link resolveEffortChange}); throws on an
   * unsupported value (including any explicit value when the model
   * declares no effort levels), with state unchanged. `undefined` always
   * passes (the model default). The target-change steps of
   * {@link switchTarget} apply.
   */
  setEffort(effort: string | undefined): void {
    const from = this.getTarget()
    const to = { ...from, effort: resolveEffortChange(effort, this.model, this.providerId) }
    if (targetsEqual(from, to)) return
    this.applyTarget({ from, to, effortReset: false, effortFrom: undefined }, true)
  }

  /**
   * Switch the target quadruple (and `sel.auth` when given), next request
   * onward. A throw changes nothing. After a real change (`target-change.ts`):
   * a retry or quota wait in progress ends and the next attempt uses the new
   * target, the system prompt is built again for it, thinking from before
   * the change is discarded, and each {@link onTargetChange} listener runs.
   * `quiet` sends no `model_adopted` notice, for a host that shows the change itself.
   */
  switchTarget(sel: TargetSelection, opts?: { quiet?: boolean }): TargetSwitch {
    return this.changeTarget(sel, opts?.quiet !== true)
  }

  /** Subscribe to each change of the live target. Returns the unsubscribe function. */
  onTargetChange(listener: TargetChangeListener): () => void {
    return this.targetChange.on(listener)
  }

  private changeTarget(sel: TargetSelection, notice: boolean): TargetSwitch {
    const current = this.getTarget()
    const resolved = resolveTargetSwitch(sel, current, {
      ...(this.credentialNames ? { credentialNamesFor: this.credentialNames } : {}),
      registeredModelsFor,
      defaultModelFor,
      structuredOutputsRequired: (this.runOutputSchema ?? this.outputSchema) !== undefined,
    })
    if (sel.auth !== undefined) this.auth = sel.auth
    if (targetsEqual(resolved.to, current)) {
      return { from: current, to: current, effortReset: false, effortFrom: undefined }
    }
    this.applyTarget(resolved, true)
    if (notice) this.emit({ type: "notice", notice: targetSwitchNotice(resolved) })
    return resolved
  }

  /** Assign a validated target, then run the target-change steps. */
  private applyTarget(change: TargetSwitch, discardThinking: boolean): void {
    const { to } = change
    this.credentialName = to.credentialName
    this.providerId = to.providerId
    this.model = to.model
    this.effort = to.effort
    this.targetChange.apply(change, discardThinking, this.messages)
  }

  /**
   * Arms a one-shot `outputSchema` for the NEXT {@link run} only, for a host
   * whose run wrapper does not forward the `outputSchema` run option (for
   * example `Session.run`). The next `run` takes it (a run option wins) and
   * clears it at start. `undefined` disarms it. The session-level schema
   * is never changed.
   */
  setNextRunOutputSchema(schema: object | undefined): void {
    this.pendingRunOutputSchema = schema
  }

  /**
   * Arms a one-shot sampling `temperature` for the NEXT {@link run} only,
   * for a host whose run wrapper does not forward the `temperature` run
   * option (for example `Session.run`). Same rules as
   * {@link setNextRunOutputSchema}: a run option wins, the next `run` clears
   * it at start, and `undefined` disarms it.
   */
  setNextRunTemperature(temperature: number | undefined): void {
    this.runTemp.pending = temperature
  }

  /**
   * Arms a one-shot strict structured output flag (R2) for the NEXT
   * {@link run} only, for a host whose run wrapper does not forward the
   * `outputStrict` run option. Same rules as {@link setNextRunOutputSchema}.
   */
  setNextRunOutputStrict(strict: boolean | undefined): void {
    this.strict.pending = strict
  }

  /**
   * Sets the session-level strict flag (R2) for every later run. A run
   * option or a {@link setNextRunOutputStrict} value wins for its run.
   */
  setOutputStrict(strict: boolean): void {
    this.strict.session = strict
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
      // The live turn passes no holder (process holder) and these overrides.
      ...(this.systemPromptOverrides ? { systemPromptOverrides: this.systemPromptOverrides } : {}),
      ...compactSessionFacts(this.sessionFacts, this.modeProvider?.activeModeId(), (l) =>
        this.addSessionContext(l),
      ),
      ...compactOptsArgs(opts, this.defaultPluginEvents, this.syntheticText),
      appendNote: (text) => this.sessionPersistence?.appendNote(text),
      appendCompact: (rec) => this.sessionPersistence?.appendCompact?.(rec),
    })
  }

  /**
   * Queue session context entries for the next user message the loop
   * appends. They go in one time and are persisted with that message. In the
   * first user message of a turn, "before" entries go before the user text
   * and "after" entries (and strings) after it. The system prompt does not
   * change. Blank entries are dropped. The CLI calls this with the
   * `session.willStart` context.
   */
  addSessionContext(lines: readonly HookContextEntry[]): void {
    this.sessionContext.add(lines)
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

  rollbackPendingTurn(): boolean {
    return rollbackPendingTurnImpl(this.messages)
  }

  notePreviousTurnAborted(): void {
    this.pendingTurnMarker = "aborted"
  }

  /**
   * Request one continuation turn, used by `/continue`. When a turn is
   * unfinished (a crash, a kill, or a pause left a round checkpoint, S50),
   * the next `run()` continues that turn at its next round, as with
   * `{ resume: true }`. Otherwise the next `run()` is an attachments-only
   * turn with the resumed marker. A host never continues an unfinished turn
   * without the user: it calls this only for `/continue`.
   */
  noteSessionResumed(): void {
    this.pendingTurnMarker = "resumed"
  }

  /** Persist a free-form session note (metadata; not folded into model history). */
  appendNote(text: string): void {
    this.sessionPersistence?.appendNote(text)
  }

  pushSystemMessage(text: string): void {
    this.messages.push({ role: "system", content: text })
  }

  repairOrphanedToolUse(): ToolResultBlock[] {
    return repairOrphanedToolUseImpl(this.messages, null, this.syntheticText)
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
      context: () => ({ ...toolExecContext(this.sessionFacts), text: this.syntheticText }),
      maxConcurrentToolCalls: this.maxConcurrentToolCalls,
    }
  }

  /**
   * Stop-table row 1: emit `error` "aborted" and throw `AbortError`. A
   * wrap-up abort throws `WrapUpAbortError` with no event: `run`
   * then sends the final turn.
   */
  private stopAborted(): never {
    throwIfWrapUp(this.wrapUp.signal)
    this.emit({ type: "error", message: "aborted" })
    throw Object.assign(new Error("aborted"), { name: "AbortError" })
  }

  /** Append one user message to history and persist it. No blocks: no message. */
  private appendUserContent(content: ContentBlock[]): void {
    insertSessionTake(content, this.sessionContext.take(this.messages))
    if (content.length === 0) return
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

  private async runPreflight(preflightAsk: PreflightAsk, emitNotice: NoticeEmitter): Promise<void> {
    const result = await preflightAsk(this.messages, this.model, this.providerId)
    if (result.cancelled) this.stopAborted()
    const from = this.getTarget()
    const adoption = adoptModel(this.model, this.providerId, this.effort, result.adoptModelId)
    // The provider preflight owns the history of its own adoption: no discard.
    const adopted = adoptionChange(from, adoption.model, adoption.effort)
    if (adopted) this.applyTarget(adopted, false)
    if (adoption.notice) emitNotice(adoption.notice)
    if (result.messages !== this.messages) this.replaceMessages(result.messages)
  }

  /**
   * One send of the current history. Streams the text and returns the response, or the thrown error as data so the
   * loop can decide from its class.
   *
   * @yields Cleaned text deltas.
   */
  private async *sendAttempt(
    req: RoundRequest,
    round: number,
  ): AsyncGenerator<string, AttemptSend, undefined> {
    return yield* sendAttemptInto(
      {
        runOutputSchema: this.runOutputSchema,
        outputSchema: this.outputSchema,
        strict: this.strict,
        model: this.model,
        providerId: this.providerId,
        messages: this.messages,
        diagnostics: this.diagnostics,
        credentialName: this.credentialName,
        networkClient: this.networkClient,
        effort: this.effort,
        runTemp: this.runTemp,
        speed: this.speed,
        serviceTier: this.serviceTier,
        thinkingDisplay: this.thinkingDisplay,
        defaultStatusPort: this.defaultStatusPort,
        defaultPluginEvents: this.defaultPluginEvents,
        cacheTtl: this.cacheTtl,
        cacheSend: this.cacheSend,
        auth: this.auth,
        sendFn: this.sendFn,
        emit: (event) => this.emit(event),
      },
      req,
      round,
    )
  }

  /** What the response record step reads and writes on this core. */
  private responseRecordDeps(): ResponseRecordDeps {
    return {
      messages: this.messages,
      persistence: this.sessionPersistence,
      emit: (event) => this.emit(event),
    }
  }

  /**
   * The user message after a tool round. `batchContext` (the `tool.didBatch`
   * listener context) goes last, after the turn content providers. Like
   * the provider blocks, it is not persisted on its own.
   */
  private async nextRoundContent(
    toolResults: ToolResultBlock[],
    salvaged: boolean,
    round: number,
    ports: HostPorts,
    batchContext: readonly ContentBlock[],
  ): Promise<ContentBlock[]> {
    // Session context (for example after a mid-turn compaction) goes after
    // the tool results. Persist it before the queued text, in the same order.
    const sessionTake = this.sessionContext.take(this.messages)
    const sessionBlocks = sessionTakeBlocks(sessionTake)
    if (sessionBlocks.length > 0) this.sessionPersistence?.appendUser(sessionBlocks)
    const { content, queuedText } = await nextRoundContentHelper(
      {
        modeProvider: this.modeProvider,
        promptContributors: this.promptContributors,
        sessionPersistence: this.sessionPersistence,
        text: this.syntheticText,
      },
      toolResults,
      salvaged,
      ports,
    )
    insertSessionTake(content, sessionTake)
    const tp = this.turnContentProviders
    if (tp.length > 0) await appendRoundTurnContent(content, tp, round, salvaged, this.diagnostics)
    content.push(...batchContext)
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
      /**
       * JSON Schema for structured output, for THIS run only (D1). Every
       * model request of the run sends it (`outputConfig.format`) instead
       * of the session-level `outputSchema`. The session value comes back
       * after the run, also on an error or an abort.
       */
      outputSchema?: object
      /**
       * Sampling temperature for THIS run only (D4). Sent on every model
       * request of the run whose model accepts temperature. A model with
       * `acceptsTemperature: false` gets no temperature, and the run reports
       * it once as an `agent.temperature-ignored` warn diagnostic. The run
       * goes on. Gone after the run, also on an error or an abort.
       */
      temperature?: number
      /**
       * Strict structured output for THIS run only (R2). No effect without a
       * schema. A model with `structuredOutputs: false` gets one
       * `llm.strict-unsupported` warn per run. Gone after the run, also on
       * an error or an abort.
       */
      outputStrict?: boolean
      /**
       * Hook context entries (for example from `turn.willStart`) for THIS
       * turn. They go into the first user message: "before" entries before
       * the prompt, the rest after it, wrapped like the other hook context.
       * Ignored on a `resume`.
       */
      additionalContext?: readonly HookContextEntry[]
    },
  ): AsyncGenerator<string, TurnResult, undefined> {
    let aborted = false
    this.runOutputSchema = opts?.outputSchema ?? this.pendingRunOutputSchema
    this.pendingRunOutputSchema = undefined
    this.runTemp = startRunTemperature(opts?.temperature, this.runTemp.pending)
    this.strict.start(opts?.outputStrict)
    this.targetChange.running = true
    // A new run drops the request and the round of the previous run.
    this.wrapUp = opts?.signal ? { signal: opts.signal } : {}
    try {
      const result = yield* this.runTurn(userText, opts)
      this.emit({ type: "run_finished", outcome: result.outcome })
      return result
    } catch (err) {
      // A wrap-up request (not a user abort): one final short turn.
      const { req } = this.wrapUp
      if (isWrapUpAbort(opts?.signal) && req) {
        const { syntheticText: text, diagnostics, lifecycle } = this
        const record = this.responseRecordDeps()
        const send = this.sendAttempt.bind(this)
        // The tool host clock (the retry clock) is the wall clock of `deadlineAt`.
        const host = { record, tools: this.toolCallHost(), send, text, diagnostics, lifecycle }
        // It always emits `run_finished` truncated, also when it throws.
        return yield* runWrapUpTurn(host, { ...this.wrapUp, req }, err)
      }
      // A wrap-up before the round request exists: a plain abort (MIN-1).
      const thrown = wrapUpAsAbort(err, (e) => this.emit(e))
      const fields = fatalErrorFields(thrown)
      if (fields) this.emit({ type: "error", ...fields })
      aborted = thrown instanceof Error && thrown.name === "AbortError"
      this.emit({ type: "run_finished", outcome: aborted ? "aborted" : "failed" })
      throw thrown
    } finally {
      this.targetChange.running = false
      this.targetChange.settle(this.messages)
      this.runOutputSchema = undefined
      this.runTemp.value = undefined
      this.strict.end()
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
    // `outputSchema` and `temperature` are applied by `run` (runOutputSchema,
    // runTemperature), never a raw send option, so the model check applies.
    const {
      signal,
      askUser,
      emitDeltas,
      resume,
      outputSchema: _runSchema,
      temperature: _runTemperature,
      outputStrict: _runStrict,
      additionalContext,
      onBlockEdge: _hostEdge,
      ...sendOpts
    } = opts ?? {}
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
    // or appended. `userText` is skipped: nothing new was typed. A pending
    // `/continue` request (`noteSessionResumed`) resumes the same way, and
    // then needs no resumed marker. Only the user starts it: a resumed
    // session never continues a turn by itself.
    const resuming =
      (Boolean(resume) || this.pendingTurnMarker === "resumed") && this.checkpoint.round > 0
    if (resuming && this.pendingTurnMarker === "resumed") this.pendingTurnMarker = null
    // Decision 31: a tool call that ran at a kill gets a synthetic error
    // result. It never runs again by itself. The model checks its effects.
    if (resuming) {
      for (const b of closeInterruptedToolCalls(this.messages, this.syntheticText))
        persistSyntheticToolResult(this.sessionPersistence, b)
    }

    if (!resuming) {
      // Runtime markers follow orphan-repair results because tool_result
      // blocks must be immediately after their matching tool_use.
      const orphanRepair = this.repairOrphanedToolUse()
      const turnMarker = this.pendingTurnMarker
      this.pendingTurnMarker = null
      const session = this.sessionContext.take(this.messages)
      await appendInitialUserTurn(
        {
          modeProvider: this.modeProvider,
          promptContributors: this.promptContributors,
          mediaResolver: this.mediaResolver,
          model: this.model,
          diagnostics: this.diagnostics,
          text: this.syntheticText,
          turnContentProviders: this.turnContentProviders,
          messages: this.messages,
          persistence: this.sessionPersistence,
          emit: (event) => this.emit(event),
        },
        { userText, orphanRepair, turnMarker, session, turnContext: additionalContext },
      )
    }

    // Built for the live target. A target change builds it again (see the attempt loop).
    const buildSystem = () =>
      buildTurnSystemPrompt({
        model: this.model,
        ...(this.providerId ? { providerId: this.providerId } : {}),
        promptContributors: this.promptContributors,
        blobStoreEnabled: this.toolExecutor.blobStoreEnabled === true,
        cacheTtl: this.cacheTtl,
        overrides: this.systemPromptOverrides,
      })
    let systemVersion = this.targetChange.version

    const mergedTools = advertisedToolSchemas(this.toolRegistry, this.toolFilter, this.modeProvider)

    const req: RoundRequest = {
      system: buildSystem(),
      tools: mergedTools,
      sendOpts,
      ...(onThinkingDelta ? { onThinkingDelta } : {}),
      ...(signal ? { signal } : {}),
      ...(emitDeltas ? { emitDeltas } : {}),
    }
    const clock = this.retryPolicy.clock ?? SYSTEM_CLOCK
    let rounds = resuming ? this.checkpoint.round : 0
    // A wrap-up from here on has a request, so it sends the final turn.
    Object.assign(this.wrapUp, { req, round: rounds })
    let streaks: Streaks = resuming ? this.checkpoint.streaks : { maxTokens: 0, interrupted: 0 }
    let outcome: TurnOutcome = "completed"
    let pausedOn: ClassifiedError | undefined
    let lastResponse: StreamedResponse = EMPTY_RESPONSE
    // turn.willStop halts this turn honored (a new gate per turn resets it).
    const { lifecycle, maxStopHookHalts: cap, sessionFacts, syntheticText: synth } = this
    const stopGate = new TurnStopGate(lifecycle, cap, sessionFacts, synth, this.diagnostics)

    // The one agent loop. Each round sends the history, streams the
    // response, runs tool calls, and asks `decideNext` what to do next.
    // Nothing here counts rounds or retries toward a limit.
    rounds: for (;;) {
      if (signal?.aborted) this.stopAborted()
      // A queued plugin compact request (S17, S27). Errors never fail the turn.
      await drainPendingCompact(ports, (o) => this.compact(o), this.diagnostics, signal)
      if (signal?.aborted) this.stopAborted()
      this.wrapUp.round = ++rounds
      // A new assistant turn (one model response) begins. `turn` is the
      // monotonic round index per the frozen event contract.
      this.emit({ type: "turn_started", turn: rounds })
      await this.runPreflight(preflightAsk, emitNotice)

      // Send the round. A retry or a recovery sends the same history again.
      const recoveriesTried: RecoveryAction[] = []
      const startedAt = clock.now()
      let lastCause = "unknown"
      let retries = 0
      let response: StreamedResponse | undefined
      for (let attempt = 1; response === undefined; attempt++) {
        // A target change: no request is in flight here, so discard the old
        // thinking, and build the system prompt for the new target.
        this.targetChange.settle(this.messages)
        if (systemVersion !== this.targetChange.version) {
          systemVersion = this.targetChange.version
          req.system = buildSystem()
        }
        const sent = yield* this.sendAttempt(req, rounds)
        if (sent.kind === "response") {
          if (retries > 0) {
            noteRetryRecovered(this.diagnostics, retries, clock.now() - startedAt, lastCause)
          }
          response = sent.response
          break
        }
        if (signal?.aborted) this.stopAborted()
        const error = classifyError(sent.err)
        // An error with no class is a bug, not a wire failure: it propagates.
        if (!error) throw sent.err
        // The target changed while this attempt ran: its error is for the old
        // target. Send again now with the new one, with no wait.
        if (systemVersion !== this.targetChange.version) {
          if (sent.yielded && emitDeltas) {
            this.emit({ type: "retry-boundary", id: `${rounds}:text`, attempt: attempt + 1 })
          }
          attempt = 0
          recoveriesTried.length = 0
          continue
        }
        const d = decideNext({ aborted: false, streaks, recoveriesTried }, { kind: "error", error })
        if (d.kind === "stop") {
          pausedOn = error
          break rounds
        }
        if (d.kind !== "retry" && d.kind !== "recover") {
          throw new Error(`no row ${d.row} for errors`)
        }
        lastCause = error.cause
        if (sent.yielded && emitDeltas) {
          this.emit({ type: "retry-boundary", id: `${rounds}:text`, attempt: attempt + 1 })
        }
        if (d.kind === "recover") {
          recoveriesTried.push(d.action)
          if (!(await recover(this.recoveryHost(), d.action, error))) {
            // An abort during the recovery (a compact obeys the signal).
            if (signal?.aborted) this.stopAborted()
            pausedOn = error
            break rounds
          }
        }
        retries++
        const wait = this.targetChange.wait(signal)
        try {
          const elapsedMs = clock.now() - startedAt
          await waitToRetry(this.recoveryHost(), error, attempt, elapsedMs, wait.signal)
        } catch (err) {
          if (signal?.aborted) this.stopAborted()
          if (!wait.woke()) throw err
          // A target change ended the wait: the new target starts at attempt 1.
          attempt = 0
          recoveriesTried.length = 0
        } finally {
          wait.done()
        }
      }

      lastResponse = response
      recordModelResponse(this.responseRecordDeps(), lastResponse, rounds)
      const toolBlocks = lastResponse.blocks.filter((b): b is ToolUseBlock => b.type === "tool_use")

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
            emitNotice(cappedNotice(decision.reason === "max_tokens"))
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
          // turn.willStop: a halt continues the turn with a note (capped). A
          // refusal or content filter end (stopNotice) skips the gate.
          const stop = stopNotice ? STOP_END : await stopGate.check(lastResponse, signal)
          // An abort while the hook ran ends the turn as aborted.
          if (signal?.aborted) this.stopAborted()
          if (stop.kind === "continue") {
            this.emitTurnCompleted(rounds, lastResponse)
            this.appendUserContent(stop.content)
            this.checkpointRound(rounds, streaks)
            continue rounds
          }
          if (stop.kind === "capped") {
            emitNotice({ kind: "stop_hook_capped", severity: "warn", cap: stop.cap })
          }
          // Natural exit: the model returned no tool calls. The turn settled,
          // so emit turn_completed with the final stop reason + usage.
          this.emitTurnCompleted(rounds, lastResponse)
          break rounds
        }
        case "continue": {
          // Rows 3 and 5: a continuation with a new body, never a replay.
          const maxTokens = decision.reason === "max_tokens"
          const plan = planContinuation(synth, maxTokens, lastResponse.blocks.length === 0)
          // A needed text is empty (bare core): no valid new body. The turn
          // ends truncated, with a `continuation.no_text` warning.
          if (plan.kind === "stop") {
            noteContinuationStop(this.diagnostics, plan, maxTokens)
            outcome = "truncated"
            break rounds
          }
          emitNotice(continuingNotice(maxTokens, decision.attempt))
          if (plan.placeholder) {
            this.messages.push({ role: "assistant", content: plan.placeholder })
            this.sessionPersistence?.appendAssistant(
              plan.placeholder,
              lastResponse.stopReason,
              lastResponse.usage,
            )
          }
          this.appendUserContent(plan.nudge)
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
      const batchGate = await checkToolDidBatch(this.lifecycle, {
        toolBlocks,
        toolResults,
        round: rounds,
        ...(signal ? { signal } : {}),
      })
      if (batchGate.halted) {
        const refused = decideNext(
          { aborted: false, streaks, recoveriesTried },
          { kind: "tool_batch_refused", reason: batchGate.reason },
        )
        this.emit({ type: "error", ...(fatalErrorFields(batchGate.error) ?? { message: "" }) })
        await this.lifecycle.turnEnd?.({ ok: false, error: batchGate.reason || "tool.didBatch" })
        outcome = refused.kind === "stop" ? refused.outcome : "failed"
        break rounds
      }

      // A turn that executed tools also settled here (next iteration is a
      // fresh model response). Emit turn_completed before looping.
      this.emitTurnCompleted(rounds, lastResponse)
      const content = await this.nextRoundContent(
        toolResults,
        decision.salvaged,
        rounds,
        ports,
        batchGate.context,
      )
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
   * One round trip with no tools: append the user text and stream one reply.
   * It does not loop and does not retry; a
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
      const id = sent.response.providerMessageId
      this.messages.push(
        id
          ? { role: "assistant", content: sent.response.blocks, providerMessageId: id }
          : { role: "assistant", content: sent.response.blocks },
      )
    }
    return sent.response
  }
}
