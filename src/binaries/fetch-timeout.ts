/**
 * Deadline helpers for the binary store's network calls.
 *
 * - {@link withTimeout}: run an abortable operation under a deadline, combined
 *   with an optional caller signal (`AbortSignal.any`). The deadline is an
 *   `AbortSignal.timeout` DETACHED when the operation settles, so a phase deadline (e.g. the
 *   connect/headers phase of a download) never leaks into later phases.
 * - {@link fetchWithTimeout}: `fetch` with a deadline on the headers phase only.
 * - {@link readWithIdleTimeout}: one `reader.read()` under an idle (stall)
 *   deadline. The download loop calls it per chunk, so the timer resets on every
 *   received chunk: slow-but-progressing downloads succeed, stalled ones fail.
 *
 * Every timeout rejects with an `Error` whose `name` is `"TimeoutError"` and
 * whose `message` is the final user-facing text (callers must not re-prefix).
 *
 * @module binaries/fetch-timeout
 */

/** Build an `Error` named `"TimeoutError"` carrying a final, user-facing message. */
export function timeoutError(message: string): Error {
  return Object.assign(new Error(message), { name: "TimeoutError" })
}

/** True for any timeout error (ours, or a DOMException from `AbortSignal.timeout`). */
export function isTimeoutError(err: unknown): err is Error {
  return (
    typeof err === "object" && err !== null && (err as { name?: unknown }).name === "TimeoutError"
  )
}

/**
 * Final detail text for a timeout error. Our own timeouts already carry the
 * full message (it starts with `what`), so it is used as-is (no double
 * prefix). A foreign timeout (e.g. a platform DOMException "The operation
 * timed out.") is mapped to `"<what> timed out"`.
 */
export function timeoutDetail(err: Error, what: string): string {
  return err.message.startsWith(what) ? err.message : `${what} timed out`
}

/**
 * Run `run(signal)` under a `timeoutMs` deadline. The signal handed to `run` is
 * aborted on timeout (reason: a `TimeoutError` with `message`) or when `outer`
 * aborts. The call is also RACED against that signal, so an operation that
 * ignores its signal still rejects on time. The timer and listener are removed
 * when the operation settles.
 */
export async function withTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
  outer?: AbortSignal,
): Promise<T> {
  // The deadline is an `AbortSignal.timeout` (no raw timer: core's timer
  // ratchet). It cannot be cancelled, so it is NOT handed to `run`: it only
  // forwards into `ctrl` while the operation is pending, and that listener is
  // removed on settle, which makes the deadline effectively cleared.
  const ctrl = new AbortController()
  const deadline = AbortSignal.timeout(timeoutMs)
  const onDeadline = (): void => ctrl.abort(timeoutError(message))
  deadline.addEventListener("abort", onDeadline, { once: true })
  const signal = outer ? AbortSignal.any([outer, ctrl.signal]) : ctrl.signal
  let onAbort = (): void => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    if (signal.aborted) onAbort()
    else signal.addEventListener("abort", onAbort, { once: true })
  })
  try {
    return await Promise.race([run(signal), aborted])
  } finally {
    deadline.removeEventListener("abort", onDeadline)
    signal.removeEventListener("abort", onAbort)
  }
}

/**
 * `fetchFn` with a deadline on the connect/headers phase. Resolves with the
 * `Response` as soon as headers arrive and then clears the deadline, so the body
 * is NOT bounded by it (bound the body with {@link readWithIdleTimeout}). A
 * caller `init.signal` is combined, not overridden: aborting it still aborts the
 * request and its body stream after this returns. On timeout it rejects with a
 * `TimeoutError` whose message is `"<what> timed out after <ms> ms"`.
 */
export function fetchWithTimeout(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  what: string,
): Promise<Response> {
  return withTimeout(
    (signal) => fetchFn(url, { ...init, signal }),
    timeoutMs,
    `${what} timed out after ${timeoutMs} ms`,
    init.signal ?? undefined,
  )
}

/**
 * One `reader.read()` that rejects with a `TimeoutError` (`message`) when no
 * chunk arrives within `idleMs`, or with `signal.reason` when `signal` aborts.
 * On either failure the reader is cancelled so the underlying stream stops.
 */
export async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs: number,
  message: string,
  signal?: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  try {
    return await withTimeout(() => reader.read(), idleMs, message, signal)
  } catch (err) {
    await reader.cancel(err).catch(() => {})
    throw err
  }
}
