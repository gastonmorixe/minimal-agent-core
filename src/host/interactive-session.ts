/**
 * Tier-2 interactive host layer: queue/abort/status wiring around a
 * `createRuntime`/`openSession` {@link Session}.
 *
 * Owns interaction concerns the conversation engine must not import
 * (reflection cooldown with Esc-skip, per-turn transcript rebinding,
 * ReplAgentLike surface). The REPL and other interactive frontends consume
 * this instead of calling the legacy {@link Agent} loop.
 *
 * Drives its turn through the same `createRuntime` / `openSession` /
 * `Session` contract `minimal-agent-web` already runs in production (agent
 * M's S47): a session owns one `AgentCore`, built from the host's real
 * collaborators (plugin-loaded tool registry, mode manager, session store,
 * lifecycle hooks, ...) via the same adapters `buildAgentCore` uses, so a
 * `--prompt` or `--output-format text` run through this class is byte-
 * identical to before — only the assembly seam changed, not the engine.
 *
 * @module host/interactive-session
 */

import type { CompactRequestOpts } from "../agent/context-compact.ts"
import type { AskUserFn } from "../agent/preflight-pipeline.ts"
import type { TurnNotice } from "../agent/turn-notice.ts"
import { GLOBAL_STATUS_BUS } from "../bus/status.ts"
import { inputCaptureStack } from "../input/input-capture-stack.ts"
import type { Message } from "../llm/messages.ts"
import type { PreflightIssue } from "../llm/provider.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"
import type { ModeManager } from "../modes/modes.ts"
import { takePendingCompact } from "../plugins/host/providers/context-compact.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import type { ManifestMode } from "../plugins/types.ts"
import { createRuntime } from "../runtime/runtime.ts"
import type { Session, SessionEntry } from "../runtime/session.ts"
import { toolFilterFromNamePolicy } from "../sdk/tool-filter.ts"
import { loadBlobStoreConfig } from "../session/blob-store.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { runReflectionCooldown } from "./reflection-cooldown.ts"
import type { ReplAgentLike } from "./repl.ts"
import { type BuildAgentCoreDeps, toEffort } from "./sdk-adapters/build-agent-core.ts"
import { createLifecyclePort } from "./sdk-adapters/lifecycle-port-adapter.ts"
import { MediaResolverAdapter } from "./sdk-adapters/media-resolver-adapter.ts"
import { ModeProviderAdapter } from "./sdk-adapters/mode-provider-adapter.ts"
import { PromptContributorAdapter } from "./sdk-adapters/prompt-contributor-adapter.ts"
import { SessionPersistenceAdapter } from "./sdk-adapters/session-persistence-adapter.ts"
import { ToolExecutorAdapter } from "./sdk-adapters/tool-executor-adapter.ts"
import { ToolRegistryAdapter } from "./sdk-adapters/tool-registry-adapter.ts"

type MaybePromise<T> = T | Promise<T>

type TranscriptWriter = (line: string) => void

/** Input handed to the interactive host's reflection checkpoint behavior. */
export interface ReflectionCheckpointContext {
  round: number
  cooldownMs: number
  signal?: AbortSignal
}

/**
 * Interactive reflection behavior. The implementation owns completion, abort,
 * and any host-specific skip affordance such as temporarily capturing Esc.
 */
export interface ReflectionCheckpointBehavior {
  wait(context: ReflectionCheckpointContext): Promise<void>
}

/**
 * Run-scoped transcript router. A lease cannot overwrite another active run,
 * and releasing a stale lease cannot disturb the current route.
 */
export class TranscriptRouter {
  private active: symbol | null = null
  private current: TranscriptWriter

  constructor(private readonly fallback: TranscriptWriter = () => {}) {
    this.current = fallback
  }

  readonly write = (line: string): void => {
    this.current(line)
  }

  acquire(writer?: TranscriptWriter): () => void {
    if (this.active !== null) {
      throw new Error("InteractiveSession already has an active run")
    }
    const lease = Symbol("interactive-session-transcript")
    this.active = lease
    this.current = writer ?? this.fallback
    return () => {
      if (this.active !== lease) return
      this.active = null
      this.current = this.fallback
    }
  }
}

