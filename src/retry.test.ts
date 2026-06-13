/**
 * Tests for `./retry.ts`.
 *
 * The retry module's contract has four pieces, each of which has its own
 * describe block:
 *
 *   1. Success/failure plumbing — first-try success, eventual success,
 *      exhaustion, non-retryable classification, attempt-counting.
 *   2. Backoff math — exponential progression, full jitter bounds,
 *      Retry-After as a floor, maxDelayMs as a ceiling.
 *   3. Deadline — maxTotalMs caps total wall-clock and pre-empts the
 *      next backoff when budget is exhausted.
 *   4. Cancellation — AbortSignal aborts pre-call, mid-sleep, and
 *      between attempts.
 *
 * All tests use a fake clock + deterministic RNG via the `deps` injection
 * point. The real `setTimeout`-based `abortableSleep` has its own focused
 * block at the bottom (it's exported for callers needing a one-off
 * abortable sleep and so deserves direct coverage).
 */

import { describe, expect, test } from "bun:test"

import { abortableSleep, type RetryDeps, type RetryOptions, retry } from "./retry.ts"

// --- fake clock / RNG harness --------------------------------------------

/**
 * Build a deps bundle whose `sleep` resolves synchronously (queued onto
 * microtask) and records every requested delay, whose `now` advances by
 * exactly the slept amount, and whose `random` cycles through a fixed
 * sequence (default: always 0.5 — middle of the jitter range).
 */
function makeFakeDeps(
  opts: { randoms?: number[]; startNow?: number } = {},
): RetryDeps & { sleeps: number[]; clock: { value: number } } {
  const clock = { value: opts.startNow ?? 1_000_000 }
  const sleeps: number[] = []
  const randoms = opts.randoms ?? [0.5]
  let i = 0
  return {
    sleeps,
    clock,
    sleep: async (ms: number, signal?: AbortSignal): Promise<void> => {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted")
      sleeps.push(ms)
      clock.value += ms
      // Yield to microtasks so abort listeners (if any) fire in tests
      // that intersperse other ticks.
      await Promise.resolve()
    },
    random: (): number => {
      const v = randoms[i % randoms.length]
      i++
      return v
    },
    now: (): number => clock.value,
  }
}

// --- describe block 1: success/failure plumbing --------------------------

