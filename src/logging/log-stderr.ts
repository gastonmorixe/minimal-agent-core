/**
 * Opt-in stderr mirror for the diagnostic bus.
 *
 * Used by developers (`MINIMAL_AGENT_LOG_STDERR=1`) who want to see
 * diagnostics in real time without tailing the file log. NOT for end
 * users.
 *
 * # Routing
 *
 * Production code MUST inject a write fn that bypasses the
 * `StdioInterceptor` — `interceptor.rawStderrWrite(...)` — so the
 * mirror doesn't land in the compositor's scrollback (which is
 * exactly the bug this whole subsystem exists to fix). Tests inject
 * a capture array.
 *
 * # Format
 *
 *   `[LEVEL] source: message k="v" k2="v2"\n`
 *
 * Compact and grep-able. We don't bother with RFC 5424 here — the
 * file sink covers structured parsing.
 *
 * @module log-stderr
 */

import { type DiagnosticBus, type LogEvent, Severity } from "../bus/diagnostic-bus.ts"

export interface StderrMirrorSinkOptions {
  /**
   * Raw stderr write function. Defaults to `process.stderr.write(s)`.
   * Production wiring MUST inject `interceptor.rawStderrWrite` so the
   * mirror bypasses the compositor.
   */
  write?: (chunk: string) => void
  /** Minimum severity (highest severity number still logged). Default Debug. */
  level?: Severity
}

/**
 * Diagnostic-bus sink that mirrors events to stderr as plain one-line
 * messages, for headless/piped runs where no TUI surface exists. Must be
 * wired with the interceptor's raw write in production so mirrored lines
 * bypass the compositor instead of corrupting the live area.
 */
export class StderrMirrorSink {
  private readonly write: (s: string) => void
  private readonly level: Severity
  private disposeFn: (() => void) | null = null

  constructor(opts: StderrMirrorSinkOptions = {}) {
    this.write =
      opts.write ??
      ((s: string) => {
        try {
          process.stderr.write(s)
        } catch {
          // Best-effort.
        }
      })
    this.level = opts.level ?? Severity.Debug
  }

  attach(bus: DiagnosticBus): void {
    if (this.disposeFn) return
    this.disposeFn = bus.on("*", (e) => this.onEvent(e))
  }

  detach(): void {
    this.disposeFn?.()
    this.disposeFn = null
  }

  private onEvent(e: LogEvent): void {
    if (e.severity > this.level) return
    try {
      this.write(formatLine(e))
    } catch {
      // Never throw into the producer's emit().
    }
  }
}

function formatLine(e: LogEvent): string {
  const tag = severityTag(e.severity)
  const sd = e.structuredData ? formatStructuredData(e.structuredData) : ""
  return `[${tag}] ${e.source}: ${e.message}${sd}\n`
}

function severityTag(s: Severity): string {
  switch (s) {
    case Severity.Emergency:
      return "EMERG"
    case Severity.Alert:
      return "ALERT"
    case Severity.Critical:
      return "CRIT"
    case Severity.Error:
      return "ERROR"
    case Severity.Warning:
      return "WARN"
    case Severity.Notice:
      return "NOTICE"
    case Severity.Info:
      return "INFO"
    case Severity.Debug:
      return "DEBUG"
    default:
      // `Severity` is a const enum with a fixed set of numeric members;
      // exhaustiveness is enforced at compile time, but a default arm
      // here satisfies `consistent-return` and gives us a safe fallback
      // if a producer ever emits a hand-rolled numeric severity.
      return "INFO"
  }
}

function formatStructuredData(sd: Record<string, string | number | boolean>): string {
  const keys = Object.keys(sd)
  if (keys.length === 0) return ""
  let out = ""
  for (const k of keys) {
    out += ` ${k}=${JSON.stringify(String(sd[k]))}`
  }
  return out
}
