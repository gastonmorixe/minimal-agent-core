/**
 * The plugin loader's diagnostics target (S20).
 *
 * The loader starts before any session exists, so it reports to a
 * runtime-level {@link Diagnostics} handle (the host passes one, else the
 * process handle). When a session opens, the host attaches the session
 * scope. From then on loader diagnostics (event bus, hooks, slash
 * commands, plugin `ctx.log`) carry a session id and reach that session's
 * event log as `ch: "diag"` entries.
 *
 * Many sessions can attach to one loader (web does this). The relay picks
 * the target for each diagnostic:
 *
 *   1. Inside a run: the scope of that run (`diagnostics/run-scope.ts`).
 *   2. Outside a run, with exactly one session attached: that session.
 *   3. Else: the runtime-level handle. With two or more sessions attached,
 *      no session is the right one.
 *
 * The relay is a {@link Diagnostics} handle itself, so code that takes a
 * handle (or a `DiagnosticEmitter`) can take the relay.
 *
 * @module plugins/loader/diagnostics-relay
 */

import type { LogEvent } from "../../bus/diagnostic-bus.ts"
import { createDiagnostics, type Diagnostics } from "../../diagnostics/hub.ts"
import { currentDiagnosticsScope } from "../../diagnostics/run-scope.ts"

/** A {@link Diagnostics} handle whose target can change. */
export interface DiagnosticsRelay extends Diagnostics {
  /**
   * Add `target` (a session scope). Returns an idempotent function that
   * removes it again. See the module doc for the target of each diagnostic.
   */
  attach(target: Diagnostics): () => void
}

/** Build a relay that sends to `base` until a target is attached. */
export function createDiagnosticsRelay(base: Diagnostics): DiagnosticsRelay {
  const attached: Diagnostics[] = []
  const current = (): Diagnostics =>
    currentDiagnosticsScope() ?? (attached.length === 1 ? attached[0] : undefined) ?? base
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