describe("retry — success/failure plumbing", () => {
  test("returns on first-try success with no sleeps", async () => {
    const deps = makeFakeDeps()
    const result = await retry(async () => "ok", {}, deps)
    expect(result).toBe("ok")
    expect(deps.sleeps).toEqual([])
  })

  test("passes 1-indexed attempt number to fn", async () => {
    const deps = makeFakeDeps()
    const attempts: number[] = []
    await retry(
      async (n) => {
        attempts.push(n)
        if (n < 3) throw new Error("transient")
        return "done"
      },
      { maxAttempts: 5, baseDelayMs: 1, maxDelayMs: 1 },
      deps,
    )
    expect(attempts).toEqual([1, 2, 3])
  })

  test("eventually succeeds after transient failures", async () => {
    const deps = makeFakeDeps()
    let calls = 0
    const result = await retry(
      async () => {
        calls++
        if (calls < 3) throw new Error("flaky")
        return calls
      },
      { maxAttempts: 5, baseDelayMs: 100 },
      deps,
    )
    expect(result).toBe(3)
    expect(deps.sleeps).toHaveLength(2) // two backoffs preceded the third call
  })

  test("exhausts maxAttempts and re-throws the last error", async () => {
    const deps = makeFakeDeps()
    let calls = 0
    await expect(
      retry(
        async () => {
          calls++
          throw new Error(`fail-${calls}`)
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
        deps,
      ),
    ).rejects.toThrow("fail-3")
    expect(calls).toBe(3)
    // 2 backoffs (between attempts 1→2 and 2→3), no backoff after the
    // last failure.
    expect(deps.sleeps).toHaveLength(2)
  })

  test("shouldRetry returning {retry:false} aborts immediately", async () => {
    const deps = makeFakeDeps()
    let calls = 0
    await expect(
      retry(
        async () => {
          calls++
          throw new Error("permanent")
        },
        { maxAttempts: 5, baseDelayMs: 1, shouldRetry: () => ({ retry: false }) },
        deps,
      ),
    ).rejects.toThrow("permanent")
    expect(calls).toBe(1)
    expect(deps.sleeps).toEqual([])
  })

  test("shouldRetry receives the error and 1-indexed attempt", async () => {
    const deps = makeFakeDeps()
    const seen: Array<{ msg: string; n: number }> = []
    await expect(
      retry(
        async (n) => {
          throw new Error(`e${n}`)
        },
        {
          maxAttempts: 3,
          baseDelayMs: 1,
          maxDelayMs: 1,
          shouldRetry: (err, attempt) => {
            seen.push({ msg: (err as Error).message, n: attempt })
            return { retry: true }
          },
        },
        deps,
      ),
    ).rejects.toThrow()
    // shouldRetry is consulted after attempts 1 and 2 (not the final
    // attempt 3, since exhaustion short-circuits).
    expect(seen).toEqual([
      { msg: "e1", n: 1 },
      { msg: "e2", n: 2 },
    ])
  })

  test("default shouldRetry retries every error", async () => {
    const deps = makeFakeDeps()
    let calls = 0
    await expect(
      retry(
        async () => {
          calls++
          throw new Error("any")
        },
        { maxAttempts: 4, baseDelayMs: 1, maxDelayMs: 1 },
        deps,
      ),
    ).rejects.toThrow()
    expect(calls).toBe(4)
  })

  test("maxAttempts:1 means no retry (fn runs once)", async () => {
    const deps = makeFakeDeps()
    let calls = 0
    await expect(
      retry(
        async () => {
          calls++
          throw new Error("nope")
        },
        { maxAttempts: 1 },
        deps,
      ),
    ).rejects.toThrow("nope")
    expect(calls).toBe(1)
    expect(deps.sleeps).toEqual([])
  })

  test("maxAttempts < 1 throws RangeError", async () => {
    await expect(retry(async () => "x", { maxAttempts: 0 })).rejects.toThrow(RangeError)
    await expect(retry(async () => "x", { maxAttempts: -3 })).rejects.toThrow(RangeError)
  })

  test("onRetry fires before each backoff with attempt + delay + error", async () => {
    const deps = makeFakeDeps({ randoms: [0.5] })
    const calls: Array<{ attempt: number; delayMs: number; error: string }> = []
    await expect(
      retry(
        async () => {
          throw new Error("boom")
        },
        {
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 10_000,
          onRetry: (info) =>
            calls.push({
              attempt: info.attempt,
              delayMs: info.delayMs,
              error: (info.error as Error).message,
            }),
        },
        deps,
      ),
    ).rejects.toThrow()
    // Two retries → two onRetry fires (before sleep 1 and sleep 2).
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ attempt: 1, delayMs: 50, error: "boom" }) // 0.5 * 100
    expect(calls[1]).toEqual({ attempt: 2, delayMs: 100, error: "boom" }) // 0.5 * 200
  })

  test("onRetry does NOT fire after the final failure", async () => {
    const deps = makeFakeDeps()
    let fires = 0
    await expect(
      retry(
        async () => {
          throw new Error("end")
        },
        { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1, onRetry: () => fires++ },
        deps,
      ),
    ).rejects.toThrow()
    expect(fires).toBe(1) // before the one backoff between attempts 1 and 2
  })
})

// --- describe block 2: backoff math --------------------------------------

