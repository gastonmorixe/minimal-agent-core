/**
 * Scoped diagnostics by injection (S20, spec v2 section 2.5).
 *
 * A {@link Diagnostics} handle is how engine code reports a diagnostic. A
 * component gets one when it is constructed (AgentCore, the transport, the
 * tool executor, compaction, the plugin loader). Shared infrastructure takes
 * one per call instead: the network pool reads `diagnostics` from each
 * request, so one HTTP/2 pool serves many sessions and still attributes every
 * diagnostic to the right one. No engine code looks up a module singleton to
 * find where a diagnostic goes.
 *
 * Shapes:
 *   - {@link DiagnosticsHub}: one per runtime. `hub.diagnostics` is the
 *     runtime-level handle (startup, plugins, provider discovery). It has no
 *     session id. `hub.on` sees every diagnostic of the runtime.
 *   - {@link SessionDiagnostics}: one per session, from `hub.session(id)`.
 *     Every diagnostic it emits carries `sessionId`. `scope.on` sees only that
 *     session; the session event log subscribes there (S21,
 *     `./event-log-bridge.ts`). The hub sees them too.
 *
 * The runtime (`createRuntime`, S47) owns the hub and opens one scope per
 * session. This module keeps no state of its own.
 *
 * # Migration
 *
 * The global `diag` helpers (`src/bus/diagnostic-bus.ts`) still exist. Until a
 * call site moves to an injected handle, it emits on the process bus with no
 * session id. A hub built without its own `bus` fans out on that same process
 * bus, so the global helpers still reach the runtime's sinks: less specific,
 * never wrong. {@link processDiagnostics} is the same fallback as a handle, for
 * a component constructed without one. The ratchet in
 * `src/architecture/diag-call-sites.test.ts` counts both down to zero (S44).
 *
 * @module diagnostics/hub
 */

import {
  buildDiagnostic,
  createDiagnosticBus,
  type DiagnosticBus,
  type DiagnosticEmitter,
  type DiagnosticFilter,
  Facility,
  getDiagnosticBus,
  type LogEvent,
  Severity,
  type StructuredData,
} from "../bus/diagnostic-bus.ts"
import type { CoreErrorJson } from "../errors/types.ts"

/** Reports one diagnostic at a fixed severity. */
export type DiagnosticFn = (
  source: string,
  message: string,
  data?: StructuredData,
  error?: CoreErrorJson,
) => void

/**
 * A diagnostics handle. Same eight severity methods as the global `diag`
 * helpers, but the target is whatever the handle was built over, and a
 * session handle stamps its `sessionId` on every event.
 *
 * Name a field or parameter that holds one `diagnostics`, never `diag`: the
 * call-site ratchet counts `diag.<severity>` as a global call.
 */
export interface Diagnostics {
  /** Session every event of this handle carries. `undefined` for runtime-level handles. */
  readonly sessionId: string | undefined
  /** Emit a full event (custom facility or `ts`). A session handle stamps `sessionId`. */
  emit(event: LogEvent): void
  /** Clock of the handle (epoch ms), for helpers that build a full event. */
  readonly now?: () => number
  emergency: DiagnosticFn
  alert: DiagnosticFn
  critical: DiagnosticFn
  error: DiagnosticFn
  warn: DiagnosticFn
  notice: DiagnosticFn
  info: DiagnosticFn
  debug: DiagnosticFn
}

/** The diagnostics scope of one session. Build it with {@link DiagnosticsHub.session}. */
export interface SessionDiagnostics extends Diagnostics {
  readonly sessionId: string
  /**
   * Subscribe to this session's diagnostics only. Returns an idempotent
   * dispose function. A handler that throws is isolated, like on the bus.
   */
  on(filter: DiagnosticFilter, handler: (event: LogEvent) => void): () => void
}

/** The diagnostics hub of one runtime. Build it with {@link createDiagnosticsHub}. */
export interface DiagnosticsHub {
  /** Runtime-level handle (startup, plugins, provider discovery). No session id. */
  readonly diagnostics: Diagnostics
  /**
   * Open the scope of one session. Its events carry `sessionId`, reach
   * `scope.on` subscribers, then fan out on the hub.
   *
   * @throws RangeError when `sessionId` is empty
   */
  session(sessionId: string): SessionDiagnostics
  /**
   * Subscribe to every diagnostic of the runtime: runtime-level, every
   * session, and (while the hub uses the process bus) the global helpers.
   */
  on(filter: DiagnosticFilter, handler: (event: LogEvent) => void): () => void
}