export type InteractiveSessionDeps = BuildAgentCoreDeps & {
  /** Mode manager for prompt/status/cycling (same instance as buildAgentCore). */
  modeManager: ModeManager | null
  /** Injectable interactive reflection behavior. Defaults to the real TUI cooldown. */
  reflectionCheckpoint?: ReflectionCheckpointBehavior
}

const DEFAULT_REFLECTION_CHECKPOINT: ReflectionCheckpointBehavior = {
  async wait({ round, cooldownMs, signal }): Promise<void> {
    await runReflectionCooldown({
      totalMs: cooldownMs,
      round,
      statusBus: GLOBAL_STATUS_BUS,
      inputCaptureStack,
      ...(signal ? { signal } : {}),
    })
  },
}

/**
 * Build the `Session` behind one {@link InteractiveSession}: the same
 * host collaborators `buildAgentCore` wires (plugin-loaded tool registry,
 * mode manager, session persistence, lifecycle hooks, media resolver),
 * assembled from the exact same adapter classes, but handed to
 * `createRuntime().openSession(...)` instead of `new AgentCore(...)`.
 *
 * `askUserFallback: "none"`: this session is shared by the interactive
 * REPL (which may pass its own per-run `askUser` when a modal is actually
 * mounted) and the non-interactive `--prompt` path (which never does). With
 * no per-run override, a preflight issue must be denied with an
 * `ask_denied` notice and sent unchanged — `AgentCore`'s own headless
 * fallback — not asked through `Session`'s default `PendingAskRegistry`
 * (which would wait forever for a `session.answer()` nobody will call).
 */
async function openInteractiveSession(
  deps: InteractiveSessionDeps,
  writeTranscript: TranscriptWriter,
): Promise<Session> {
  // Tool registry: core built-ins + plugin tools, with presentation + aliases.
  const toolRegistry = new ToolRegistryAdapter(deps.loader)

  // Tool executor: runs executeToolRound verbatim. It is the SOLE persister of
  // tool_result records (with blob + presentation fidelity), so it gets the
  // store; the session-persistence adapter no-ops appendToolResult.
  const hooks = deps.loader && typeof deps.loader.hooks === "function" ? deps.loader.hooks() : null
  const lifecycle = createLifecyclePort(hooks)

  const toolExecutor = new ToolExecutorAdapter({
    presentation: toolRegistry.presentation(),
    loader: deps.loader,
    modeManager: deps.modeManager,
    blobStore: deps.blobStore,
    blobSkipTools: loadBlobStoreConfig().skipTools,
    feedbackTracker: new ToolFeedbackTracker(),
    toolTimeTracker: deps.toolTimeTracker ?? null,
    codeHighlighter: deps.codeHighlighter ?? null,
    model: deps.model,
    store: deps.store,
    fileTrackingStore: deps.fileTrackingStore,
    writeTranscript,
    lifecycle,
    ...(deps.toolEnv ? { toolEnv: deps.toolEnv } : {}),
  })

  // Prompt contributor: awaits the plugin prompt block once (parity seam),
  // plus save-echoes and per-turn attachment producers.
  const promptContributor = await PromptContributorAdapter.create({
    loader: deps.loader,
    saveEcho: deps.saveEcho,
    turnAttachments: deps.turnAttachments,
  })

  // Session persistence: user/assistant/note/rewind only (tool_result owned by
  // the executor adapter). Omitted entirely when no store is wired.
  const sessionPersistence = deps.store ? new SessionPersistenceAdapter(deps.store) : undefined

  // Mode provider: the mode-change signal + read-only queries.
  const modeProvider = deps.modeManager ? new ModeProviderAdapter(deps.modeManager) : undefined

  // Advertisement filter: CLI/SDK name policy → structural ToolAdvertisementFilter.
  const toolFilter =
    deps.toolNamePolicy != null ? toolFilterFromNamePolicy(deps.toolNamePolicy) : undefined

  // Media resolver: ingest inline @file / image refs using the run's model.
  const mediaResolver = new MediaResolverAdapter(deps.model)

  const runtime = createRuntime()
  return runtime.openSession({
    auth: deps.auth,
    model: deps.model,
    ...(deps.providerId !== undefined ? { providerId: deps.providerId } : {}),
    ...(deps.credentialName !== undefined ? { credentialName: deps.credentialName } : {}),
    ...(toEffort(deps.effort) !== undefined ? { effort: toEffort(deps.effort) } : {}),
    ...(deps.outputSchema !== undefined ? { outputSchema: deps.outputSchema } : {}),
    ...(deps.speed !== undefined ? { speed: deps.speed } : {}),
    ...(deps.serviceTier !== undefined ? { serviceTier: deps.serviceTier } : {}),
    ...(deps.thinkingDisplay !== undefined ? { thinkingDisplay: deps.thinkingDisplay } : {}),
    ...(deps.cacheTtl !== undefined ? { cacheTtl: deps.cacheTtl } : {}),
    ...(deps.initialMessages !== undefined ? { initialMessages: deps.initialMessages } : {}),
    ...(deps.initialCheckpoint !== undefined ? { initialCheckpoint: deps.initialCheckpoint } : {}),
    ...(deps.sendFn !== undefined ? { sendFn: deps.sendFn } : {}),
    ...(deps.networkClient !== undefined ? { networkClient: deps.networkClient } : {}),
    toolRegistry,
    ...(toolFilter ? { toolFilter } : {}),
    toolExecutor,
    // Interactive hosts pass writeTranscript; headless `--json` uses no-op.
    transcriptSink: { write: writeTranscript },
    ...(sessionPersistence ? { sessionPersistence } : {}),
    promptContributors: [promptContributor],
    ...(modeProvider ? { modeProvider } : {}),
    mediaResolver,
    lifecycle,
    // `systemPrompt` + `maxTokens` are vestigial, like `buildAgentCore`'s own
    // config: `run()` derives both itself.
    systemPrompt: "",
    maxTokens: 0,
    ...(deps.systemPromptOverrides ? { systemPromptOverrides: deps.systemPromptOverrides } : {}),
    ...(deps.reflectionInterval !== undefined
      ? { reflectionInterval: deps.reflectionInterval }
      : {}),
    ...(deps.reflectionCooldownMs !== undefined
      ? { reflectionCooldownMs: deps.reflectionCooldownMs }
      : {}),
    ...(deps.retry !== undefined ? { retry: deps.retry } : {}),
    ...(deps.statusPort !== undefined ? { statusPort: deps.statusPort } : {}),
    ...(deps.pluginEvents !== undefined ? { pluginEvents: deps.pluginEvents } : {}),
    // S17/S27: the `compactSource` port reads the plugin host's
    // `context:compact` queue, exactly like `buildAgentCore`.
    ports: { compactSource: { take: () => takePendingCompact() } },
    askUserFallback: "none",
  })
}

