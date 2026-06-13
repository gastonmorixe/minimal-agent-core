/**
 * Minimal 5-field cron parser + evaluator.
 *
 * Pure, dependency-free, and self-contained (a plugin never imports
 * harness runtime). Supports standard vixie-cron syntax:
 *
 *   minute hour day-of-month month day-of-week
 *
 * Per field: `*`, single value `5`, step `*​/15`, range `1-5`,
 * range+step `1-5/2`, and comma lists `1,15,30`. Day-of-week accepts
 * `0`/`7` for Sunday. Extended syntax (`L`, `W`, `?`, name aliases like
 * `MON`/`JAN`) is rejected with a {@link CronError}.
 *
 * Evaluation is minute-granular and interpreted in the host's LOCAL time
 * (matching the scheduled-tasks contract: `0 9 * * *` is 9am wherever the
 * agent runs, not UTC).
 *
 * @module schedule/lib/cron
 */

/** Thrown when an expression cannot be parsed. */
export class CronError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CronError"
  }
}

/** One parsed field: the set of matching values + whether it was a bare `*`. */
interface CronField {
  /** Allowed values for this field (already range-validated). */
  values: ReadonlySet<number>
  /** True only when the source token was exactly `*` (vixie dom/dow OR rule). */
  star: boolean
}

/** A parsed 5-field cron expression. */
export interface CronExpr {
  readonly source: string
  readonly minute: CronField
  readonly hour: CronField
  readonly dom: CronField
  readonly month: CronField
  readonly dow: CronField
}

interface FieldSpec {
  min: number
  max: number
  name: string
}

const FIELDS: Record<"minute" | "hour" | "dom" | "month" | "dow", FieldSpec> = {
  minute: { min: 0, max: 59, name: "minute" },
  hour: { min: 0, max: 23, name: "hour" },
  dom: { min: 1, max: 31, name: "day-of-month" },
  month: { min: 1, max: 12, name: "month" },
  dow: { min: 0, max: 7, name: "day-of-week" },
}

/** Parse one field token into a {@link CronField}. */
function parseField(token: string, spec: FieldSpec): CronField {
  if (token.length === 0) throw new CronError(`empty ${spec.name} field`)
  if (/[a-zA-Z]/.test(token)) {
    throw new CronError(
      `${spec.name} field "${token}" uses unsupported syntax (names/L/W/? are not supported)`,
    )
  }
  if (/[?LW#]/.test(token)) {
    throw new CronError(`${spec.name} field "${token}" uses unsupported extended syntax`)
  }

  const star = token === "*"
  const values = new Set<number>()

  for (const part of token.split(",")) {
    if (part.length === 0) throw new CronError(`empty list item in ${spec.name} field`)

    // Split optional /step.
    const [rangePart, stepPart, ...rest] = part.split("/")
    if (rest.length > 0) throw new CronError(`malformed ${spec.name} field "${part}"`)
    let step = 1
    if (stepPart !== undefined) {
      step = Number(stepPart)
      if (!Number.isInteger(step) || step <= 0) {
        throw new CronError(`invalid step "${stepPart}" in ${spec.name} field`)
      }
    }

    let lo: number
    let hi: number
    if (rangePart === "*") {
      lo = spec.min
      hi = spec.max
    } else if (rangePart.includes("-")) {
      const [a, b, ...more] = rangePart.split("-")
      if (more.length > 0) throw new CronError(`malformed range "${rangePart}" in ${spec.name}`)
      lo = Number(a)
      hi = Number(b)
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
        throw new CronError(`non-numeric range "${rangePart}" in ${spec.name}`)
      }
    } else {
      const v = Number(rangePart)
      if (!Number.isInteger(v))
        throw new CronError(`non-numeric value "${rangePart}" in ${spec.name}`)
      lo = v
      // A bare single value with a step (`5/15`) means "from 5 to max step".
      hi = stepPart !== undefined ? spec.max : v
    }

    if (lo < spec.min || hi > spec.max || lo > hi) {
      throw new CronError(
        `${spec.name} value out of range in "${part}" (allowed ${spec.min}-${spec.max})`,
      )
    }
    for (let v = lo; v <= hi; v += step) addNormalized(values, v, spec)
  }

  return { values, star }
}

