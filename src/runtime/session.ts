/**
 * `Session`: one running conversation inside a `Runtime` (spec v2 section
 * 2.3, S47).
 *
 * A session owns one `AgentCore` (built through `./build-core.ts`, the
 * pure-core equivalent of the CLI's `buildAgentCore`), its own
 * `SessionEventLog` (agent E's `src/session/event-log.ts`), and its own
 * diagnostics scope (agent J's `src/diagnostics/hub.ts`), bridged into that
 * same event log (`src/diagnostics/event-log-bridge.ts`). `session.run`
 * drives one `AgentCore.run` turn and hands back the session's own log
 * entries for that run, both channels (`ch: "event"` and `ch: "diag"`), not
 * raw `AgentEvent`s: a consumer that wants everything subscribes to
 * `session.subscribe` instead, or reads the entries `run` already yielded.
 *
 * @module runtime/session
 */

import type { AskUserFn } from "../agent/preflight-pipeline.ts"
import type { TurnNotice } from "../agent/turn-notice.ts"
import { bridgeDiagnosticsToEventLog } from "../diagnostics/event-log-bridge.ts"
import type { Diagnostics, SessionDiagnostics } from "../diagnostics/hub.ts"
import { type AgentCore, type TurnResult } from "../sdk/agent-core.ts"
import { type AgentEvent, ALL_EVENT_KINDS } from "../sdk/events.ts"
import type { HostPorts } from "../sdk/ports.ts"
import type { RoundCheckpoint } from "../sdk/round-checkpoint.ts"
import {
  type SessionEntry,
  type SessionEntryListener,
  SessionEventLog,
  type SubscribeOptions,
  type Unsubscribe,
} from "../session/event-log.ts"

import { buildRuntimeCore, type RuntimeCoreDeps } from "./build-core.ts"
import {
  NOOP_COMPACT_SOURCE,
  NOOP_INPUT_QUEUE,
  NOOP_REFLECTION_GATE,
  PendingAskRegistry,
} from "./host-ports-defaults.ts"

export type { SessionEntry, SessionEntryListener, SubscribeOptions, Unsubscribe }

/** `session.run` options forwarded to `AgentCore.run`. */
export interface SessionRunOptions {
  /** Aborts this run in addition to `session.abort()`. */
  signal?: AbortSignal
  /**
   * Continue a turn a permanent error paused, or that a crash cut short,
   * from its last round checkpoint (S50) instead of starting a new turn.
   */
  resume?: boolean
  /**
   * Opt in to realtime `text_delta` / `thinking_delta` log entries. Default
   * `true`: `session.run`'s whole point is a live entry stream.
   */
  emitDeltas?: boolean
  onThinkingStart?: () => void | Promise<void>
  onThinkingChunk?: (chunk: string) => void | Promise<void>
  onThinkingStop?: () => void | Promise<void>
  onTextStop?: () => void | Promise<void>
  onNotice?: (notice: TurnNotice) => void | Promise<void>
  /**
   * Per-run override for this turn's preflight `askUser` port (S17). Wins
   * over whatever port the session was built with (`openSession`'s
   * `ports.askUser` / `askUserFallback`) — see `host-ports.ts#runPorts`,
   * which `AgentCore.run` already applies underneath this call. A host
   * that asks interactively per-turn (e.g. a TUI that only wires a modal
   * when one is actually mounted) passes it here instead of at
   * construction time.
   */
  askUser?: AskUserFn
  /** Per-run override for this turn's queued-input drain (S17). */
  drainQueuedUserText?: () => string | null
  /** Notified when the loop injects text this run's `drainQueuedUserText` drained. */
  onQueueInject?: (text: string) => void
  /** Per-run override for this turn's reflection-checkpoint gate (S17). */
  beforeReflectionCheckpoint?: (round: number) => void | Promise<void>
}

/**
 * Everything `runtime/runtime.ts` needs to construct a {@link Session}. A
 * trimmed, CLI-free `RuntimeCoreDeps`: the host-only fields
 * (`initialCheckpoint`, `ports`, `diagnostics`, `eventSink`) are supplied by
 * the session itself, not the caller of `openSession`.
 */
export type SessionOptions = Omit<
  RuntimeCoreDeps,
  "initialCheckpoint" | "ports" | "diagnostics" | "eventSink"