describe("retry — backoff math (full jitter)", () => {
  test("exponential progression with random=1 yields base * 2^(n-1)", async () => {
    // random=1 makes Math.floor(random * exp) === exp - 1 ≈ exp, so we
    // see almost the full theoretical delay. We choose base=100 to make
    // arithmetic obvious. Use 0.99 to keep floor() exact: floor(99) = 99.
    const deps = makeFakeDeps({ randoms: [0.99, 0.99, 0.99, 0.99] })
    await expect(
      retry(
        async () => {
          throw new Error("fail")
        },
        { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 100_000 },
        deps,
      ),
    ).rejects.toThrow()
    // 4 backoffs: 100*0.99=99, 200*0.99=198, 400*0.99=396, 800*0.99=792
    expect(deps.sleeps).toEqual([99, 198, 396, 792])
  })

  test("random=0 yields 0 sleep but still triggers a retry", async () => {
    const deps = makeFakeDeps({ randoms: [0] })
    let calls = 0
    await expect(
      retry(
        async () => {
          calls++
          throw new Error("e")
        },
        { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 10_000 },
        deps,
      ),
    ).rejects.toThrow()
    expect(calls).toBe(3)
    expect(deps.sleeps).toEqual([0, 0])
  })

  test("maxDelayMs caps individual backoffs", async () => {
    // Without a cap, attempt 4 would want ~800ms. We cap at 250.
    const deps = makeFakeDeps({ randoms: [0.99, 0.99, 0.99] })
    await expect(
      retry(
        async () => {
          throw new Error("fail")
        },
        { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 250 },
        deps,
      ),
    ).rejects.toThrow()
    // 100*0.99=99, 200*0.99=198, but third attempt's exp = min(250, 400) = 250, so 250*0.99=247
    expect(deps.sleeps).toEqual([99, 198, 247])
  })

  test("Retry-After acts as a FLOOR over jitter", async () => {
    // Tiny jitter (random=0.01, base=100 → 1ms), server says 500ms.
    const deps = makeFakeDeps({ randoms: [0.01, 0.01] })
    await expect(
      retry(
        async () => {
          throw new Error("429")
        },
        {
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 10_000,
          shouldRetry: () => ({ retry: true, retryAfterMs: 500 }),
        },
        deps,
      ),
    ).rejects.toThrow()
    expect(deps.sleeps).toEqual([500, 500]) // floor wins over the tiny jitter both times
  })

  test("Retry-After respects maxDelayMs ceiling (server can't pin us forever)", async () => {
    // Server demands 60 seconds; we cap at 2 seconds.
    const deps = makeFakeDeps({ randoms: [0.5] })
    await expect(
      retry(
        async () => {
          throw new Error("429")
        },
        {
          maxAttempts: 2,
          baseDelayMs: 100,
          maxDelayMs: 2000,
          maxTotalMs: 60_000,
          shouldRetry: () => ({ retry: true, retryAfterMs: 60_000 }),
        },
        deps,
      ),
    ).rejects.toThrow()
    expect(deps.sleeps).toEqual([2000]) // capped to maxDelayMs
  })

  test("jitter uses random in [0, 1) — bounds sanity check", async () => {
    // With random=0, sleep=0. With random→1, sleep→exp (exclusive).
    const deps = makeFakeDeps({ randoms: [0, 0.5, 0.9999] })
    await expect(
      retry(
        async () => {
          throw new Error("fail")
        },
        { maxAttempts: 4, baseDelayMs: 1000, maxDelayMs: 100_000 },
        deps,
      ),
    ).rejects.toThrow()
    // exp values: 1000, 2000, 4000
    expect(deps.sleeps[0]).toBe(0) // 0 * 1000
    expect(deps.sleeps[1]).toBe(1000) // 0.5 * 2000
    expect(deps.sleeps[2]).toBe(3999) // floor(0.9999 * 4000)
  })
})

// --- describe block 3: deadline ------------------------------------------

