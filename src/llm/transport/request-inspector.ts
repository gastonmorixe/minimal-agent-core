/**
 * The typed `llm.requestWillSend` channel: one event per outgoing request
 * attempt, for debug views (a request dump in a TUI, a plain-text log).
 *
 * Core gives DATA only. It formats no text, writes no stdio and reads no
 * environment variable (`DEBUG`, `VERBOSE`) for this channel. The host
 * decides when to subscribe and how to show the request.
 *
 * # Zero cost with no subscriber
 *
 * The send site checks {@link RequestInspector.hasSubscribers} first, and
 * makes the event only when it is true. With no subscriber, a send does one
 * `??`, one function call and one `Set.size` read: no closure, no object, no
 * string.
 * {@link RequestInspector.publish} calls its `build` thunk at most once, and
 * only when there is a subscriber.
 *
 * # Lifetime of the view
 *
 * {@link RequestSnapshot} holds the caller's arrays BY REFERENCE (no copy,
 * no freeze: a freeze would freeze the live history of the agent). The view
 * is valid only during the synchronous subscriber call. A subscriber that
 * keeps data must copy it, and must never mutate it.
 *
 * # Routing
 *
 * The transport uses `SendOptions.requestInspector` when it is set, and the
 * process channel ({@link processRequestInspector}) when it is not. This is
 * the same pattern as `opts.diagnostics ?? processDiagnostics()`. The event
 * carries the request's diagnostics handle, so a subscriber can report on
 * the SESSION scope of the request (session event log, `--diagnostics`
 * output), not only on the process bus.
 *
 * Follow-up (not done): thread a per-runtime inspector through
 * `AgentCoreConfig` / `BuildAgentCoreDeps` / `SessionOptions`, like
 * `statusPort`.
 *
 * @module llm/transport/request-inspector
 */

import { type Diagnostics, processDiagnostics } from "../../diagnostics/hub.ts"
import type { Message } from "../messages.ts"

import type { RequestType, SendOptions, SystemBlock } from "./types.ts"

/** Bus-style name of the event, for docs and logs. */
export const REQUEST_WILL_SEND = "llm.requestWillSend"

/** Diagnostics source of a failure inside the channel (a `build` or a handler threw). */
export const REQUEST_INSPECTOR_SOURCE = "transport.request-inspector"

/**
 * Deep-readonly view of a data type: arrays become readonly arrays and
 * object fields become readonly, at every depth. Type level only: no
 * runtime cost, no copy, no freeze. Functions stay as they are.
 */
type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T

/** One tool as the request sends it. */
export interface RequestToolView {
  /** Tool name. */
  readonly name: string
  /** Tool description, when the request sends one. */
  readonly description?: string
  /** JSON schema of the tool input. */
  readonly input_schema: unknown
}

/** Prompt-cache breakpoints as data (indexes), never marker text. */
export interface RequestCacheBreakpoints {
  /** Indexes in `system` whose block has `cache_control`. */
  readonly system: readonly number[]
  /** Indexes in `messages` whose LAST content block has `cache_control` (the cached prefix ends there). */
  readonly messages: readonly number[]
}

/**
 * Redacted view of one outgoing request. Allowlist only: it never holds
 * `auth`, `credentialName`, `networkClient`, `signal`, `diagnostics`,
 * ports, or callbacks. Arrays are the caller's arrays BY REFERENCE (no copy):
 * the view is valid only during the synchronous subscriber call. A
 * subscriber that keeps data must copy it, and must never mutate it. The
 * types are deep-readonly, so the compiler rejects a mutation (type level
 * only: no freeze, no clone at runtime).
 */
export interface RequestSnapshot {
  /** Model id of the request. `undefined` means the provider default. */
  readonly model: string | undefined
  /** Stream flag. Default `true`. */
  readonly stream: boolean
  /** Max output tokens, when set. */
  readonly maxTokens?: number
  /** Request kind. Default `"conversation"`. */
  readonly requestType: RequestType
  /** Adaptive thinking config, when on. Absent when off or not set. */
  readonly thinking?: DeepReadonly<{ type: "adaptive"; display?: "summarized" | "omitted" }>
  /** Effort level and structured output format, when set. */
  readonly outputConfig?: DeepReadonly<{
    effort?: string
    format?: { type: string; schema?: unknown }
  }>
  /** Speed mode, when set. */
  readonly speed?: "normal" | "fast"
  /** Tool definitions. `[]` when the request has none. */
  readonly tools: DeepReadonly<RequestToolView[]>
  /** System prompt blocks. `[]` when the request has none. */
  readonly system: DeepReadonly<SystemBlock[]>
  /** Conversation history, as sent. */
  readonly messages: DeepReadonly<Message[]>
  /** Prompt-cache breakpoints, as indexes. */
  readonly cache: RequestCacheBreakpoints
}

/**
 * The diagnostics handle of the request (its session scope under a runtime,
 * the process handle otherwise). A subscriber reports on it to keep the
 * session routing: `sessionId` stamping, the session event log and the
 * `--diagnostics` output. It is never part of {@link RequestSnapshot}.
 *
 * At runtime this is the request's FULL `Diagnostics` handle (the same
 * object, no wrapper). The `Pick` is type narrowing only: a subscriber must
 * use only the listed members (`sessionId`, `emit`, `debug`, `warn`), and
 * must not cast it back to `Diagnostics`.
 */