> & {
  /** Caller-supplied ports. Anything left out gets the headless default. */
  ports?: Partial<HostPorts>
  /** Ring buffer size of the session's event log. Default: the log's own default. */
  eventLogCapacity?: number
  /** Durable JSONL sidecar path for the event log. Omit for memory-only. */
  eventLogPath?: string
  /** Round checkpoint to resume an unfinished turn from (S50, `resumeSession`). */
  initialCheckpoint?: RoundCheckpoint
  /**
   * Default when the caller supplies no `ports.askUser`. `"registry"`
   * (default): build a {@link PendingAskRegistry} so `session.answer`
   * always has something to resolve — the original headless default.
   * `"none"`: leave the core's askUser port unset at construction, so a
   * run with no per-run `askUser` override (`SessionRunOptions.askUser`)
   * denies each preflight issue with an `ask_denied` notice and sends the
   * request unchanged, matching `AgentCore`'s own "no port" fallback
   * (`sdk/preflight-ask.ts`). A host that asks per-turn rather than
   * per-session (e.g. one session shared by an interactive and a
   * one-shot code path) wants this.
   */
  askUserFallback?: "registry" | "none"
}

/** One running conversation. Build it with `runtime.openSession` / `runtime.resumeSession`. */
export class Session {
  readonly id: string
  private readonly log: SessionEventLog
  private readonly core: AgentCore
  private readonly askRegistry: PendingAskRegistry | null
  private readonly unbridge: () => void
  private readonly closeCallbacks: Array<() => void> = []
  private closed = false
  private running = false
  private activeAbort: AbortController | null = null

  constructor(id: string, diagnostics: SessionDiagnostics, options: SessionOptions) {
    this.id = id
    this.log = new SessionEventLog({
      sessionId: id,
      ...(options.eventLogCapacity !== undefined ? { capacity: options.eventLogCapacity } : {}),
      ...(options.eventLogPath !== undefined ? { path: options.eventLogPath } : {}),
    })
    this.unbridge = bridgeDiagnosticsToEventLog(diagnostics, this.log)

    const callerAskUser = options.ports?.askUser
    const wantsAskRegistry =
      !callerAskUser && (options.askUserFallback ?? "registry") === "registry"
    this.askRegistry = wantsAskRegistry ? new PendingAskRegistry() : null
    const ports: HostPorts = {
      askUser: callerAskUser ?? this.askRegistry ?? undefined,
      inputQueue: options.ports?.inputQueue ?? NOOP_INPUT_QUEUE,
      reflectionGate: options.ports?.reflectionGate ?? NOOP_REFLECTION_GATE,
      compactSource: options.ports?.compactSource ?? NOOP_COMPACT_SOURCE,
    }

    this.core = buildRuntimeCore({
      ...options,
      ports,
      diagnostics: diagnostics as Diagnostics,
      eventSink: {
        kinds: ALL_EVENT_KINDS,
        emit: (event: AgentEvent) => this.log.appendEvent(event),
      },
    })
  }

