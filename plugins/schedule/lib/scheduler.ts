/**
 * Scheduler policy: decide which tasks fire, dedupe, expire, re-arm.
 *
 * Pure functional core — no IO, no clock, no bus. The heartbeat slot is
 * the imperative shell: it loads from the {@link CronStore}, calls
 * {@link due} with the wall clock, injects each fired task's prompt, and
 * persists the mutated set.
 *
 * Firing rules (matching the scheduled-tasks contract):
 *   - Fixed recurring: fire when the current minute matches the cron AND
 *     we haven't already fired this minute (one fire per matching minute,
 *     no matter how often the heartbeat ticks). No catch-up for minutes
 *     missed while the agent was busy.
 *   - One-shot (fixed or reminder): stores an absolute `nextAtMs`; fires
 *     once when `now >= nextAtMs`, then deletes itself.
 *   - Dynamic ("self-paced"): fires at `nextAtMs`, then re-arms
 *     `nextAtMs = now + defaultDynamicMs` so the loop keeps running at a
 *     default cadence until the model adjusts it.
 *   - Recurring tasks drop when past their 7-day `expiresAt`.
 *
 * Jitter is a per-task sub-minute offset derived from the id. It only
 * gates fixed-recurring fires (spreads them across the first ~30s of the
 * matching minute) and is injectable so tests stay deterministic. The
 * full cross-session 30-minute spread from the cloud product is
 * intentionally NOT replicated — a single local session wants its loop to
 * fire promptly.
 *
 * @module schedule/lib/scheduler
 */

import { matches, nextFire, parseCron } from "./cron.ts"
import type { CronEntry } from "./store.ts"

const DEFAULT_DYNAMIC_MS = 5 * 60 * 1000
const MINUTE_MS = 60_000

/** Floor a ms timestamp to its minute. */
export function floorToMinute(ms: number): number {
  return Math.floor(ms / MINUTE_MS) * MINUTE_MS
}

/** Deterministic 0–29s jitter from a task id (FNV-1a-ish hash). */
export function jitterSecondsFor(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = (h * 0x01000193) >>> 0
  }
  return h % 30
}

/** Is this entry time-based (one-shot or dynamic) rather than cron-recurring? */
function isTimeBased(e: CronEntry): boolean {
  return e.pace === "dynamic" || !e.recurs
}

/** Options for {@link due}. */
export interface DueOptions {
  /** Per-task sub-minute fire offset (default 0 = fire immediately). */
  jitterSeconds?: (id: string) => number
  /** Re-arm interval for dynamic tasks after a fire. */
  defaultDynamicMs?: number
}

/** Outcome of a scheduler tick. */
export interface DueOutcome {
  /** Entries whose prompt must be injected now (in list order). */
  fire: CronEntry[]
  /**
   * The full task set to persist when anything changed (lastFiredAt
   * bumped, one-shots removed, expired dropped, dynamic re-armed), or
   * `null` when nothing changed (skip the write).
   */
  mutated: CronEntry[] | null
}

/**
 * Compute which tasks fire at `now`.
 *
 * @param entries - Current task set (already pruned of resume-stale items).
 * @param now - Wall clock in ms.
 * @param opts - Jitter + dynamic-cadence injection.
 */
export function due(entries: CronEntry[], now: number, opts: DueOptions = {}): DueOutcome {
  const jitter = opts.jitterSeconds ?? (() => 0)
  const dynMs = opts.defaultDynamicMs ?? DEFAULT_DYNAMIC_MS
  const nowDate = new Date(now)
  const nowMinute = floorToMinute(now)

  const fire: CronEntry[] = []
  const keep: CronEntry[] = []
  let changed = false

  for (const e of entries) {
    // Recurring task past its hard 7-day expiry → drop.
    if (e.recurs && e.expiresAt !== undefined && now >= e.expiresAt) {
      changed = true
      continue
    }

    let shouldFire = false
    if (isTimeBased(e) && e.nextAtMs !== undefined) {
      shouldFire = now >= e.nextAtMs && (e.lastFiredAt === undefined || e.lastFiredAt < e.nextAtMs)
    } else {
      let cron
      try {
        cron = parseCron(e.cron)
      } catch {
        // Malformed cron: keep the entry (so the user can see + delete it)
        // but never fire it.
        keep.push(e)
        continue
      }
      const matchesNow = matches(cron, nowDate)
      const firedThisMinute =
        e.lastFiredAt !== undefined && floorToMinute(e.lastFiredAt) >= nowMinute
      shouldFire = matchesNow && !firedThisMinute && nowDate.getSeconds() >= jitter(e.id)
    }

    if (!shouldFire) {
      keep.push(e)
      continue
    }

    fire.push(e)
    changed = true
    if (!e.recurs) {
      // One-shot: delete after firing (don't keep).
      continue
    }
    const updated: CronEntry = { ...e, lastFiredAt: now }
    if (e.pace === "dynamic") updated.nextAtMs = now + dynMs
    keep.push(updated)
  }

  return { fire, mutated: changed ? keep : null }
}

/** Outcome of {@link pruneOnLoad}. */
export interface PruneOutcome {
  kept: CronEntry[]
  dropped: CronEntry[]
}

/**
 * Resume-time pruning: drop tasks that should not survive a session gap.
 *
 *   - recurring past `expiresAt` (older than 7 days)
 *   - one-shots / reminders whose `nextAtMs` already passed while the
 *     agent was gone (no catch-up — they're stale)
 *
 * Called once when the heartbeat first loads (tick 0). Returns the kept
 * set + the dropped set (for an optional log).
 *
 * @param entries - Loaded task set.
 * @param now - Load time in ms.
 */
export function pruneOnLoad(entries: CronEntry[], now: number): PruneOutcome {
  const kept: CronEntry[] = []
  const dropped: CronEntry[] = []
  for (const e of entries) {
    if (e.recurs && e.expiresAt !== undefined && now >= e.expiresAt) {
      dropped.push(e)
      continue
    }
    if (!e.recurs && e.nextAtMs !== undefined && e.nextAtMs < now) {
      dropped.push(e)
      continue
    }
    kept.push(e)
  }
  return { kept, dropped }
}

/**
 * The next fire time (ms epoch) for an entry, for status display. Returns
 * `null` when none is computable (malformed cron, or a one-shot already
 * past).
 *
 * @param entry - Task.
 * @param now - Reference time.
 */
export function nextFireMs(entry: CronEntry, now: number): number | null {
  if (isTimeBased(entry) && entry.nextAtMs !== undefined) {
    return entry.nextAtMs >= now ? entry.nextAtMs : null
  }
  try {
    const next = nextFire(parseCron(entry.cron), new Date(now))
    return next ? next.getTime() : null
  } catch {
    return null
  }
}