export type RequestDiagnostics = Pick<Diagnostics, "sessionId" | "emit" | "debug" | "warn">

/** The `llm.requestWillSend` event: one per outgoing attempt. */
export interface RequestWillSendEvent {
  /** Session of the request (from its diagnostics handle). `undefined` for runtime-level calls. */
  readonly sessionId: string | undefined
  /** Capture time, epoch ms (the clock of the diagnostics handle). */
  readonly ts: number
  /** Redacted view of the request. */
  readonly request: RequestSnapshot
  /**
   * Diagnostics handle of the request. Re-emit on it (for example
   * `diagnostics.debug(...)` or `diagnostics.emit(...)`) to reach the same
   * session-scoped sinks as other diagnostics of this request.
   */
  readonly diagnostics: RequestDiagnostics
}

/** A subscriber of the `llm.requestWillSend` event. */
export type RequestWillSendHandler = (event: RequestWillSendEvent) => void

/** Typed channel for outgoing-request inspection (debug views). */
export interface RequestInspector {
  /** True when at least one subscriber is attached. O(1). The send path checks this first. */
  hasSubscribers(): boolean
  /** Add a handler. Returns an idempotent unsubscribe. Handlers run synchronously, in order. */
  subscribe(handler: RequestWillSendHandler): () => void
  /**
   * Deliver one event. Calls `build` ONLY when there is a subscriber, and
   * at most once for all subscribers. Never throws: a throw from `build` or
   * from a handler is reported as a Warning on `diagnostics` (default: the
   * process handle), and the other handlers still run. A debug view must not
   * break a send.
   */
  publish(build: () => RequestWillSendEvent, diagnostics?: RequestDiagnostics): void
}

/** The text of a thrown value, for a diagnostic message. */
function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Report a channel failure. Never throws. */
function reportFailure(
  diagnostics: RequestDiagnostics | undefined,
  phase: "build" | "handler",
  err: unknown,
): void {
  try {
    ;(diagnostics ?? processDiagnostics()).warn(
      REQUEST_INSPECTOR_SOURCE,
      `${REQUEST_WILL_SEND} ${phase} threw: ${errorText(err)}`,
      { phase },
    )
  } catch {
    // A diagnostic must never break the send that reports it.
  }
}

/** A new, empty channel (tests, or a host that wants its own). */
export function createRequestInspector(): RequestInspector {
  const handlers = new Set<RequestWillSendHandler>()
  return {
    hasSubscribers: () => handlers.size > 0,
    subscribe(handler) {
      // A wrapper gives each subscription its own identity, so the same
      // function can subscribe twice and each unsubscribe removes one.
      const entry: RequestWillSendHandler = (event) => handler(event)
      handlers.add(entry)
      return () => {
        handlers.delete(entry)
      }
    },
    publish(build, diagnostics) {
      if (handlers.size === 0) return
      let event: RequestWillSendEvent
      try {
        event = build()
      } catch (err) {
        reportFailure(diagnostics, "build", err)
        return
      }
      for (const handler of [...handlers]) {
        try {
          handler(event)
        } catch (err) {
          reportFailure(diagnostics ?? event.diagnostics, "handler", err)
        }
      }
    },
  }
}

const PROCESS_REQUEST_INSPECTOR: RequestInspector = createRequestInspector()

/** The process channel (the fallback when `SendOptions.requestInspector` is not set). */
export function processRequestInspector(): RequestInspector {
  return PROCESS_REQUEST_INSPECTOR
}

/** True when a block-like value has a truthy `cache_control`. */
function hasCacheControl(block: unknown): boolean {
  return Boolean((block as { cache_control?: unknown } | undefined)?.cache_control)
}

/**
 * Build the redacted snapshot of a request. Fields are picked by name (an
 * allowlist; `opts` is never spread). Internal to core: the host shim does
 * not export it, because its parameter is `SendOptions`.
 *
 * @param opts - The request about to be sent.
 * @returns The by-reference view of the request.
 */
export function requestSnapshot(opts: SendOptions): RequestSnapshot {
  const system = opts.system ?? []
  const messages = opts.messages
  const cacheSystem: number[] = []
  for (let i = 0; i < system.length; i++) if (hasCacheControl(system[i])) cacheSystem.push(i)
  const cacheMessages: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const content = messages[i].content
    if (typeof content !== "string" && hasCacheControl(content[content.length - 1])) {
      cacheMessages.push(i)
    }
  }
  return {
    model: opts.model,
    stream: opts.stream ?? true,
    ...(opts.maxTokens != null ? { maxTokens: opts.maxTokens } : {}),
    requestType: opts.requestType ?? "conversation",
    ...(opts.thinking ? { thinking: opts.thinking } : {}),
    ...(opts.outputConfig ? { outputConfig: opts.outputConfig } : {}),
    ...(opts.speed ? { speed: opts.speed } : {}),
    tools: opts.tools ?? [],
    system,
    messages,
    cache: { system: cacheSystem, messages: cacheMessages },
  }
}