/** Options for {@link createDiagnosticsHub}. */
export interface DiagnosticsHubOptions {
  /**
   * Where every diagnostic of the runtime fans out (file log, TUI surface,
   * web stream). Default: the process bus, resolved on each call, so the
   * global `diag` helpers and this hub share sinks until S44 removes them.
   * Pass `createDiagnosticBus()` for a runtime isolated from the process.
   */
  readonly bus?: DiagnosticBus
  /** Clock for event `ts`, epoch ms. Default `Date.now`. */
  readonly now?: () => number
}

/** Options for {@link createDiagnostics}. */
export interface DiagnosticsOptions {
  /** Session id stamped on every event. Omit for a runtime-level handle. */
  readonly sessionId?: string
  /** Clock for event `ts`, epoch ms. Default `Date.now`. */
  readonly now?: () => number
}

/**
 * Build a handle over any emitter (a bus, a test recorder). The handle never
 * throws into its producer: a throw from `target.emit` is swallowed.
 */
export function createDiagnostics(
  target: DiagnosticEmitter,
  options: DiagnosticsOptions = {},
): Diagnostics {
  const { sessionId } = options
  const now = options.now ?? Date.now
  const emit = (raw: LogEvent): void => {
    try {
      const event: LogEvent = raw.diagnostic
        ? raw
        : {
            ...raw,
            diagnostic: buildDiagnostic(raw.severity, raw.source, raw.structuredData),
          }
      target.emit(sessionId === undefined ? event : { ...event, sessionId })
    } catch {
      // A diagnostic must never break the code that reports it.
    }
  }
  const at =
    (severity: Severity): DiagnosticFn =>
    (source, message, data, error) =>
      emit({
        ts: now(),
        severity,
        facility: Facility.User,
        source,
        message,
        ...(data ? { structuredData: data } : {}),
        diagnostic: buildDiagnostic(severity, source, data, error),
      })
  return {
    sessionId,
    emit,
    now,
    emergency: at(Severity.Emergency),
    alert: at(Severity.Alert),
    critical: at(Severity.Critical),
    error: at(Severity.Error),
    warn: at(Severity.Warning),
    notice: at(Severity.Notice),
    info: at(Severity.Info),
    debug: at(Severity.Debug),
  }
}

/** Create the diagnostics hub of one runtime. See the module doc. */
export function createDiagnosticsHub(options: DiagnosticsHubOptions = {}): DiagnosticsHub {
  const { bus: ownBus, now } = options
  // Resolved per call, so a test's `resetDiagnosticBus()` reaches the hub too.
  const bus = (): DiagnosticBus => ownBus ?? getDiagnosticBus()
  const fanOut: DiagnosticEmitter = { emit: (event) => bus().emit(event) }
  return {
    diagnostics: createDiagnostics(fanOut, { ...(now ? { now } : {}) }),
    on: (filter, handler) => bus().on(filter, handler),
    session(sessionId: string): SessionDiagnostics {
      if (sessionId.length === 0) throw new RangeError("a session scope needs a session id")
      const local = createDiagnosticBus()
      const handle = createDiagnostics(
        {
          emit: (event) => {
            local.emit(event)
            fanOut.emit(event)
          },
        },
        { sessionId, ...(now ? { now } : {}) },
      )
      return { ...handle, sessionId, on: (filter, handler) => local.on(filter, handler) }
    },
  }
}

/** Runtime-level handle on the process bus, the target of {@link processDiagnostics}. */
const PROCESS_DIAGNOSTICS: Diagnostics = createDiagnostics({
  emit: (event) => getDiagnosticBus().emit(event),
})

/**
 * The handle for a component constructed without one: the process bus, no
 * session id, exactly where the global `diag` helpers go. Transitional (S20).
 * Every call is a global call site in the ratchet; pass a handle instead.
 */
export function processDiagnostics(): Diagnostics {
  return PROCESS_DIAGNOSTICS
}