  /**
   * Drive one `AgentCore.run` turn. The returned iterable yields this
   * session's own log entries (`ch: "event"` and `ch: "diag"`) produced
   * from now on, in order, until the turn ends — then it ends too. The
   * run starts immediately; it does not wait for the first `next()` call,
   * so many sessions can run concurrently without anyone iterating yet.
   * Its `result` property resolves with the same `TurnResult`
   * `AgentCore.run` itself returns (outcome, and the pausing error for
   * `outcome: "waiting"`) — the entry stream alone cannot carry a raw
   * error object. It never rejects on its own; await the iterable first
   * (it throws on a run failure) before reading `result` for the outcome.
   *
   * @throws Error when the session is closed, or already running a turn
   */
  run(
    input: string,
    options: SessionRunOptions = {},
  ): AsyncIterable<SessionEntry> & { readonly result: Promise<TurnResult> } {
    if (this.closed) throw new Error(`session ${this.id} is closed`)
    if (this.running) throw new Error(`session ${this.id} already has a run in progress`)
    this.running = true

    const startSeq = this.log.stats().nextSeq
    const controller = new AbortController()
    this.activeAbort = controller
    const { signal: callerSignal } = options
    if (callerSignal) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason)
      else {
        callerSignal.addEventListener("abort", () => controller.abort(callerSignal.reason), {
          once: true,
        })
      }
    }

    const queue: SessionEntry[] = []
    let wake: (() => void) | null = null
    let done = false
    let failure: unknown
    const unsubscribe = this.log.subscribe(
      (entry) => {
        queue.push(entry)
        const w = wake
        wake = null
        w?.()
      },
      { fromSeq: startSeq },
    )

    const finish = (): void => {
      done = true
      unsubscribe()
      this.activeAbort = null
      this.running = false
      const w = wake
      wake = null
      w?.()
    }

    let settleResult: (value: TurnResult) => void = () => {}
    let failResult: (reason: unknown) => void = () => {}
    const result = new Promise<TurnResult>((resolve, reject) => {
      settleResult = resolve
      failResult = reject
    })
    // A caller that only drains the entry stream (the common case: the
    // iterable itself already throws on failure) never touches `result`.
    // Attach a handler now so that path never surfaces an unhandled
    // rejection; a caller that does read `result` still gets its real
    // rejection (a promise may have many listeners).
    result.catch(() => {})

    void (async (): Promise<void> => {
      try {
        const gen = this.core.run(input, {
          signal: controller.signal,
          emitDeltas: options.emitDeltas ?? true,
          ...(options.resume !== undefined ? { resume: options.resume } : {}),
          ...(options.onThinkingStart ? { onThinkingStart: options.onThinkingStart } : {}),
          ...(options.onThinkingChunk ? { onThinkingChunk: options.onThinkingChunk } : {}),
          ...(options.onThinkingStop ? { onThinkingStop: options.onThinkingStop } : {}),
          ...(options.onTextStop ? { onTextStop: options.onTextStop } : {}),
          ...(options.onNotice ? { onNotice: options.onNotice } : {}),
          ...(options.askUser ? { askUser: options.askUser } : {}),
          ...(options.drainQueuedUserText
            ? { drainQueuedUserText: options.drainQueuedUserText }
            : {}),
          ...(options.onQueueInject ? { onQueueInject: options.onQueueInject } : {}),
          ...(options.beforeReflectionCheckpoint
            ? { beforeReflectionCheckpoint: options.beforeReflectionCheckpoint }
            : {}),
        })
        let step = await gen.next()
        while (!step.done) step = await gen.next()
        settleResult(step.value)
      } catch (error) {
        failure = error
        failResult(error)
      } finally {
        finish()
      }
    })()

    return {
      result,
      [Symbol.asyncIterator](): AsyncIterator<SessionEntry> {
        return (async function* drain(): AsyncGenerator<SessionEntry, void, undefined> {
          while (true) {
            while (queue.length > 0) {
              const entry = queue.shift()
              if (entry !== undefined) yield entry
            }
            if (done) break
            await new Promise<void>((resolve) => {
              wake = resolve
            })
          }
          if (failure !== undefined) throw failure
        })()
      },
    }
  }

  /** Subscribe to this session's log. See `SessionEventLog.subscribe`. */
  subscribe(listener: SessionEntryListener, options: SubscribeOptions = {}): Unsubscribe {
    return this.log.subscribe(listener, options)
  }

  /**
   * The underlying `AgentCore`. An escape hatch for host operations
   * outside the session-driving contract — model switching, manual
   * `compact`, turn-state bookkeeping (`history`, `appendNote`,
   * `rollbackPendingTurn`, ...), or a host-owned live history rewrite
   * (`replaceMessages`). Never for running a turn; use `run()` for that.
   */
  agentCore(): AgentCore {
    return this.core
  }

  /**
   * Answer a pending `ask_user`. Returns `false` when `askId` is not
   * pending — already answered, never asked, or this session was built
   * with its own `askUser` port (then that port owns resolving it, not
   * this method).
   */
  answer(askId: string, answer: string | null): boolean {
    return this.askRegistry?.answer(askId, answer) ?? false
  }

  /** Abort the run in progress, if any. A no-op with no run in progress. */
  abort(reason?: unknown): void {
    this.activeAbort?.abort(reason)
  }

  /** Register a callback run once, when this session closes. For `runtime/runtime.ts`. */
  onClose(callback: () => void): void {
    this.closeCallbacks.push(callback)
  }

  /**
   * Stop this session: abort any run in progress, decline every pending
   * `ask_user`, and stop bridging diagnostics into the event log. Does not
   * remove its durable files. Idempotent.
   */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.activeAbort?.abort(new Error(`session ${this.id} closed`))
    this.askRegistry?.declineAll()
    this.unbridge()
    for (const callback of this.closeCallbacks) callback()
  }
}
