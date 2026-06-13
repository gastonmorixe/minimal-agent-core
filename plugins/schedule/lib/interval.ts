/**
 * Human interval → cron expression, with clean-step rounding.
 *
 * `/loop 5m …` and friends accept a duration token (`30m`, `2h`, `45s`,
 * `1d`) or a clause (`every 2 hours`). This module turns that into a
 * 5-field cron expression on a "clean" boundary — i.e. one that fires at a
 * truly regular cadence rather than drifting at the top of each hour/day.
 *
 * Cron's `*​/N` only steps evenly when `N` divides the field's range, so:
 *
 *   - minutes round to a divisor of 60 (1,2,3,4,5,6,10,12,15,20,30)
 *   - hours   round to a divisor of 24 (1,2,3,4,6,8,12)
 *   - longer  → every-N-days (`0 0 *​/N * *`)
 *
 * Sub-minute durations round UP to one minute (cron's floor granularity).
 * When the chosen cadence differs from the request, `rounded` is true and
 * the caller surfaces "rounded to …" to the user (per the docs).
 *
 * Pure + dependency-free.
 *
 * @module schedule/lib/interval
 */

const MIN_DIVISORS = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30] as const
const HOUR_DIVISORS = [1, 2, 3, 4, 6, 8, 12] as const

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86_400,
  day: 86_400,
  days: 86_400,
}

/** Result of converting an interval to cron. */
export interface IntervalCron {
  /** The 5-field cron expression. */
  cron: string
  /** Seconds the cron actually fires at (after rounding). */
  chosenSeconds: number
  /** True when `chosenSeconds` differs from what was requested. */
  rounded: boolean
  /** Compact human label for the chosen cadence, e.g. `"5m"`, `"2h"`. */
  label: string
}

/**
 * Parse a single duration token or clause into seconds.
 *
 * Accepts `30m`, `2 hours`, `every 90m`, `45s`, `1d`, etc. A leading
 * `every` and surrounding whitespace are ignored. Returns `null` when the
 * input is not a recognizable duration.
 *
 * @param input - Raw duration text.
 */
export function parseDuration(input: string): number | null {
  const cleaned = input
    .trim()
    .toLowerCase()
    .replace(/^every\s+/, "")
  const m = /^(\d+)\s*([a-z]+)$/.exec(cleaned)
  if (!m) return null
  const n = Number(m[1])
  const unit = UNIT_SECONDS[m[2] ?? ""]
  if (!Number.isFinite(n) || n <= 0 || unit === undefined) return null
  return n * unit
}

/**
 * Parse a duration token/clause into MILLISECONDS, or `null` if unrecognized.
 * Thin wrapper over {@link parseDuration} (which returns seconds). Used by the
 * `/loop` + `CronCreate` sub-minute path, which needs ms to drive the dynamic
 * pace's `intervalMs`.
 */
export function parseDurationMs(input: string): number | null {
  const seconds = parseDuration(input)
  return seconds === null ? null : seconds * 1000
}

/** Nearest value in `divisors` to `value`; ties resolve to the smaller. */
function nearest(value: number, divisors: readonly number[]): number {
  let best = divisors[0] as number
  let bestDiff = Math.abs(value - best)
  for (const d of divisors) {
    const diff = Math.abs(value - d)
    if (diff < bestDiff) {
      best = d
      bestDiff = diff
    }
  }
  return best
}

/** Compact label for a duration in seconds. */
function labelFor(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  return `${Math.round(seconds / 60)}m`
}

/**
 * Convert a duration (in seconds) to a clean-cadence cron expression.
 *
 * @param seconds - Requested interval in seconds (greater than 0).
 * @returns The cron + the cadence actually chosen + whether it was rounded.
 */
export function durationToCron(seconds: number): IntervalCron {
  const requested = seconds
  // Cron floors at one minute; round sub-minute up.
  const minutes = Math.max(1, Math.ceil(seconds / 60))

  let cron: string
  let chosenSeconds: number

  if (minutes < 60) {
    const step = nearest(minutes, MIN_DIVISORS)
    cron = `*/${step} * * * *`
    chosenSeconds = step * 60
  } else if (minutes === 60) {
    cron = "0 * * * *"
    chosenSeconds = 3600
  } else {
    const hours = Math.round(minutes / 60)
    if (hours < 24) {
      const step = nearest(hours, HOUR_DIVISORS)
      cron = `0 */${step} * * *`
      chosenSeconds = step * 3600
    } else {
      const days = Math.max(1, Math.round(hours / 24))
      cron = `0 0 */${days} * *`
      chosenSeconds = days * 86_400
    }
  }

  return {
    cron,
    chosenSeconds,
    rounded: chosenSeconds !== requested,
    label: labelFor(chosenSeconds),
  }
}

/**
 * Parse a human interval string and convert it to a clean cron cadence in
 * one step. Returns `null` when `input` is not a duration.
 *
 * @param input - e.g. `"5m"`, `"every 2 hours"`, `"90m"`.
 */
export function intervalToCron(input: string): IntervalCron | null {
  const seconds = parseDuration(input)
  if (seconds === null) return null
  return durationToCron(seconds)
}