describe("retry — deadline (maxTotalMs)", () => {
  test("deadline cuts off pending backoff when remaining budget is exhausted", async () => {
    // Budget 250ms; first failure consumes 0 (fake clock starts there).
    // Backoff would be 1000ms but remaining is 250, so we sleep 250.
    // Then second attempt fails again; remaining is now 0, so we throw
    // without sleeping.
    const deps = makeFakeDeps({ randoms: [0.99] })
    let calls = 0
    await expect(
      retry(
        async () => {
          calls++
          throw new Error("slow-fail")
        },
        {
          maxAttempts: 5,
          baseDelayMs: 1000,
          maxDelayMs: 10_000,
          maxTotalMs: 250,
        },
        deps,
      ),
    ).rejects.toThrow("slow-fail")
    expect(deps.sleeps).toEqual([250])
    expect(calls).toBe(2) // first call + retry-after-clamped-sleep + second call
  })

  test("when remaining hits 0 mid-loop, last error re-throws without further sleeps", async () => {
    // Custom deps that advance clock 100ms per call to simulate
    // execution time, regardless of sleep.
    const clock = { value: 0 }
    const sleeps: number[] = []
    const deps: RetryDeps = {
      sleep: async (ms) => {
        sleeps.push(ms)
        clock.value += ms
      },
      now: () => clock.value,
      random: () => 0.5,
    }
    let calls = 0
    await expect(
      retry(
        async () => {
          calls++
          clock.value += 50 // each call "takes" 50ms
          throw new Error("slow")
        },
        { maxAttempts: 10, baseDelayMs: 200, maxDelayMs: 1000, maxTotalMs: 100 },
        deps,
      ),
    ).rejects.toThrow("slow")
    // After call 1: clock=50. remaining=50. delay = min(100, 50, 1000) = 50.
    // After sleep: clock=100. call 2: clock=150. remaining=-50 → throw without further sleep.
    expect(sleeps).toEqual([50])
    expect(calls).toBe(2)
  })

  test("maxTotalMs defaults to 30s and is not exceeded under normal exhaustion", async () => {
    const deps = makeFakeDeps({ randoms: [0.99, 0.99] })
    const t0 = deps.now!()
    await expect(
      retry(
        async () => {
          throw new Error("e")
        },
        { maxAttempts: 3, baseDelayMs: 100 }, // defaults: maxDelayMs=10k, maxTotalMs=30k
        deps,
      ),
    ).rejects.toThrow()
    const elapsed = deps.now!() - t0
    expect(elapsed).toBeLessThan(30_000)
  })
})

// --- describe block 4: cancellation --------------------------------------

describe("retry — cancellation (AbortSignal)", () => {
  test("pre-aborted signal throws before first call", async () => {
    const deps = makeFakeDeps()
    const ac = new AbortController()
    ac.abort(new Error("user-cancel"))
    let calls = 0
    await expect(
      retry(
        async () => {
          calls++
          return "x"
        },
        { signal: ac.signal },
        deps,
      ),
    ).rejects.toThrow("user-cancel")
    expect(calls).toBe(0)
  })

  test("abort mid-sleep rejects retry with abort reason", async () => {
    const ac = new AbortController()
    // Custom sleep that's awaitable and respects abort.
    const sleeps: number[] = []
    const deps: RetryDeps = {
      sleep: (ms, signal) =>
        new Promise<void>((resolve, reject) => {
          sleeps.push(ms)
          const t = setTimeout(resolve, 0) // microtask, not real ms
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(t)
              reject(signal.reason ?? new Error("aborted"))
            },
            { once: true },
          )
        }),
      now: () => 0,
      random: () => 0.5,
    }
    // Abort after the first failure but before sleep resolves.
    setTimeout(() => ac.abort(new Error("mid-sleep")), 0)
    await expect(
      retry(
        async () => {
          throw new Error("transient")
        },
        { maxAttempts: 5, baseDelayMs: 1000, signal: ac.signal },
        deps,
      ),
    ).rejects.toThrow("mid-sleep")
    expect(sleeps).toHaveLength(1)
  })

  test("abort between attempts (after sleep, before next fn call) is honored", async () => {
    const ac = new AbortController()
    let calls = 0
    const deps: RetryDeps = {
      sleep: async () => {
        // Abort right as sleep "completes" — next loop iteration's
        // throwIfAborted() must catch it.
        ac.abort(new Error("between"))
      },
      now: () => 0,
      random: () => 0.5,
    }
    await expect(
      retry(
        async () => {
          calls++
          throw new Error("e")
        },
        { maxAttempts: 5, baseDelayMs: 1, signal: ac.signal },
        deps,
      ),
    ).rejects.toThrow("between")
    expect(calls).toBe(1)
  })
})

