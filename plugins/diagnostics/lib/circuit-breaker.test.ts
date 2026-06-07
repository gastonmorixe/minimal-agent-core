/**
 * Tests for {@link CircuitBreaker} — guards the persistent LSP child so a
 * crash-looping server can't be hammered. Pure logic (an injected clock), no
 * process. Classic three states: closed (healthy) → open (tripped, refuse) →
 * half-open (one trial allowed) → closed/again-open.
 */
import { describe, expect, it } from "bun:test"

import { CircuitBreaker } from "./circuit-breaker.ts"

describe("CircuitBreaker", () => {
  it("starts closed and allows calls", () => {
    const cb = new CircuitBreaker({ maxFailures: 3, cooldownMs: 1000 })
    expect(cb.state()).toBe("closed")
    expect(cb.canAttempt()).toBe(true)
  })

  it("opens after maxFailures consecutive failures", () => {
    const cb = new CircuitBreaker({ maxFailures: 3, cooldownMs: 1000 })
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.state()).toBe("closed")
    cb.recordFailure()
    expect(cb.state()).toBe("open")
    expect(cb.canAttempt()).toBe(false)
  })

  it("a success resets the failure count", () => {
    const cb = new CircuitBreaker({ maxFailures: 3, cooldownMs: 1000 })
    cb.recordFailure()
    cb.recordFailure()
    cb.recordSuccess()
    cb.recordFailure()
    cb.recordFailure()
    expect(cb.state()).toBe("closed") // 2 < 3 after reset
  })

  it("transitions open → half-open after the cooldown elapses", () => {
    let now = 0
    const cb = new CircuitBreaker({ maxFailures: 1, cooldownMs: 500, now: () => now })
    cb.recordFailure()
    expect(cb.state()).toBe("open")
    expect(cb.canAttempt()).toBe(false)
    now = 499
    expect(cb.canAttempt()).toBe(false)
    now = 500
    expect(cb.canAttempt()).toBe(true) // half-open: one trial permitted
    expect(cb.state()).toBe("half-open")
  })

  it("a failure in half-open re-opens for another cooldown", () => {
    let now = 0
    const cb = new CircuitBreaker({ maxFailures: 1, cooldownMs: 500, now: () => now })
    cb.recordFailure()
    now = 500
    expect(cb.canAttempt()).toBe(true)
    cb.recordFailure() // trial failed
    expect(cb.state()).toBe("open")
    now = 600
    expect(cb.canAttempt()).toBe(false)
    now = 1000
    expect(cb.canAttempt()).toBe(true)
  })

  it("permanently gives up after maxRestarts trips", () => {
    let now = 0
    const cb = new CircuitBreaker({ maxFailures: 1, cooldownMs: 100, maxTrips: 2, now: () => now })
    cb.recordFailure() // trip 1 → open
    now = 100
    cb.canAttempt()
    cb.recordFailure() // trip 2 → open
    now = 200
    cb.canAttempt()
    cb.recordFailure() // trip 3 → exceeds maxTrips
    expect(cb.state()).toBe("dead")
    now = 100000
    expect(cb.canAttempt()).toBe(false) // never recovers
  })
})
