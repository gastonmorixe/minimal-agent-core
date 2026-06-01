/**
 * One scheduler tick, parameterized over its IO so it's directly testable
 * with a fake clock + in-memory store + capturing emit. The heartbeat slot
 * is a one-line wrapper that supplies `Date.now()` and `ctx.emit`.
 *
 * @module schedule/lib/tick
 */

import { formatStatusRow } from "./footer.ts"
import { due, jitterSecondsFor, pruneOnLoad } from "./scheduler.ts"
import type { CronEntry } from "./store.ts"

/** The slice of {@link CronStore} a tick needs (structural, for fakes). */
export interface TickStore {
  load(): CronEntry[]
  replaceAll(entries: CronEntry[]): void
}

/** Inputs to {@link runTick}. */
export interface TickDeps {
  store: TickStore
  /** Fire-and-forget bus emit (the host's prompt-inject port). */
  emit: (channel: string, payload: unknown) => void
  /** Wall clock in ms. */
  now: number
  /** True on the slot's first invocation (resume prune happens once). */
  firstTick: boolean
}

/**
 * Run one tick: prune (first tick only), fire due tasks via `emit`,
 * persist the mutated set, and return the footer status row.
 *
 * @returns The status row string, or `null` when there are no tasks.
 */
export function runTick(deps: TickDeps): string | null {
  const { store, emit, now, firstTick } = deps
  let entries = store.load()

  if (firstTick) {
    const { kept, dropped } = pruneOnLoad(entries, now)
    if (dropped.length > 0) {
      store.replaceAll(kept)
      entries = kept
    }
  }

  const { fire, mutated } = due(entries, now, { jitterSeconds: jitterSecondsFor })
  for (const e of fire) {
    emit("prompt.inject", { text: e.prompt, source: `cron:${e.id}` })
  }
  if (mutated !== null) {
    store.replaceAll(mutated)
    entries = mutated
  }

  return formatStatusRow(entries, now)
}
