/**
 * Async retry helper with capped exponential backoff + full jitter, AbortSignal
 * support, and Retry-After honoring.
 *
 * Style mirrors `src/lockfile.ts`: injectable `sleep`/`now`/`random` for
 * fake-clock tests, deadline-based total timeout, no external dependencies.
 *
 * This is NOT a circuit breaker. If you find yourself wanting "stop hitting
 * provider X entirely after N consecutive failures", reach for
 * [`cockatiel`](https://github.com/connor4312/cockatiel) instead — composing
 * circuit-breaker + retry policies is exactly what it's for. For single
 * call sites with transient-failure semantics, this module is sufficient.
 *
 * ## Algorithm
 *
 * Per AWS's [Exponential Backoff and Jitter][1] post, this uses "full
 * jitter" — the simplest decorrelated strategy. For attempt N (1-indexed,
 * with attempt 1 being the first retry after the initial call):
 *
 *     ideal_delay = min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
 *     jittered    = random() * ideal_delay                  // [0, ideal_delay)
 *     delay       = min(max(jittered, retryAfterMs ?? 0), remaining, maxDelayMs)
 *
 * The `retryAfterMs` (typically from the `Retry-After` HTTP header) acts as
 * a floor — when the server tells us how long to wait, we never wait less
 * than that. Both the per-attempt delay and the running deadline cap the
 * actual sleep, so a server returning `Retry-After: 600` won't block the
 * caller for ten minutes.
 *
 * Decorrelated jitter (the AWS/Polly default) would offer slightly smoother
 * distribution across many concurrent clients, but for the typical
 * single-process use here, full jitter is cheaper to reason about and the
 * difference is negligible.
 *
 * [1]: https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 *
 * ## Cancellation
 *
 * The `signal` option interrupts both the wrapped function (via
 * `throwIfAborted()` before each attempt) AND any pending backoff sleep.
 * If the signal aborts mid-sleep, the helper rejects with the abort
 * reason — it never silently "finishes" a wait.
 *
 * @module retry
 */

/** Decision returned by {@link RetryOptions.shouldRetry}. */
export interface RetryDecision {
  /** Whether to retry on this error. `false` re-throws immediately. */
  retry: boolean
  /**
   * Optional server-mandated delay floor, in ms. Typically derived from
   * an HTTP `Retry-After` header. When set, the actual sleep will be at
   * least this long (still capped by `maxDelayMs` and the remaining
   * deadline).
   */
  retryAfterMs?: number
}

/** Tunables for {@link retry}. */
export interface RetryOptions {
  /**
   * Max total attempts including the first call. Default `3`.
   *
   * `maxAttempts: 1` disables retry entirely (fn runs once; throws bubble
   * straight through).
   */
  maxAttempts?: number
  /**
   * First retry delay base in ms (before jitter). Default `200`.
   *
   * Successive attempts use `baseDelayMs * 2^(attempt-1)` as the
   * pre-jitter ceiling: 200, 400, 800, ...
   */
  baseDelayMs?: number
  /**
   * Cap on any single backoff sleep, in ms. Default `10_000`.
   *
   * Also applied as a hard ceiling on `Retry-After` floors — a server
   * asking for 10 minutes won't actually pause the caller that long.
   */
  maxDelayMs?: number
  /**
   * Cap on total wall-clock spent across all attempts (including their
   * waits), in ms. Default `30_000`.
   *
   * Measured from the first call to {@link retry}. When the remaining
   * budget hits zero, the last error is re-thrown immediately rather
   * than waiting out the next backoff.
   */
  maxTotalMs?: number
  /**
   * Classify whether a given thrown error is retryable. Default: retry
   * everything.
   *
   * Return `{retry: false}` for permanent errors (401, 404, validation
   * mistakes) to fail fast. Return `{retry: true, retryAfterMs: N}` to
   * pin the next sleep to at least N ms (e.g. honor a `Retry-After`
   * header).
   */
  shouldRetry?: (err: unknown, attempt: number) => RetryDecision
  /**
   * Abort signal. Aborts both the in-flight `fn` (via `throwIfAborted()`
   * checks) and any pending backoff sleep. If aborted, {@link retry}
   * rejects with the signal's `reason`.
   */
  signal?: AbortSignal
  /**
   * Notification fired *before* each backoff sleep. Useful for logging
   * or telemetry. Not called before the first attempt (no backoff
   * precedes it) or after the final failure (no further sleep occurs).
   */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void
}

