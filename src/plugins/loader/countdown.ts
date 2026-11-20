/**
 * The default host countdown of a hook handler context (`ctx.countdown`).
 *
 * A host with a countdown UI (the terminal host) gives the loader its own
 * {@link CountdownFn} (`PluginLoaderOptions.countdown`). Every other host
 * gets this one: a plain wait that obeys the request signal. It has no UI,
 * so it never resolves `"skipped"`. A plain wait (not a no-op) keeps the
 * meaning of the request the same in each host: a plugin that asks for a
 * pause gets the pause, also headless, and a run abort still ends it at
 * once. The wait uses `AbortSignal.timeout`, so it adds no timer call to
 * the core timer inventory.
 *
 * @module plugins/loader/countdown
 */

import type { CountdownFn, CountdownRequest, CountdownResult } from "../types.ts"

/** Wait `request.ms`, or less when `request.signal` aborts. Never rejects. */
export const plainCountdown: CountdownFn = (request: CountdownRequest) => {
  const { ms, signal } = request
  if (signal?.aborted) return Promise.resolve<CountdownResult>("aborted")
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve<CountdownResult>("elapsed")
  return new Promise<CountdownResult>((resolve) => {
    const timeout = AbortSignal.timeout(ms)
    const settle = (result: CountdownResult): void => {
      timeout.removeEventListener("abort", onElapsed)
      signal?.removeEventListener("abort", onAbort)
      resolve(result)
    }
    const onElapsed = (): void => settle("elapsed")
    const onAbort = (): void => settle("aborted")
    timeout.addEventListener("abort", onElapsed, { once: true })
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}
