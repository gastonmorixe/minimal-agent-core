/**
 * Singleton diagnostic bus + typed log event shape.
 *
 * This is the fan-out hub for in-process log events. Producers
 * (live-area scheduler, auth refresh, plugin loader, …) call
 * {@link diag} helpers (`diag.warn(...)`, `diag.error(...)`, etc.); sinks
 * (file logger, TUI surface, opt-in stderr mirror) subscribe via
 * {@link DiagnosticBus.on}.
 *
 * # Why a dedicated bus, not piggyback on the plugin event-bus
 *
 * - **Strong typing.** `LogEvent` is a fixed shape with severity/facility
 *   per RFC 5424. The plugin event-bus is intentionally untyped (any
 *   event name, any payload).
 * - **Independent lifecycle.** Sinks attach at boot before the plugin
 *   loader exists; tests can spin up isolated buses without touching
 *   global plugin state.
 * - **Discoverability.** A developer reading this file sees the entire
 *   diagnostic contract in one place.
 *
 * # Stateless fan-out
 *
 * The bus stores nothing. `emit()` is sync and multicasts to every
 * subscriber on the calling stack, in registration order. A handler
 * that throws is isolated — its error is swallowed, subsequent handlers
 * still run, the producer is never disturbed.
 *
 * # Singleton + isolated variants
 *
 * - {@link getDiagnosticBus} returns the process-wide singleton. First
 *   call constructs it lazily.
 * - {@link createDiagnosticBus} returns a fresh isolated instance,
 *   useful for tests.
 * - {@link resetDiagnosticBus} drops the singleton (next
 *   `getDiagnosticBus()` returns a new one). Test-only escape hatch.
 *
 * @module diagnostic-bus
 */

// ---------------------------------------------------------------------------
// RFC 5424 numeric codes
// ---------------------------------------------------------------------------

/**
 * RFC 5424 severity. Lower number = more severe.
 *
 * The bus does not interpret severity itself; it's metadata on the
 * event. Sinks decide what to do (file logs all; TUI shows only
 * warning + more severe).
 */
export const enum Severity {
  Emergency = 0,
  Alert = 1,
  Critical = 2,
  Error = 3,
  Warning = 4,
  Notice = 5,
  Info = 6,
  Debug = 7,
}

/**
 * RFC 5424 facility. We default to `User` (1) for app messages.
 * `Local0..Local7` are available for producers that want to namespace
 * by subsystem at the syslog level.
 */
export const enum Facility {
  Kern = 0,
  User = 1,
  Mail = 2,
  Daemon = 3,
  Auth = 4,
  Syslog = 5,
  Lpr = 6,
  News = 7,
  Uucp = 8,
  Cron = 9,
  AuthPriv = 10,
  Ftp = 11,
  // 12..15 unused
  Local0 = 16,
  Local1 = 17,
  Local2 = 18,
  Local3 = 19,
  Local4 = 20,
  Local5 = 21,
  Local6 = 22,
  Local7 = 23,
}

// ---------------------------------------------------------------------------
// Event shape
// ---------------------------------------------------------------------------

/**
 * Free-form key/value pairs that get serialized into RFC 5424
 * STRUCTURED-DATA. Keys with `=`, `]`, `"`, or whitespace are sanitized
 * to underscore by the formatter; values are escape-quoted.
 */
export type StructuredData = Readonly<Record<string, string | number | boolean>>

/**
 * A single diagnostic event.
 *
 * Producers usually construct these via the {@link diag} helpers. Direct
 * `bus.emit(...)` is fine when you want to set non-default fields
 * (facility, custom ts).
 */
export interface LogEvent {
  /** Capture-time epoch ms. Sinks format to RFC 3339. */
  readonly ts: number
  readonly severity: Severity
  readonly facility: Facility
  /**
   * Dotted-kebab source id. Convention: `<subsystem>.<event>`, e.g.
   * `live-area.timeout`, `auth.refresh`, `plugin-loader.import-failed`.
   *
   * Used as the RFC 5424 MSGID — make it grep-friendly.
   */
  readonly source: string
  /** Single-line message. CR/LF are escaped by the formatter. */
  readonly message: string
  /** Optional RFC 5424 STRUCTURED-DATA values. */
  readonly structuredData?: StructuredData
}

// ---------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------

