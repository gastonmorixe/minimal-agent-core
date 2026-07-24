/**
 * Tests for the provider-neutral stream watchdog.
 *
 * Mirrors the legacy `client.stream-watchdog.test.ts` coverage but at the
 * canonical-event layer: idle, hard-timeout, truncation, clean pass-through,
 * and upstream-cancel propagation. Timeouts use the real 1s tick, so the
 * timing tests take ~1s each (same as the legacy suite).
 *
 * @module llm/transport/watchdog.test
 */

import { describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "../canonical-events.ts"

import { type WatchdogError, withStreamWatchdog } from "./watchdog.ts"

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" })
}

/**
 * Build a canonical attempt factory. Emits `events`, then either closes
 * cleanly or (when `stall`) waits for the watchdog's abort and throws an
 * AbortError the way a real transport tears down on signal.
 */
function attempt(
  events: CanonicalEvent[],
  opts: { stall?: boolean } = {},
): (signal: AbortSignal) => AsyncIterable<CanonicalEvent> {
  return async function* (signal: AbortSignal) {
    for (const ev of events) yield ev
    if (opts.stall) {
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) return reject(abortError())
        signal.addEventListener("abort", () => reject(abortError()), { once: true })
      })
    }
  }
}

const START: CanonicalEvent = {
  type: "message_start",
  messageId: "m",
  modelId: "test-model-large",
  initialUsage: { inputTokens: 1, outputTokens: 0 },
}

