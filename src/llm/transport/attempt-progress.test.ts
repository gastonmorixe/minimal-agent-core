/**
 * Unit tests for terminal-less recovery policy (pure).
 *
 * Never-give-up: pre-effect closes always retryTransport; only completed tools
 * force continueTurn (no re-POST).
 *
 * @module llm/transport/attempt-progress.test
 */

import { describe, expect, it } from "bun:test"

import {
  decideTerminalLessRecovery,
  TERMINALLESS_MIDSTREAM_RETRY_BASE_DELAY_MS,
  TERMINALLESS_RETRY_BASE_DELAY_MS,
  TERMINALLESS_RETRY_MAX_DELAY_MS,
  ZERO_ATTEMPT_PROGRESS,
} from "./attempt-progress.ts"

describe("decideTerminalLessRecovery", () => {
  it("never retries transport after a completed tool call", () => {
    const d = decideTerminalLessRecovery({
      progress: { ...ZERO_ATTEMPT_PROGRESS, completedToolCalls: 1 },
      priorTerminalLessRetries: 0,
      jitter: 0,
    })
    expect(d).toEqual({ kind: "continueTurn", reason: "terminalLessClose" })
  })

  it("never retries transport after tools even after many prior pre-effect retries", () => {
    const d = decideTerminalLessRecovery({
      progress: {
        sawReasoning: true,
        sawText: true,
        completedToolCalls: 2,
      },
      priorTerminalLessRetries: 100,
      jitter: 0,
    })
    expect(d).toEqual({ kind: "continueTurn", reason: "terminalLessClose" })
  })

  it("allows short empty pre-effect retry when nothing was observed", () => {
    const d = decideTerminalLessRecovery({
      progress: ZERO_ATTEMPT_PROGRESS,
      priorTerminalLessRetries: 0,
      jitter: 0.5,
    })
    expect(d.kind).toBe("retryTransport")
    if (d.kind === "retryTransport") {
      expect(d.freshConnection).toBe(false)
      expect(d.curve).toBe("terminal-less-empty")
      expect(d.delayMs).toBeGreaterThanOrEqual(0)
      expect(d.delayMs).toBeLessThan(TERMINALLESS_RETRY_BASE_DELAY_MS)
    }
  })

  it("never failTurns on empty closes — retries forever (never-give-up)", () => {
    // After many empty retries we still retryTransport, never failTurn.
    for (const prior of [0, 1, 5, 20, 100]) {
      const d = decideTerminalLessRecovery({
        progress: ZERO_ATTEMPT_PROGRESS,
        priorTerminalLessRetries: prior,
        jitter: 0,
      })
      expect(d.kind).toBe("retryTransport")
      if (d.kind === "retryTransport") {
        expect(d.curve).toBe("terminal-less-empty")
        expect(d.delayMs).toBeLessThanOrEqual(TERMINALLESS_RETRY_MAX_DELAY_MS)
      }
    }
  })

  it("uses midstream backoff for reasoning-only closes (not a near-zero thrash)", () => {
    // Session 113921b7: saw-reasoning=true, completedToolCalls=0, delay ~0ms was wrong.
    const d = decideTerminalLessRecovery({
      progress: { sawReasoning: true, sawText: false, completedToolCalls: 0 },
      priorTerminalLessRetries: 0,
      jitter: 0,
    })
    expect(d.kind).toBe("retryTransport")
    if (d.kind === "retryTransport") {
      expect(d.curve).toBe("terminal-less-midstream")
      expect(d.freshConnection).toBe(false)
      expect(d.delayMs).toBeGreaterThanOrEqual(
        Math.floor(TERMINALLESS_MIDSTREAM_RETRY_BASE_DELAY_MS / 2),
      )
      expect(d.delayMs).toBeLessThanOrEqual(TERMINALLESS_MIDSTREAM_RETRY_BASE_DELAY_MS)
    }
  })

  it("uses midstream backoff for text-only pre-tool closes", () => {
    const d = decideTerminalLessRecovery({
      progress: { sawReasoning: false, sawText: true, completedToolCalls: 0 },
      priorTerminalLessRetries: 0,
      jitter: 1,
    })
    expect(d.kind).toBe("retryTransport")
    if (d.kind === "retryTransport") {
      expect(d.curve).toBe("terminal-less-midstream")
      expect(d.delayMs).toBeGreaterThanOrEqual(
        Math.floor(TERMINALLESS_MIDSTREAM_RETRY_BASE_DELAY_MS / 2),
      )
    }
  })

  it("never failTurns on midstream closes — keeps retrying after many attempts", () => {
    // Old bug: failTurn after prior=1 for reasoning-only. Never-give-up forbids that.
    for (const prior of [0, 1, 3, 12, 50]) {
      const d = decideTerminalLessRecovery({
        progress: { sawReasoning: true, sawText: false, completedToolCalls: 0 },
        priorTerminalLessRetries: prior,
        jitter: 0,
      })
      expect(d.kind).toBe("retryTransport")
      if (d.kind === "retryTransport") {
        expect(d.curve).toBe("terminal-less-midstream")
        expect(d.delayMs).toBeGreaterThanOrEqual(
          Math.floor(TERMINALLESS_MIDSTREAM_RETRY_BASE_DELAY_MS / 2),
        )
        expect(d.delayMs).toBeLessThanOrEqual(TERMINALLESS_RETRY_MAX_DELAY_MS)
      }
    }
  })

  it("caps midstream delay at TERMINALLESS_RETRY_MAX_DELAY_MS", () => {
    const d = decideTerminalLessRecovery({
      progress: { sawReasoning: true, sawText: false, completedToolCalls: 0 },
      priorTerminalLessRetries: 40,
      jitter: 1,
    })
    expect(d.kind).toBe("retryTransport")
    if (d.kind === "retryTransport") {
      expect(d.delayMs).toBeLessThanOrEqual(TERMINALLESS_RETRY_MAX_DELAY_MS)
    }
  })
})