/**
 * Filter for {@link DiagnosticBus.on}.
 * - `"*"` — every event.
 * - {@link Severity} — exactly that severity.
 * - `(event) => boolean` — arbitrary predicate.
 */
export type DiagnosticFilter = Severity | "*" | ((event: LogEvent) => boolean)

export interface DiagnosticBus {
  /** Fan out the event to every matching subscriber, sync. */
  emit(event: LogEvent): void

  /**
   * Subscribe to events. Returns an idempotent dispose function.
   *
   * Handlers run in registration order on the same stack as the
   * producer's `emit()` call. Throws are caught and swallowed so a
   * misbehaving sink can't crash the producer.
   */
  on(filter: DiagnosticFilter, handler: (event: LogEvent) => void): () => void
}

interface Listener {
  readonly filter: DiagnosticFilter
  readonly handler: (event: LogEvent) => void
  disposed: boolean
}

class DiagnosticBusImpl implements DiagnosticBus {
  private listeners: Listener[] = []

  emit(event: LogEvent): void {
    // Snapshot the listener list to avoid invalidation if a handler
    // subscribes / unsubscribes during emission. Disposed listeners are
    // skipped via the `disposed` flag.
    const snapshot = this.listeners.slice()
    for (const l of snapshot) {
      if (l.disposed) continue
      if (!matches(l.filter, event)) continue
      try {
        l.handler(event)
      } catch {
        // Never propagate sink errors back to the producer.
      }
    }
  }

  on(filter: DiagnosticFilter, handler: (event: LogEvent) => void): () => void {
    const entry: Listener = { filter, handler, disposed: false }
    this.listeners.push(entry)
    return () => {
      if (entry.disposed) return
      entry.disposed = true
      const i = this.listeners.indexOf(entry)
      if (i >= 0) this.listeners.splice(i, 1)
    }
  }
}

function matches(filter: DiagnosticFilter, event: LogEvent): boolean {
  if (filter === "*") return true
  if (typeof filter === "function") {
    try {
      return filter(event)
    } catch {
      return false
    }
  }
  return event.severity === filter
}

// ---------------------------------------------------------------------------
// Singleton + test helpers
// ---------------------------------------------------------------------------

let _singleton: DiagnosticBus | null = null

/** Process-wide singleton. Lazy-constructed on first call. */
export function getDiagnosticBus(): DiagnosticBus {
  if (_singleton === null) _singleton = new DiagnosticBusImpl()
  return _singleton
}

/** Fresh isolated bus. Useful for tests; does not touch the singleton. */
export function createDiagnosticBus(): DiagnosticBus {
  return new DiagnosticBusImpl()
}

/**
 * Drop the singleton so the next `getDiagnosticBus()` returns a new
 * instance. Test-only — production code should never call this.
 */
export function resetDiagnosticBus(): void {
  _singleton = null
}

// ---------------------------------------------------------------------------
// Ergonomic producers
// ---------------------------------------------------------------------------

function emitToSingleton(
  severity: Severity,
  source: string,
  message: string,
  structuredData?: StructuredData,
): void {
  getDiagnosticBus().emit({
    ts: Date.now(),
    severity,
    facility: Facility.User,
    source,
    message,
    structuredData,
  })
}

/**
 * Convenience producers for the common case (singleton bus,
 * `Facility.User`, ts = now). The bus is created lazily on first call.
 *
 * Anywhere in the codebase:
 *
 *   import \{ diag \} from "../diagnostic-bus.ts"
 *   diag.warn("live-area.timeout", "invoke did not resolve in time", \{
 *     slot: "quota-status/quota",
 *     "timeout-ms": 8000,
 *   \})
 */
export const diag = {
  emergency(source: string, message: string, sd?: StructuredData): void {
    emitToSingleton(Severity.Emergency, source, message, sd)
  },
  alert(source: string, message: string, sd?: StructuredData): void {
    emitToSingleton(Severity.Alert, source, message, sd)
  },
  critical(source: string, message: string, sd?: StructuredData): void {
    emitToSingleton(Severity.Critical, source, message, sd)
  },
  error(source: string, message: string, sd?: StructuredData): void {
    emitToSingleton(Severity.Error, source, message, sd)
  },
  warn(source: string, message: string, sd?: StructuredData): void {
    emitToSingleton(Severity.Warning, source, message, sd)
  },
  notice(source: string, message: string, sd?: StructuredData): void {
    emitToSingleton(Severity.Notice, source, message, sd)
  },
  info(source: string, message: string, sd?: StructuredData): void {
    emitToSingleton(Severity.Info, source, message, sd)
  },
  debug(source: string, message: string, sd?: StructuredData): void {
    emitToSingleton(Severity.Debug, source, message, sd)
  },
}