/** Dependency injection points (test-only). */
export interface RetryDeps {
  /**
   * Sleep function. Receives the duration in ms and an optional abort
   * signal. Tests can supply a fake-clock implementation.
   */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** RNG for jitter. Defaults to `Math.random`. */
  random?: () => number
  /** Monotonic-ish clock. Defaults to `Date.now`. */
  now?: () => number
}

/**
 * Default {@link RetryDeps.sleep} implementation: a `setTimeout` that
 * honors `AbortSignal` mid-wait.
 *
 * Exported so callers needing a one-off abortable sleep don't have to
 * roll their own.
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"))
      return
    }
    const onAbort = (): void => {
      clearTimeout(handle)
      reject(signal?.reason ?? new DOMException("aborted", "AbortError"))
    }
    const handle = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/**
 * Run `fn` with retry on failure, using capped exponential backoff with
 * full jitter. See the module docstring for the algorithm.
 *
 * The function receives the 1-indexed attempt number, which can be useful
 * for telemetry inside the wrapped operation itself.
 *
 * @param fn - The operation to attempt. Called with the attempt number
 *             (`1` for first call, `2` for first retry, ...).
 * @param opts - Tunables — see {@link RetryOptions}.
 * @param deps - Test-only injection of `sleep`/`random`/`now`.
 * @returns    The resolved value of `fn` on the first successful attempt,
 *             or rejects with the last error after exhausting retries
 *             (or with the abort reason if `opts.signal` aborts).
 *
 * @example
 * ```ts
 * const resp = await retry(
 *   () => fetch(url),
 *   {
 *     maxAttempts: 3,
 *     baseDelayMs: 500,
 *     shouldRetry: (err) => {
 *       const r = (err as { response?: Response }).response
 *       if (!r) return { retry: true }                  // network error
 *       if (r.status === 429 || r.status >= 500) {
 *         const ra = r.headers.get("retry-after")
 *         const retryAfterMs =
 *           ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : undefined
 *         return { retry: true, retryAfterMs }
 *       }
 *       return { retry: false }                          // 4xx other than 429
 *     },
 *   },
 * )
 * ```
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions = {},
  deps: RetryDeps = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 200
  const maxDelayMs = opts.maxDelayMs ?? 10_000
  const maxTotalMs = opts.maxTotalMs ?? 30_000
  const sleep = deps.sleep ?? abortableSleep
  const random = deps.random ?? Math.random
  const now = deps.now ?? Date.now

  if (maxAttempts < 1) {
    throw new RangeError(`retry: maxAttempts must be >= 1, got ${maxAttempts}`)
  }

  const deadline = now() + maxTotalMs
  let lastError: unknown

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    opts.signal?.throwIfAborted()
    try {
      return await fn(attempt)
    } catch (err) {
      lastError = err
      // Last attempt — no retry, surface the error.
      if (attempt === maxAttempts) throw err

      const decision = opts.shouldRetry?.(err, attempt) ?? { retry: true }
      if (!decision.retry) throw err

      // Full jitter: random in [0, min(cap, base * 2^(attempt-1))).
      const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1))
      const jittered = Math.floor(random() * exp)
      // Retry-After acts as a floor; never wait less than the server
      // told us.
      const floored = Math.max(decision.retryAfterMs ?? 0, jittered)
      // Cap to the per-attempt max and the remaining deadline.
      const remaining = deadline - now()
      if (remaining <= 0) throw err
      const delayMs = Math.min(floored, remaining, maxDelayMs)

      opts.onRetry?.({ attempt, delayMs, error: err })
      await sleep(delayMs, opts.signal)
    }
  }

  // Unreachable — the loop either returns on success or throws on the
  // final attempt — but TS can't see the throw above as exhaustive
  // because of the `attempt === maxAttempts` branch's reachability.
  throw lastError
}
