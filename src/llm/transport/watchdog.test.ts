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
  modelId: "claude-opus-4-8",
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
})
