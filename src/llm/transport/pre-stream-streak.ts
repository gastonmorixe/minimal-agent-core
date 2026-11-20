/**
 * Count of consecutive pre-stream stalls, for each session and target.
 *
 * Each pre-stream retry of the same send doubles the pre-headers budget
 * (`stream-timeouts.ts`). Two callers retry a send: `canonicalSendFn`
 * (`withRetry`) and the agent loop, which calls `canonicalAttemptFn` once
 * for each attempt. The agent loop gives the transport no retry count, so
 * the transport keeps one itself, keyed by session id, provider and model:
 *
 * - a pre-stream `stream_idle` stall adds one;
 * - the first response body byte of an attempt clears it (the endpoint
 *   answered, so the next send starts at the base budget again);
 * - an entry older than {@link PRE_STREAM_STREAK_TTL_MS} counts as zero (a
 *   retry follows a stall within the backoff ceiling of 60 s).
 *
 * The map is bounded: at {@link MAX_PRE_STREAM_STREAKS} entries the oldest
 * entry goes out. No timers.
 *
 * @module llm/transport/pre-stream-streak
 */

/** An entry older than this counts as no streak. */
export const PRE_STREAM_STREAK_TTL_MS = 10 * 60_000
/** Most entries the map keeps. */
export const MAX_PRE_STREAM_STREAKS = 256

interface Streak {
  count: number
  at: number
}

/** Consecutive pre-stream stalls for each key. */
export class PreStreamStreaks {
  private readonly map = new Map<string, Streak>()

  /** Pre-stream stalls before the next attempt for `key` (0 when none or stale). */
  get(key: string, now = Date.now()): number {
    const s = this.map.get(key)
    if (s === undefined) return 0
    if (now - s.at > PRE_STREAM_STREAK_TTL_MS) {
      this.map.delete(key)
      return 0
    }
    return s.count
  }

  /** Record one pre-stream stall for `key`. */
  stalled(key: string, now = Date.now()): void {
    const count = this.get(key, now) + 1
    this.map.delete(key)
    this.map.set(key, { count, at: now })
    if (this.map.size > MAX_PRE_STREAM_STREAKS) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }

  /** The endpoint answered: clear the streak for `key`. */
  clear(key: string): void {
    this.map.delete(key)
  }

  /** Test seam: forget every streak. */
  reset(): void {
    this.map.clear()
  }
}

/** Process-wide streaks (the key has the session id). */
export const preStreamStreaks = new PreStreamStreaks()

/** Streak key for one send target. */
export function preStreamStreakKey(
  sessionId: string,
  providerId: string | undefined,
  model: string | undefined,
): string {
  return `${sessionId}\0${providerId ?? ""}\0${model ?? ""}`
}
