/**
 * The plugin loader's diagnostics target (S20).
 *
 * The loader starts before any session exists, so it reports to a
 * runtime-level {@link Diagnostics} handle (the host passes one, else the
 * process handle). When a session opens, the host attaches the session
 * scope. From then on every loader diagnostic (event bus, hooks, slash
 * commands, plugin `ctx.log`) carries that session id and reaches the
 * session event log as a `ch: "diag"` entry. Detach returns to the
 * previous target.
 *
 * The relay is a {@link Diagnostics} handle itself, so code that takes a
 * handle (or a `DiagnosticEmitter`) can take the relay.
 *
 * @module plugins/loader/diagnostics-relay
 */

import type { LogEvent } from "../../bus/diagnostic-bus.ts"
import { createDiagnostics, type Diagnostics } from "../../diagnostics/hub.ts"

/** A {@link Diagnostics} handle whose target can change. */
export interface DiagnosticsRelay extends Diagnostics {
  /**
   * Send diagnostics to `target` from now on. Returns an idempotent
   * function that removes `target` again. The last attached target that is
   * still attached wins.
   */
  attach(target: Diagnostics): () => void
}

/** Build a relay that sends to `base` until a target is attached. */
export function createDiagnosticsRelay(base: Diagnostics): DiagnosticsRelay {
  const attached: Diagnostics[] = []
  const current = (): Diagnostics => attached[attached.length - 1] ?? base
  const handle = createDiagnostics({ emit: (event: LogEvent) => current().emit(event) })
  return {
    ...handle,
    get sessionId(): string | undefined {
      return current().sessionId
    },
    attach(target: Diagnostics): () => void {
      attached.push(target)
      let done = false
      return () => {
        if (done) return
        done = true
        const index = attached.lastIndexOf(target)
        if (index >= 0) attached.splice(index, 1)
      }
    },
  }
}
