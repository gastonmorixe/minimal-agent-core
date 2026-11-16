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
import { bridgeDiagnosticsToEventLog } from "../diagnostics/event-log-bridge.ts"
import type { Diagnostics, SessionDiagnostics } from "../diagnostics/hub.ts"
import { runInDiagnosticsScope } from "../diagnostics/run-scope.ts"
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
import { hostSessionFacts } from "./host-session-facts.ts"

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
   * Opt in to realtime `text_delta` / `thinking_delta` log entries and their
   * `block_started` / `block_stopped` edges. Default `true`: `session.run`'s
   * whole point is a live entry stream.
   */
  emitDeltas?: boolean
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
  /**
   * Hook context lines (for example from `turn.willStart`) for this turn.
   * Forwarded to `AgentCore.run`, which puts them after the prompt in the
   * first user message. Ignored on a `resume`.
   */
  additionalContext?: string[]
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
   * What answers an ask when the caller supplies no `ports.askUser`.
   * `"none"` (default, decision 11: no human is assumed): leave the core's
   * askUser port unset, so a run with no per-run `askUser` override
   * (`SessionRunOptions.askUser`) answers each preflight issue at once. It
   * denies the issue with an `ask_denied` notice and a `preflight.ask-denied`
   * diag event, and sends the request unchanged (`sdk/preflight-ask.ts`).
   * The run never waits. `"registry"`: build a {@link PendingAskRegistry} so
   * `session.answer` can resolve each ask. The host must then also set
   * `askDeadlineMs`.
   */
  askUserFallback?: "registry" | "none"
  /**
   * Required with `askUserFallback: "registry"`. Time in ms that an ask
   * waits for `session.answer`. Then it resolves with its default option
   * (`isDefault`). When it has none, the issue is denied exactly as in
   * `"none"` mode: an `ask_denied` notice, a `preflight.ask-denied` diag
   * event, the request goes out unchanged, and the turn continues. A
   * `session.ask-deadline` diag event records each deadline. A pending ask
   * never waits forever. An explicit `session.answer(id, null)` still
   * cancels that send.
   */
  askDeadlineMs?: number
}

/** One running conversation. Build it with `runtime.openSession` / `runtime.resumeSession`. */
export class Session {
  readonly id: string
  /**
   * This session's diagnostics scope. Every event carries the session id
   * and reaches this session's event log as a `ch: "diag"` entry. A host
   * attaches it to a component built before the session, for example
   * `PluginLoader.attachSessionDiagnostics` (S20).
   */
  readonly diagnostics: SessionDiagnostics
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
    this.diagnostics = diagnostics
    this.log = new SessionEventLog({
      sessionId: id,
      ...(options.eventLogCapacity !== undefined ? { capacity: options.eventLogCapacity } : {}),
      ...(options.eventLogPath !== undefined ? { path: options.eventLogPath } : {}),
    })
    this.unbridge = bridgeDiagnosticsToEventLog(diagnostics, this.log)

    const callerAskUser = options.ports?.askUser
    this.askRegistry =
      !callerAskUser && options.askUserFallback === "registry"
        ? Session.buildAskRegistry(options.askDeadlineMs, diagnostics)
        : null
    const ports: HostPorts = {
      askUser: callerAskUser ?? this.askRegistry ?? undefined,
      inputQueue: options.ports?.inputQueue ?? NOOP_INPUT_QUEUE,
      reflectionGate: options.ports?.reflectionGate ?? NOOP_REFLECTION_GATE,
      compactSource: options.ports?.compactSource ?? NOOP_COMPACT_SOURCE,
    }

    this.core = buildRuntimeCore({
      ...options,
      // The hook payloads carry this session id, not the process id.
      sessionFacts: options.sessionFacts ?? (() => ({ ...hostSessionFacts(), sid: id })),
      ports,
      diagnostics: diagnostics as Diagnostics,
      eventSink: {
        kinds: ALL_EVENT_KINDS,
        emit: (event: AgentEvent) => this.log.appendEvent(event),
      },
    })
  }

  /**
   * The `"registry"` fallback. Every ask in it has a deadline.
   *
   * @throws Error when `deadlineMs` is missing or not a positive number
   */
  private static buildAskRegistry(
    deadlineMs: number | undefined,
    diagnostics: SessionDiagnostics,
  ): PendingAskRegistry {
    if (deadlineMs === undefined) {
      throw new Error('askUserFallback "registry" needs askDeadlineMs (decision 11)')
    }
    return new PendingAskRegistry({
      deadlineMs,
      onDeadline: (request, answer) => {
        diagnostics.warn(
          "session.ask-deadline",
          `no answer to "${request.title}" in ${deadlineMs} ms. ${answer === null ? "denied, the turn continues" : `chose default "${answer}"`}`,
          { askId: request.askId, code: request.code, answer: answer ?? "" },
        )
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

    // The run scope sends the diagnostics of shared components (the plugin
    // loader) to this session while the run lasts (S20).
    void runInDiagnosticsScope(this.diagnostics as Diagnostics, async (): Promise<void> => {
      try {
        const gen = this.core.run(input, {
          signal: controller.signal,
          emitDeltas: options.emitDeltas ?? true,
          ...(options.resume !== undefined ? { resume: options.resume } : {}),
          ...(options.askUser ? { askUser: options.askUser } : {}),
          ...(options.additionalContext !== undefined && options.additionalContext.length > 0
            ? { additionalContext: options.additionalContext }
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
    })

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
   * pending — already answered, never asked, resolved by the deadline,
   * or this session has no `"registry"` fallback (its own `askUser` port,
   * or the default `"none"`).
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