/**
 * Interactive session: a `Session` + Tier-2 hooks implementing
 * {@link ReplAgentLike}.
 */
export class InteractiveSession implements ReplAgentLike {
  private constructor(
    private readonly session: Session,
    private readonly loader: PluginLoader | null,
    private readonly modeManager: ModeManager | null,
    private readonly transcript: TranscriptRouter,
    private readonly reflectionCheckpoint: ReflectionCheckpointBehavior,
  ) {}

  /**
   * Build a fully-wired session (`Session` + interactive transcript bridge).
   */
  static async create(deps: InteractiveSessionDeps): Promise<InteractiveSession> {
    const transcript = new TranscriptRouter(deps.writeTranscript)
    const session = await openInteractiveSession(deps, transcript.write)
    return new InteractiveSession(
      session,
      deps.loader,
      deps.modeManager,
      transcript,
      deps.reflectionCheckpoint ?? DEFAULT_REFLECTION_CHECKPOINT,
    )
  }

  /**
   * Underlying engine (tests / slash-command bridges / the live-area host's
   * history-edit rewrite). An escape hatch for operations outside the
   * session-driving contract — never for running a turn; use `run()`.
   */
  agentCore() {
    return this.session.agentCore()
  }

  pluginLoader(): PluginLoader | null {
    return this.loader
  }

  modes(): ModeManager | null {
    return this.modeManager
  }

  getActiveMode(): ManifestMode | null {
    return this.modeManager?.active() ?? null
  }

  getModel(): string {
    return this.session.agentCore().getModel()
  }

  setModel(model: string): void {
    this.session.agentCore().setModel(model)
  }

  history(): Message[] {
    return this.session.agentCore().history()
  }