async function collect(it: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe("withStreamWatchdog", () => {
  it("passes events through unchanged when message_stop arrives", async () => {
    const events: CanonicalEvent[] = [
      START,
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "hi" },
      { type: "text_stop", index: 0 },
      { type: "message_delta", stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } },
      { type: "message_stop" },
    ]
    const got = await collect(withStreamWatchdog(attempt(events)))
    expect(got).toEqual(events)
  })

  it("throws stream_idle when no event arrives within streamIdleTimeoutMs", async () => {
    let stall: { reason: string } | undefined
    const run = withStreamWatchdog(attempt([START], { stall: true }), {
      streamIdleTimeoutMs: 50,
      attemptHardTimeoutMs: 30_000,
      onStall: (i) => {
        stall = i
      },
    })
    let caught: WatchdogError | undefined
    try {
      await collect(run)
    } catch (e) {
      caught = e as WatchdogError
    }
    expect(caught?.streamErrorType).toBe("stream_idle")
    expect(stall?.reason).toBe("stream_idle")
  }, 10_000)

  it("throws attempt_too_long when elapsed exceeds attemptHardTimeoutMs (idle high)", async () => {
    const run = withStreamWatchdog(attempt([START], { stall: true }), {
      streamIdleTimeoutMs: 30_000,
      attemptHardTimeoutMs: 50,
    })
    let caught: WatchdogError | undefined
    try {
      await collect(run)
    } catch (e) {
      caught = e as WatchdogError
    }
    expect(caught?.streamErrorType).toBe("attempt_too_long")
  }, 10_000)

  it("throws stream_truncated when the body closes without message_stop", async () => {
    const events: CanonicalEvent[] = [
      START,
      { type: "text_start", index: 0 },
      { type: "text_delta", index: 0, text: "partial" },
      // no text_stop, no message_delta, no message_stop
    ]
    let caught: WatchdogError | undefined
    try {
      await collect(withStreamWatchdog(attempt(events)))
    } catch (e) {
      caught = e as WatchdogError
    }
    expect(caught?.streamErrorType).toBe("stream_truncated")
  })

  it("propagates an upstream cancel as AbortError (not a stall tag)", async () => {
    const ac = new AbortController()
    const run = withStreamWatchdog(attempt([START], { stall: true }), {
      signal: ac.signal,
      streamIdleTimeoutMs: 30_000,
      attemptHardTimeoutMs: 30_000,
    })
    queueMicrotask(() => ac.abort())
    let caught: Error | undefined
    try {
      await collect(run)
    } catch (e) {
      caught = e as Error
    }
    expect(caught?.name).toBe("AbortError")
    expect((caught as WatchdogError).streamErrorType).toBeUndefined()
  }, 10_000)

  it("uses the longer thinking idle budget while a thinking block is open", async () => {
    // Open thinking + stall: ordinary idle=80ms must NOT fire; thinking idle=1500ms should.
    // Hard timeout high so only idle can trip.
    const thinkingOpen: CanonicalEvent[] = [
      START,
      { type: "thinking_start", index: 0 },
      { type: "thinking_delta", index: 0, text: "still working" },
    ]
    let stall: { reason: string; idleMs: number } | undefined
    const run = withStreamWatchdog(attempt(thinkingOpen, { stall: true }), {
      streamIdleTimeoutMs: 80,
      thinkingIdleTimeoutMs: 1500,
      attemptHardTimeoutMs: 30_000,
      onStall: (i) => {
        stall = i
      },
    })
    const t0 = Date.now()
    let caught: WatchdogError | undefined
    try {
      await collect(run)
    } catch (e) {
      caught = e as WatchdogError
    }
    const elapsed = Date.now() - t0
    expect(caught?.streamErrorType).toBe("stream_idle")
    expect(stall?.reason).toBe("stream_idle")
    // Must have waited past the ordinary 80ms budget (with 1s tick + margin).
    expect(elapsed).toBeGreaterThanOrEqual(1000)
    // And not have used a multi-minute default — we set thinking idle to 1.5s.
    expect(elapsed).toBeLessThan(5000)
  }, 15_000)

  it("reverts to ordinary idle after thinking_stop", async () => {
    const afterThinking: CanonicalEvent[] = [
      START,
      { type: "thinking_start", index: 0 },
      { type: "thinking_delta", index: 0, text: "done thinking" },
      { type: "thinking_stop", index: 0 },
    ]
    const run = withStreamWatchdog(attempt(afterThinking, { stall: true }), {
      streamIdleTimeoutMs: 50,
      thinkingIdleTimeoutMs: 30_000,
      attemptHardTimeoutMs: 30_000,
    })
    let caught: WatchdogError | undefined
    try {
      await collect(run)
    } catch (e) {
      caught = e as WatchdogError
    }
    expect(caught?.streamErrorType).toBe("stream_idle")
  }, 10_000)

  it("pre-stream: hangs with no body activity until responseHeadersTimeoutMs (not mid-stream idle)", async () => {
    // MA-882492: attempt start with zero events must NOT use 30s mid-stream idle.
    let stall: { reason: string; stallPhase?: string; stallSubPhase?: string } | undefined
    const hang = (_signal: AbortSignal): AsyncIterable<CanonicalEvent> =>
      (async function* () {
        await new Promise<void>((_resolve, reject) => {
          if (_signal.aborted) return reject(abortError())
          _signal.addEventListener("abort", () => reject(abortError()), { once: true })
        })
      })()

    const t0 = Date.now()
    let caught: WatchdogError | undefined
    try {
      await collect(
        withStreamWatchdog(hang, {
          responseHeadersTimeoutMs: 50,
          streamIdleTimeoutMs: 30_000,
          attemptHardTimeoutMs: 30_000,
          onStall: (i) => {
            stall = i
          },
        }),
      )
    } catch (e) {
      caught = e as WatchdogError
    }
    const elapsed = Date.now() - t0
    expect(caught?.streamErrorType).toBe("stream_idle")
    expect(caught?.stallPhase).toBe("pre-stream")
    expect(caught?.stallSubPhase).toBe("pre-headers")
    expect(stall?.stallPhase).toBe("pre-stream")
    expect(elapsed).toBeGreaterThanOrEqual(900)
    // Must not wait for multi-second mid-stream default.
    expect(elapsed).toBeLessThan(5000)
  }, 15_000)

  it("pre-stream: headers-wait-body sub-phase when markHeadersReceived without body bytes", async () => {
    let phaseCtl: { markHeadersReceived: () => void; markBodyActivity: () => void } | undefined
    const hang = (_signal: AbortSignal): AsyncIterable<CanonicalEvent> =>
      (async function* () {
        phaseCtl?.markHeadersReceived()
        await new Promise<void>((_resolve, reject) => {
          if (_signal.aborted) return reject(abortError())
          _signal.addEventListener("abort", () => reject(abortError()), { once: true })
        })
      })()

    let caught: WatchdogError | undefined
    try {
      await collect(
        withStreamWatchdog(hang, {
          responseHeadersTimeoutMs: 50,
          streamIdleTimeoutMs: 30_000,
          attemptHardTimeoutMs: 30_000,
          onBindPhaseControl: (ctl) => {
            phaseCtl = ctl
          },
        }),
      )
    } catch (e) {
      caught = e as WatchdogError
    }
    expect(caught?.streamErrorType).toBe("stream_idle")
    expect(caught?.stallPhase).toBe("pre-stream")
    expect(caught?.stallSubPhase).toBe("headers-wait-body")
  }, 15_000)

  it("markBodyActivity ends pre-stream and arms mid-stream idle (byte-level, no CanonicalEvent)", async () => {
    let phaseCtl: { markHeadersReceived: () => void; markBodyActivity: () => void } | undefined
    const makeStream = (signal: AbortSignal): AsyncIterable<CanonicalEvent> =>
      (async function* () {
        phaseCtl?.markHeadersReceived()
        // Simulate SSE comment/keepalive bytes with no translated CanonicalEvent.
        phaseCtl?.markBodyActivity()
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) return reject(abortError())
          signal.addEventListener("abort", () => reject(abortError()), { once: true })
        })
      })()

    let caught: WatchdogError | undefined
    try {
      await collect(
        withStreamWatchdog(makeStream, {
          responseHeadersTimeoutMs: 30_000,
          streamIdleTimeoutMs: 50,
          attemptHardTimeoutMs: 30_000,
          onBindPhaseControl: (ctl) => {
            phaseCtl = ctl
          },
        }),
      )
    } catch (e) {
      caught = e as WatchdogError
    }
    expect(caught?.streamErrorType).toBe("stream_idle")
    expect(caught?.stallPhase).toBe("mid-stream")
  }, 15_000)

  it("markBodyActivity refreshes mid-stream idle on subsequent raw chunks", async () => {
    let phaseCtl: { markHeadersReceived: () => void; markBodyActivity: () => void } | undefined
    const makeStream = (signal: AbortSignal): AsyncIterable<CanonicalEvent> =>
      (async function* () {
        phaseCtl?.markBodyActivity()
        // Keepalive bytes every 400ms — longer than a naive 50ms idle if not refreshed.
        for (let i = 0; i < 4; i++) {
          await new Promise((r) => setTimeout(r, 400))
          if (signal.aborted) throw abortError()
          phaseCtl?.markBodyActivity()
        }
        yield START
        yield { type: "message_stop" } satisfies CanonicalEvent
      })()

    const got = await collect(
      withStreamWatchdog(makeStream, {
        responseHeadersTimeoutMs: 30_000,
        streamIdleTimeoutMs: 500,
        attemptHardTimeoutMs: 30_000,
        onBindPhaseControl: (ctl) => {
          phaseCtl = ctl
        },
      }),
    )
    expect(got.some((e) => e.type === "message_stop")).toBe(true)
  }, 15_000)

  it("mid-stream idle still trips after CanonicalEvents when silence follows", async () => {
    let stall: { stallPhase?: string } | undefined
    const run = withStreamWatchdog(attempt([START], { stall: true }), {
      streamIdleTimeoutMs: 50,
      responseHeadersTimeoutMs: 30_000,
      attemptHardTimeoutMs: 30_000,
      onStall: (i) => {
        stall = i
      },
    })
    let caught: WatchdogError | undefined
    try {
      await collect(run)
    } catch (e) {
      caught = e as WatchdogError
    }
    expect(caught?.streamErrorType).toBe("stream_idle")
    expect(caught?.stallPhase).toBe("mid-stream")
    expect(stall?.stallPhase).toBe("mid-stream")
  }, 10_000)

  it("fires onStall exactly once when try-path and catch-path both observe the abort", async () => {
    // Sergio/Benjamin: api.stream-stalled was logged twice because fail() ran
    // once for the in-loop reason check and again in the catch after abort.
    let stalls = 0
    const run = withStreamWatchdog(attempt([START], { stall: true }), {
      streamIdleTimeoutMs: 50,
      attemptHardTimeoutMs: 30_000,
      onStall: () => {
        stalls++
      },
    })
    let caught: WatchdogError | undefined
    try {
      await collect(run)
    } catch (e) {
      caught = e as WatchdogError
    }
    expect(caught?.streamErrorType).toBe("stream_idle")
    expect(stalls).toBe(1)
  }, 10_000)

  it("prefers stream_idle over a synthetic terminal-less drain after abort", async () => {
    // Reproduces 113921b7: watchdog aborts → body drains quietly → adapter
    // would yield stream_closed_without_terminal. Watchdog must throw
    // stream_idle and not forward that synthetic error event.
    const thinkingOpen: CanonicalEvent[] = [
      START,
      { type: "thinking_start", index: 0 },
      { type: "thinking_delta", index: 0, text: "…" },
    ]
    const makeStream = (signal: AbortSignal): AsyncIterable<CanonicalEvent> =>
      (async function* () {
        for (const ev of thinkingOpen) yield ev
        // Stall until the watchdog aborts, then quiet-drain (resolve, don't
        // throw) and emit the synthetic terminal-less error the Responses
        // translator produces on clean EOF without response.completed.
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener("abort", () => resolve(), { once: true })
        })
        yield {
          type: "stream_error",
          retryable: true,
          category: "api",
          upstreamType: "stream_closed_without_terminal",
          cause: new Error("Responses stream closed without a terminal event (truncated)"),
        } satisfies CanonicalEvent
      })()

    let stall: { reason: string } | undefined
    const run = withStreamWatchdog(makeStream, {
      streamIdleTimeoutMs: 50,
      thinkingIdleTimeoutMs: 80,
      attemptHardTimeoutMs: 30_000,
      onStall: (i) => {
        stall = i
      },
    })
    let caught: WatchdogError | undefined
    const yielded: CanonicalEvent[] = []
    try {
      for await (const ev of run) yielded.push(ev)
    } catch (e) {
      caught = e as WatchdogError
    }
    expect(caught?.streamErrorType).toBe("stream_idle")
    expect(stall?.reason).toBe("stream_idle")
    // Must not have yielded the synthetic stream_error (would poison classification).
    expect(yielded.some((e) => e.type === "stream_error")).toBe(false)
  }, 15_000)
})
