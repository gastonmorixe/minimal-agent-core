/**
 * Integration test for one scheduler tick driven by a fake clock + a
 * real (temp-dir) store + a capturing emit. Asserts exactly-once firing
 * per due minute, one-shot fire+delete, and resume pruning.
 *
 * @module schedule/lib/tick.test
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { CronStore } from "./store.ts"
import { runTick } from "./tick.ts"

let dir: string
const SID = "tick-session"

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ma-tick-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function ms(y: number, mo: number, d: number, h: number, mi: number, s = 0): number {
  return new Date(y, mo - 1, d, h, mi, s, 0).getTime()
}

function store(): CronStore {
  let seed = 0x51ed
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  return new CronStore(SID, { dir, rand })
}

/** Collect emits from a tick. */
function capture() {
  const events: Array<{ channel: string; payload: unknown }> = []
  return { emit: (channel: string, payload: unknown) => events.push({ channel, payload }), events }
}

describe("runTick — fixed recurring", () => {
  it("fires exactly once per matching minute (dedupes within the minute)", () => {
    const s = store()
    // Create close to the test clock so the 7-day expiry is in the future.
    const created = s.create(
      { cron: "*/5 * * * *", prompt: "check deploy", recurs: true },
      ms(2026, 5, 30, 9, 0, 0),
    )
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const id = created.value.id

    // Matching minute 10:00, second 45 (> max jitter 29) → fires.
    const c1 = capture()
    runTick({ store: s, emit: c1.emit, now: ms(2026, 5, 30, 10, 0, 45), firstTick: false })
    expect(c1.events).toHaveLength(1)
    expect(c1.events[0]).toEqual({
      channel: "prompt.inject",
      payload: { text: "check deploy", source: `cron:${id}` },
    })

    // Same minute, later second → no re-fire.
    const c2 = capture()
    runTick({ store: s, emit: c2.emit, now: ms(2026, 5, 30, 10, 0, 55), firstTick: false })
    expect(c2.events).toHaveLength(0)

    // Non-matching minute → no fire.
    const c3 = capture()
    runTick({ store: s, emit: c3.emit, now: ms(2026, 5, 30, 10, 3, 45), firstTick: false })
    expect(c3.events).toHaveLength(0)

    // Next matching minute 10:05 → fires again.
    const c4 = capture()
    runTick({ store: s, emit: c4.emit, now: ms(2026, 5, 30, 10, 5, 45), firstTick: false })
    expect(c4.events).toHaveLength(1)
  })
})

describe("runTick — one-shot", () => {
  it("fires once when due, then deletes itself", () => {
    const s = store()
    const target = ms(2026, 5, 30, 15, 0, 0)
    const created = s.create(
      { cron: "0 15 * * *", prompt: "push the release", recurs: false, nextAtMs: target },
      ms(2026, 5, 30, 9, 0, 0),
    )
    expect(created.ok).toBe(true)

    // Before target → nothing.
    const before = capture()
    runTick({ store: s, emit: before.emit, now: target - 1000, firstTick: false })
    expect(before.events).toHaveLength(0)
    expect(s.count()).toBe(1)

    // At/after target → fire once + delete.
    const at = capture()
    const status = runTick({ store: s, emit: at.emit, now: target + 500, firstTick: false })
    expect(at.events).toHaveLength(1)
    expect(s.count()).toBe(0)
    expect(status).toBeNull() // no tasks left
  })
})

describe("runTick — resume prune (first tick)", () => {
  it("drops expired recurring + missed one-shots without firing them", () => {
    const s = store()
    const now = ms(2026, 5, 30, 12, 0, 0)
    // Expired recurring (created 8 days ago).
    s.create({ cron: "* * * * *", prompt: "stale", recurs: true }, now - 8 * 24 * 3600_000)
    // Missed one-shot (target in the past).
    s.create(
      { cron: "0 0 * * *", prompt: "missed", recurs: false, nextAtMs: now - 3600_000 },
      now - 7200_000,
    )
    // A live recurring.
    s.create({ cron: "*/5 * * * *", prompt: "live", recurs: true }, now)
    expect(s.count()).toBe(3)

    const cap = capture()
    runTick({ store: s, emit: cap.emit, now, firstTick: true })

    // Nothing fired from the pruned items.
    expect(cap.events).toHaveLength(0)
    // Only the live recurring survives.
    const left = s.load()
    expect(left.map((e) => e.prompt)).toEqual(["live"])
  })
})