  appendNote(text: string): void {
    this.session.agentCore().appendNote(text)
  }

  rollbackPendingTurn(): boolean {
    return this.session.agentCore().rollbackPendingTurn()
  }

  notePreviousTurnAborted(): void {
    this.session.agentCore().notePreviousTurnAborted()
  }

  noteSessionResumed(): void {
    this.session.agentCore().noteSessionResumed()
  }

  compact(opts?: CompactRequestOpts) {
    return this.session.agentCore().compact(opts)
  }

  /**
   * Run one user turn through the session, with interactive cooldown +
   * per-turn transcript rebinding. Drives `session.run()` and remaps its
   * `text_delta` log entries back onto the plain yielded-string channel
   * `ReplAgentLike.run` promises (every chunk `AgentCore.sendAttempt`
   * yields is also emitted as a `text_delta` event with the identical
   * text, in the same order, when `emitDeltas` is on — `session.run`'s
   * default).
   */
  async *run(
    userText: string,
    opts?: {
      onTranscriptLine?: (line: string) => void
      onThinkingStart?: () => MaybePromise<void>
      onThinkingChunk?: (chunk: string) => MaybePromise<void>
      onThinkingStop?: () => MaybePromise<void>
      onTextStop?: () => MaybePromise<void>
      onNotice?: (notice: TurnNotice) => MaybePromise<void>
      drainQueuedUserText?: () => string | null
      onQueueInject?: (text: string) => void
      signal?: AbortSignal
      askUser?: (issue: PreflightIssue) => Promise<string | null>
    },
  ): AsyncGenerator<string, StreamedResponse, undefined> {
    const releaseTranscript = this.transcript.acquire(opts?.onTranscriptLine)
    let entries: ReturnType<Session["run"]> | undefined
    let settled = false
    try {
      entries = this.session.run(userText, {
        ...(opts?.signal ? { signal: opts.signal } : {}),
        ...(opts?.onThinkingStart ? { onThinkingStart: opts.onThinkingStart } : {}),
        ...(opts?.onThinkingChunk ? { onThinkingChunk: opts.onThinkingChunk } : {}),
        ...(opts?.onThinkingStop ? { onThinkingStop: opts.onThinkingStop } : {}),
        ...(opts?.onTextStop ? { onTextStop: opts.onTextStop } : {}),
        ...(opts?.onNotice ? { onNotice: opts.onNotice } : {}),
        ...(opts?.askUser ? { askUser: opts.askUser as AskUserFn } : {}),
        ...(opts?.drainQueuedUserText ? { drainQueuedUserText: opts.drainQueuedUserText } : {}),
        ...(opts?.onQueueInject ? { onQueueInject: opts.onQueueInject } : {}),
        beforeReflectionCheckpoint: async (round: number) => {
          await this.reflectionCheckpoint.wait({
            round,
            cooldownMs: this.session.agentCore().getReflectionCooldownMs(),
            ...(opts?.signal ? { signal: opts.signal } : {}),
          })
        },
      })
      for await (const entry of entries) {
        if (isTextDelta(entry)) yield entry.data.text
      }
      settled = true
      const result = await entries.result
      // A permanent error paused the run (outcome `waiting`). This host shows
      // it the way it shows any failed turn; the session stays open and the
      // user's next prompt is the next run on the same history.
      if (result.outcome === "waiting") throw result.error
      return result
    } finally {
      if (!settled && entries) {
        // The consumer closed the generator before the turn settled (e.g. a
        // stale run abandoned for a fresh one). Abort it and drain to its
        // natural end so `session.run()` is never called again while this
        // run is still finishing in the background — `for await` over the
        // session's own entries only returns once its internal bookkeeping
        // has already released the "running" lease.
        this.session.abort(new Error("InteractiveSession.run closed before the turn settled"))
        try {
          for await (const _entry of entries) {
            // drain only; already abandoned by the caller
          }
        } catch {
          // Already reported (or about to be, to nobody) via entries.result.
        }
      }
      releaseTranscript()
    }
  }
}

/** True for a `SessionEntry` carrying a `text_delta` event. */
function isTextDelta(
  entry: SessionEntry,
): entry is SessionEntry & { ch: "event"; data: { type: "text_delta"; text: string } } {
  return entry.ch === "event" && entry.data.type === "text_delta"
}