// --- describe block 5: abortableSleep ------------------------------------

describe("abortableSleep (real setTimeout)", () => {
  test("resolves after the specified delay", async () => {
    const t0 = Date.now()
    await abortableSleep(20)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(15) // some scheduling slack
  })

  test("pre-aborted signal rejects synchronously", async () => {
    const ac = new AbortController()
    ac.abort(new Error("preabort"))
    await expect(abortableSleep(100, ac.signal)).rejects.toThrow("preabort")
  })

  test("aborting mid-sleep rejects and cancels the timer", async () => {
    const ac = new AbortController()
    const p = abortableSleep(10_000, ac.signal)
    setTimeout(() => ac.abort(new Error("midway")), 5)
    await expect(p).rejects.toThrow("midway")
  })

  test("uses DOMException AbortError when signal has no reason", async () => {
    const ac = new AbortController()
    ac.abort() // no reason
    try {
      await abortableSleep(100, ac.signal)
      throw new Error("should have thrown")
    } catch (err) {
      // Either Bun's default abort reason or our DOMException fallback.
      // Both indicate abort — assert by name not exact identity.
      expect((err as Error).name).toMatch(/AbortError/)
    }
  })
})

// --- describe block 6: integration-ish ----------------------------------

describe("retry — composition / realistic scenarios", () => {
  test("simulated 429-then-200 fetch with Retry-After header", async () => {
    const deps = makeFakeDeps({ randoms: [0.1] })
    type FakeResp = { status: number; headers: Map<string, string>; body: string }
    let calls = 0
    const result = await retry<FakeResp>(
      async () => {
        calls++
        if (calls === 1) {
          const err = new Error("HTTP 429") as Error & { response: FakeResp }
          err.response = { status: 429, headers: new Map([["retry-after", "1"]]), body: "" }
          throw err
        }
        return { status: 200, headers: new Map(), body: "ok" }
      },
      {
        maxAttempts: 3,
        baseDelayMs: 50,
        maxDelayMs: 5_000,
        shouldRetry: (err) => {
          const r = (err as { response?: FakeResp }).response
          if (!r) return { retry: true }
          if (r.status === 429) {
            const ra = r.headers.get("retry-after")
            const retryAfterMs = ra && /^\d+$/.test(ra) ? Number(ra) * 1000 : undefined
            return { retry: true, retryAfterMs }
          }
          return { retry: false }
        },
      },
      deps,
    )
    expect(result.status).toBe(200)
    expect(calls).toBe(2)
    expect(deps.sleeps).toEqual([1000]) // Retry-After: 1s honored
  })

  test("non-retryable 4xx fails fast without sleeps", async () => {
    const deps = makeFakeDeps()
    let calls = 0
    type FakeResp = { status: number }
    await expect(
      retry(
        async () => {
          calls++
          const err = new Error("HTTP 401") as Error & { response: FakeResp }
          err.response = { status: 401 }
          throw err
        },
        {
          maxAttempts: 5,
          baseDelayMs: 100,
          shouldRetry: (err) => {
            const r = (err as { response?: FakeResp }).response
            if (r && (r.status === 401 || r.status === 404)) return { retry: false }
            return { retry: true }
          },
        },
        deps,
      ),
    ).rejects.toThrow("HTTP 401")
    expect(calls).toBe(1)
    expect(deps.sleeps).toEqual([])
  })

  test("uses default opts when called with no options at all", async () => {
    // Sanity: smoke that default-call works (will use real setTimeout
    // with very small delays).
    let calls = 0
    const result = await retry<string>(
      async () => {
        calls++
        if (calls < 2) throw new Error("flake")
        return "ok"
      },
      { baseDelayMs: 1, maxDelayMs: 1 } satisfies RetryOptions,
    )
    expect(result).toBe("ok")
    expect(calls).toBe(2)
  })
})
