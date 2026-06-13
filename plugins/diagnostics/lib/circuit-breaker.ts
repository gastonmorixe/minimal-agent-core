/**
 * CircuitBreaker — resilience guard for the persistent LSP child.
 *
 * A crash-looping language server must not be spawned on every edit. The
 * breaker tracks consecutive failures and, once a threshold trips, refuses
 * attempts for a cooldown, then permits ONE trial (half-open). Repeated trips
 * past `maxTrips` mark the breaker `dead` (give up for the session). Pure logic
 * with an injectable clock so it tests deterministically without timers.
 *
 * States: `closed` (healthy) → `open` (tripped, refuse) → `half-open` (one
 * trial) → `closed` (recovered) or back to `open`; terminal `dead`.
 *
 * @module plugins/diagnostics/lib/circuit-breaker
 */
export type BreakerState = "closed" | "open" | "half-open" | "dead"

export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the breaker open. Default 3. */
  maxFailures?: number
  /** Cooldown before a half-open trial is permitted, ms. Default 5000. */
  cooldownMs?: number
  /** Max times the breaker may trip before going `dead`. Default 5. */
  maxTrips?: number
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number
}

/**
 * Classic closed/open/half-open circuit breaker guarding a flaky diagnostic
 * provider. Consecutive failures trip it open; after a cooldown one
 * half-open trial is allowed, and a success closes it again. A provider that
 * trips `maxTrips` times goes permanently `dead` for the rest of the
 * session.
 */
export class CircuitBreaker {
  private readonly maxFailures: number
  private readonly cooldownMs: number
  private readonly maxTrips: number
  private readonly now: () => number

  private failures = 0
  private trips = 0
  private openedAt = 0
  private _state: BreakerState = "closed"

  constructor(opts: CircuitBreakerOptions = {}) {
    this.maxFailures = opts.maxFailures ?? 3
    this.cooldownMs = opts.cooldownMs ?? 5000
    this.maxTrips = opts.maxTrips ?? 5
    this.now = opts.now ?? Date.now
  }

  /** Current state, resolving the open→half-open transition lazily by clock. */
  state(): BreakerState {
    if (this._state === "open" && this.now() - this.openedAt >= this.cooldownMs) {
      this._state = "half-open"
    }
    return this._state
  }

  /** True when a call may proceed (closed or half-open). */
  canAttempt(): boolean {
    const s = this.state()
    return s === "closed" || s === "half-open"
  }

  /** Record a successful call: reset failures, close the breaker. */
  recordSuccess(): void {
    if (this._state === "dead") return
    this.failures = 0
    this._state = "closed"
  }

  /** Record a failed call: may trip the breaker open or kill it. */
  recordFailure(): void {
    if (this._state === "dead") return
    // A failure during a half-open trial immediately re-opens.
    if (this._state === "half-open") {
      this.trip()
      return
    }
    this.failures++
    if (this.failures >= this.maxFailures) this.trip()
  }

  private trip(): void {
    this.trips++
    if (this.trips > this.maxTrips) {
      this._state = "dead"
      return
    }
    this._state = "open"
    this.openedAt = this.now()
    this.failures = 0
  }
}
