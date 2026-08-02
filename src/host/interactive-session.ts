/**
 * Tier-2 interactive host layer: queue/abort/status wiring around
 * {@link AgentCore}.
 *
 * Owns interaction concerns the conversation engine must not import
 * (reflection cooldown with Esc-skip, per-turn transcript rebinding,
 * ReplAgentLike surface). The REPL and other interactive frontends consume
 * this instead of calling the legacy {@link Agent} loop.
 *
 * @module host/interactive-session
 */

import { runReflectionCooldown } from "../agent/reflection.ts"
import type { TurnNotice } from "../agent/turn-notice.ts"
import { GLOBAL_STATUS_BUS } from "../bus/status.ts"
import { inputCaptureStack } from "../input/input-capture-stack.ts"
import type { Message } from "../llm/messages.ts"
import type { PreflightIssue } from "../llm/provider.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"
import type { ModeManager } from "../modes/modes.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import type { ManifestMode } from "../plugins/types.ts"
import { AgentCore } from "../sdk/agent-core.ts"

import type { ReplAgentLike } from "./repl.ts"
import { type BuildAgentCoreDeps, buildAgentCore } from "./sdk-adapters/build-agent-core.ts"

type MaybePromise<T> = T | Promise<T>

/** Mutable transcript sink so each `run` can rebind the host's line writer. */
export class MutableTranscriptSink {
  current: (line: string) => void = () => {}
  write = (line: string): void => {
    this.current(line)
  }
}

export type InteractiveSessionDeps = BuildAgentCoreDeps & {
  /** Mode manager for prompt/status/cycling (same instance as buildAgentCore). */
  modeManager: ModeManager | null
}

/**
 * Interactive session: {@link AgentCore} + Tier-2 hooks implementing
 * {@link ReplAgentLike}.
 */
export class InteractiveSession implements ReplAgentLike {
  private constructor(
    private readonly core: AgentCore,
    private readonly loader: PluginLoader | null,
    private readonly modeManager: ModeManager | null,
    private readonly transcript: MutableTranscriptSink,
  ) {}

  /**
   * Build a fully-wired session (AgentCore + interactive transcript bridge).
   */
  static async create(deps: InteractiveSessionDeps): Promise<InteractiveSession> {
    const transcript = new MutableTranscriptSink()
    const core = await buildAgentCore({
      ...deps,
      writeTranscript: (line) => transcript.write(line),
    })
    return new InteractiveSession(core, deps.loader, deps.modeManager, transcript)
  }

  /** Underlying conversation engine (tests / slash-command bridges). */
  agentCore(): AgentCore {
    return this.core
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
    return this.core.getModel()
  }

  setModel(model: string): void {
    this.core.setModel(model)
  }

  history(): Message[] {
    return this.core.history()
  }

  appendNote(text: string): void {
    this.core.appendNote(text)
  }

  rollbackPendingTurn(): boolean {
    return this.core.rollbackPendingTurn()
  }

  notePreviousTurnAborted(): void {
    this.core.notePreviousTurnAborted()
  }

  noteSessionResumed(): void {
    this.core.noteSessionResumed()
  }

  compact(opts?: { reason?: "manual" | "auto" | "exceeded"; preferRemote?: boolean }) {
    return this.core.compact(opts)
  }

  /**
   * Run one user turn through AgentCore, with interactive cooldown +
   * per-turn transcript rebinding.
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
    const prev = this.transcript.current
    this.transcript.current = opts?.onTranscriptLine ?? (() => {})
    try {
      return yield* this.core.run(userText, {
        onThinkingStart: opts?.onThinkingStart,
        onThinkingChunk: opts?.onThinkingChunk,
        onThinkingStop: opts?.onThinkingStop,
        onTextStop: opts?.onTextStop,
        onNotice: opts?.onNotice,
        drainQueuedUserText: opts?.drainQueuedUserText,
        onQueueInject: opts?.onQueueInject,
        signal: opts?.signal,
        askUser: opts?.askUser,
        beforeReflectionCheckpoint: async (round) => {
          await runReflectionCooldown({
            totalMs: this.core.getReflectionCooldownMs(),
            round,
            statusBus: GLOBAL_STATUS_BUS,
            inputCaptureStack,
            ...(opts?.signal ? { signal: opts.signal } : {}),
          })
        },
      })
    } finally {
      this.transcript.current = prev
    }
  }
}
