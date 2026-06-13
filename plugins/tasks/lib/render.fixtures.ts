// Shared test fixtures for render.test.ts and render.durations.test.ts.
// Not a test file itself — no describe/test blocks here.

import type { Task } from "./parse.ts"
import { type RenderOptions, renderBlock } from "./render.ts"
import type { Stats, View } from "./store.ts"

/** Build a Task with sensible defaults; override any field per-test. */
export function task(over: Partial<Task> = {}): Task {
  return {
    id: "a7b3c4",
    parent: null,
    status: "todo",
    title: "Sample task",
    created_at: "2026-05-12T15:30:00-04:00",
    done_at: null,
    reason: null,
    // v2 duration fields. Default for a freshly-added todo: never started,
    // no accumulated active time. Per-test overrides exercise non-zero
    // durations (e.g. for the duration-column tests).
    started_at: null,
    last_resumed_at: null,
    active_ms: 0,
    ...over,
  }
}

/**
 * Frozen render clock for deterministic header date-suffix assertions.
 * `2026-05-20 18:07:42` is the canonical mockup time the user approved.
 * Tests that need a different moment can override `now` on the
 * RenderOptions directly.
 */
export const FIXED_NOW_MS = new Date(2026, 4, 20, 18, 7, 42).getTime()
export const FIXED_NOW_ISO_DATETIME = "2026-05-20 18:07:42"

/** Merge the frozen clock into partial RenderOptions. */
export function withFixedNow(over: Partial<RenderOptions> = {}): Partial<RenderOptions> {
  return { now: () => FIXED_NOW_MS, ...over }
}

/** A top-level View (numbered row, no parent). */
export function topView(t: Task, n: number): View {
  return { task: t, n, childIndex: null, siblingCount: null }
}

/** A subtask View (child row under a parent). */
export function subView(t: Task, childIndex: number, siblingCount: number): View {
  return { task: t, n: null, childIndex, siblingCount }
}

/** Build a Stats record with zeroed defaults. */
export function stats(over: Partial<Stats> = {}): Stats {
  return { total: 0, done: 0, doing: 0, todo: 0, canceled: 0, ...over }
}

/** Render views without ANSI, with the frozen clock, for plain-text assertions. */
export function plain(views: readonly View[], s: Stats, opts: Partial<RenderOptions> = {}): string {
  return renderBlock(views, s, {
    ansi: false,
    action: { kind: "list" },
    ...withFixedNow(opts),
  })
}