/** Add a value, normalizing day-of-week 7 → 0 (Sunday). */
function addNormalized(set: Set<number>, v: number, spec: FieldSpec): void {
  if (spec.name === "day-of-week" && v === 7) {
    set.add(0)
    return
  }
  set.add(v)
}

/**
 * Parse a 5-field cron expression. Throws {@link CronError} on any
 * malformed field. Whitespace between fields is collapsed.
 *
 * @param expr - A 5-field cron string, e.g. `"*​/5 * * * *"`.
 * @returns The parsed, evaluable expression.
 */
export function parseCron(expr: string): CronExpr {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw new CronError(`expected 5 fields, got ${parts.length}: "${expr.trim()}"`)
  }
  const [m, h, dom, mon, dow] = parts as [string, string, string, string, string]
  return {
    source: expr.trim(),
    minute: parseField(m, FIELDS.minute),
    hour: parseField(h, FIELDS.hour),
    dom: parseField(dom, FIELDS.dom),
    month: parseField(mon, FIELDS.month),
    dow: parseField(dow, FIELDS.dow),
  }
}

/** Non-throwing validity check. */
export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}

/**
 * Does `date` (local time) satisfy the expression at minute granularity?
 *
 * Implements vixie day semantics: when BOTH day-of-month and day-of-week
 * are constrained (neither a bare `*`), the day matches if EITHER field
 * matches; otherwise both must match (the unconstrained one is `*` and
 * always does).
 *
 * @param expr - Parsed expression.
 * @param date - Local-time instant to test.
 */
export function matches(expr: CronExpr, date: Date): boolean {
  if (!expr.minute.values.has(date.getMinutes())) return false
  if (!expr.hour.values.has(date.getHours())) return false
  if (!expr.month.values.has(date.getMonth() + 1)) return false

  const domOk = expr.dom.values.has(date.getDate())
  const dowOk = expr.dow.values.has(date.getDay())
  if (!expr.dom.star && !expr.dow.star) return domOk || dowOk
  return domOk && dowOk
}

/**
 * The next local-time instant strictly after `from` (seconds zeroed) that
 * matches `expr`, or `null` when none occurs within `horizonDays`.
 *
 * Field-aware skipping keeps this cheap (a handful of iterations even for
 * yearly jobs), so the heartbeat can call it for a "next fire" status row.
 *
 * @param expr - Parsed expression.
 * @param from - Lower bound (exclusive at minute granularity).
 * @param horizonDays - Max look-ahead before giving up. Default 366.
 */
export function nextFire(expr: CronExpr, from: Date, horizonDays = 366): Date | null {
  const cap = new Date(from.getTime() + horizonDays * 24 * 60 * 60 * 1000)
  // Start at the next whole minute.
  const d = new Date(from.getTime())
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)

  // Bounded loop: each iteration either returns or advances by ≥1 minute,
  // usually by a much larger field-aligned jump.
  for (let guard = 0; guard < 600_000; guard++) {
    if (d.getTime() > cap.getTime()) return null
    if (!expr.month.values.has(d.getMonth() + 1)) {
      // Jump to the 1st of next month at 00:00.
      d.setMonth(d.getMonth() + 1, 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    const domOk = expr.dom.values.has(d.getDate())
    const dowOk = expr.dow.values.has(d.getDay())
    const dayOk = !expr.dom.star && !expr.dow.star ? domOk || dowOk : domOk && dowOk
    if (!dayOk) {
      d.setDate(d.getDate() + 1)
      d.setHours(0, 0, 0, 0)
      continue
    }
    if (!expr.hour.values.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!expr.minute.values.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0)
      continue
    }
    return d
  }
  return null
}
