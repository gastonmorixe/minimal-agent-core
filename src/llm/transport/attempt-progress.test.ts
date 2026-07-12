/**
 * Unit tests for terminal-less recovery policy (pure).
 *
 * @module llm/transport/attempt-progress.test
 */

import { describe, expect, it } from "bun:test"

import {
  decideTerminalLessRecovery,
  MAX_PRE_EFFECT_TERMINALLESS_RETRIES,
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

  it("allows one short pre-effect retry when nothing completed", () => {
    const d = decideTerminalLessRecovery({
      progress: ZERO_ATTEMPT_PROGRESS,
      priorTerminalLessRetries: 0,
      jitter: 0.5,
    })
    expect(d.kind).toBe("retryTransport")
    if (d.kind === "retryTransport") {
      // H2 origin eviction is not wired; must stay false (no false claims).
      expect(d.freshConnection).toBe(false)
      expect(d.delayMs).toBeGreaterThanOrEqual(0)
      expect(d.delayMs).toBeLessThan(30_000)
    }
  })

  it("fails the turn after the pre-effect budget is exhausted", () => {
    const d = decideTerminalLessRecovery({
      progress: { ...ZERO_ATTEMPT_PROGRESS, sawReasoning: true },
      priorTerminalLessRetries: MAX_PRE_EFFECT_TERMINALLESS_RETRIES,
      jitter: 0,
    })
    expect(d.kind).toBe("failTurn")
  })

  it("healthy long thinking is not a special failure path when tools completed", () => {
    // Reasoning-only with zero tools still gets the one pre-effect retry.
    const d = decideTerminalLessRecovery({
      progress: { sawReasoning: true, sawText: false, completedToolCalls: 0 },
      priorTerminalLessRetries: 0,
      jitter: 0,
    })
    expect(d.kind).toBe("retryTransport")
  })
})
