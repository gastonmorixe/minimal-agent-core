/**
 * The diagnostics scope of the current run (S20).
 *
 * One component (the plugin loader) can serve many sessions at once. Web
 * does this. `Session.run` sets the session scope for the whole run, with
 * every model request and tool call in it. Code that has no session of its
 * own reads the scope here and reports to the session of the run that
 * called it.
 *
 * @module diagnostics/run-scope
 */

import { AsyncLocalStorage } from "node:async_hooks"

import type { Diagnostics } from "./hub.ts"

const store = new AsyncLocalStorage<Diagnostics>()

/** Run `fn` with `scope` as the run scope. Async work that `fn` starts keeps it. */
export function runInDiagnosticsScope<T>(scope: Diagnostics, fn: () => T): T {
  return store.run(scope, fn)
}

/** The scope of the run that called this code, or undefined outside a run. */
export function currentDiagnosticsScope(): Diagnostics | undefined {
  return store.getStore()
}
