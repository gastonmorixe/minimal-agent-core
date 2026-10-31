/**
 * Listener isolation for event fan-out (S22).
 *
 * A consumer that throws (a broken `--json` writer, a closed SSE stream, a
 * buggy UI callback) must never stop the run or starve the other consumers.
 * It must not fail silently either. A {@link SinkGuard} wraps every call into
 * one listener:
 *   - A throw is caught. The producer and the other listeners never see it.
 *   - The first throw calls `onFirstFailure` once. The owner turns that into
 *     one `events.sink-error` diagnostic.
 *   - Later throws are only counted ({@link SinkGuard.failures}).
 *
 * One guard per listener. `AgentCore` guards its event sink with one, and the
 * session event log (`src/session/event-log.ts`) guards each subscriber.
 *
 * @module sdk/sink-guard
 */

import { type DiagnosticEmitter, Facility, Severity } from "../bus/diagnostic-bus.ts"

/** Diagnostic code for the first failure of one listener. */
export const SINK_ERROR_CODE = "events.sink-error"

/** What a guard passes to `onFirstFailure`. */
export interface SinkFailure {
  /** The thrown value, unchanged. */
  readonly error: unknown
  /** One-line text of the thrown value. */
  readonly message: string
}

/** Isolates the calls into one listener. Build it with {@link createSinkGuard}. */
export interface SinkGuard {
  /**
   * Call `fn`. A throw is caught and counted, and the first one is reported.
   * Never throws.
   *
   * @returns `true` when `fn` returned, `false` when it threw.
   */
  call(fn: () => void): boolean
  /** Number of throws caught so far, the first one included. */
  readonly failures: number
}

/** One-line text of a thrown value, for diagnostics. */
export function sinkErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/[\r\n]+/g, " ")
}

/**
 * Create a guard for one listener. `onFirstFailure` runs once, on the first
 * throw. A throw from `onFirstFailure` itself is swallowed too.
 */
export function createSinkGuard(onFirstFailure: (failure: SinkFailure) => void): SinkGuard {
  let failures = 0
  return {
    call(fn: () => void): boolean {
      try {
        fn()
        return true
      } catch (error) {
        failures++
        if (failures === 1) {
          try {
            onFirstFailure({ error, message: sinkErrorMessage(error) })
          } catch {
            // The reporter must not break the producer either.
          }
        }
        return false
      }
    },
    get failures(): number {
      return failures
    },
  }
}

/**
 * Report the first failure of `listener` as one `events.sink-error`
 * diagnostic. `diagnostics` is the owner's injected handle (S20), so a
 * session's sink failure carries that session's id.
 */
export function reportSinkError(
  listener: string,
  failure: SinkFailure,
  diagnostics: DiagnosticEmitter,
): void {
  diagnostics.emit({
    ts: Date.now(),
    severity: Severity.Error,
    facility: Facility.User,
    source: SINK_ERROR_CODE,
    message: `${listener} threw; later failures are counted, not reported: ${failure.message}`,
    structuredData: { listener, error: failure.message },
  })
}