// ---------------------------------------------------------------------------
// Plugin-scoped logger
// ---------------------------------------------------------------------------

/**
 * Logger interface plugins receive as `ctx.log`. Same shape as the
 * global {@link diag} helpers, but auto-prefixes the `source` field
 * with the plugin id so log events are identifiable in the file log
 * and TUI surface.
 *
 * Convention: pluginId is lowercase-kebab; the `source` argument is a
 * dotted-kebab sub-id (e.g. `ctx.log.warn("api-error", ...)`). The
 * emitted source is `<pluginId>.<source>`.
 */
export interface PluginLogger {
  emergency(source: string, message: string, sd?: StructuredData): void
  alert(source: string, message: string, sd?: StructuredData): void
  critical(source: string, message: string, sd?: StructuredData): void
  error(source: string, message: string, sd?: StructuredData): void
  warn(source: string, message: string, sd?: StructuredData): void
  notice(source: string, message: string, sd?: StructuredData): void
  info(source: string, message: string, sd?: StructuredData): void
  debug(source: string, message: string, sd?: StructuredData): void
}

/**
 * Construct a plugin-scoped logger. All emits go through {@link bus}
 * (default: the process-wide singleton) and carry a source field of
 * `${pluginId}.${source}`.
 *
 * For Plugins the loader constructs this once per handler context;
 * the same pluginId stamps every emit from that handler.
 */
export function createPluginLogger(pluginId: string, bus?: DiagnosticBus): PluginLogger {
  const targetBus = bus ?? getDiagnosticBus()
  const prefix = pluginId && pluginId.length > 0 ? pluginId + "." : ""
  function emit(severity: Severity): (s: string, m: string, sd?: StructuredData) => void {
    return (source, message, sd) => {
      try {
        targetBus.emit({
          ts: Date.now(),
          severity,
          facility: Facility.User,
          source: prefix + source,
          message,
          structuredData: sd,
        })
      } catch {
        // Plugin loggers must never throw into plugin code.
      }
    }
  }
  return {
    emergency: emit(Severity.Emergency),
    alert: emit(Severity.Alert),
    critical: emit(Severity.Critical),
    error: emit(Severity.Error),
    warn: emit(Severity.Warning),
    notice: emit(Severity.Notice),
    info: emit(Severity.Info),
    debug: emit(Severity.Debug),
  }
}

// ---------------------------------------------------------------------------
// Error-tagging helpers (rich-rendering coordination)
// ---------------------------------------------------------------------------

/**
 * Process-global symbol marking an Error whose *details have already been
 * rendered* via `diag.error(...)` (and therefore picked up by the
 * scrollback / TUI sinks). Consumers further up the stack that would
 * otherwise log a bare fallback line can skip rendering when this tag
 * is set, avoiding a noisy duplicate.
 *
 * `Symbol.for(...)` is intentional: it lives in the global registry so
 * tagging in `client.ts` and detection in `agent.ts` see the same
 * symbol identity even across module/test reloads.
 */
const DIAG_EMITTED_SYMBOL = Symbol.for("minimal-agent.diag.error-already-rendered")

/**
 * Mark `err` as already-rendered through the diagnostic bus. Returns the
 * same error so call sites can fluently `throw markErrorAsDiagEmitted(new Error(...))`.
 *
 * The mark is non-enumerable so it survives JSON.stringify boundaries
 * without leaking into serialized payloads, and is configurable so tests
 * can clean up between runs.
 */
export function markErrorAsDiagEmitted<E extends Error>(err: E): E {
  Object.defineProperty(err, DIAG_EMITTED_SYMBOL, {
    value: true,
    writable: false,
    enumerable: false,
    configurable: true,
  })
  return err
}

/**
 * True iff `err` has been tagged via {@link markErrorAsDiagEmitted}.
 * Safe to call with non-Error values (returns false).
 */
export function isErrorDiagEmitted(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false
  return (err as Record<symbol, unknown>)[DIAG_EMITTED_SYMBOL] === true
}
