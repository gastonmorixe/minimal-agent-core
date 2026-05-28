/**
 * Per-cwd recall singleton.
 *
 * The two handler modules (`on_key.ts`, `on_submit.ts`) need to share
 * the same {@link Recall} instance — `on_submit` pushes new entries
 * into it, `on_key` walks it. Module-level state in either handler
 * isn't enough because each module's top-level code runs in isolation.
 *
 * This module is the rendezvous point. A single `Map<cwd, Recall>`
 * holds one recall per project working directory; both handlers import
 * `recallFor(cwd)` and get the same instance.
 *
 * Lazy: the first call for a given cwd reads the project's history
 * file from disk (synchronously, ~ms even on a saturated 10 MB cap)
 * and builds the recall. Subsequent calls return the cached instance.
 *
 * @module plugins/history/lib/session
 */

import { createRecall, type Recall } from "./recall.ts"
import { loadEntries, projectHistoryPath } from "./store.ts"

const cache = new Map<string, Recall>()

/**
 * Return the recall for `cwd`, building it from disk on first access.
 *
 * Returns the SAME instance on every call for the same cwd — the
 * recall is the source of truth for ↑/↓ navigation state (cursor,
 * draft snapshot, EDITED flag).
 */
export function recallFor(cwd: string): Recall {
  let r = cache.get(cwd)
  if (r) return r
  const entries = loadEntries(projectHistoryPath(cwd))
  r = createRecall(entries)
  cache.set(cwd, r)
  return r
}

/**
 * Test helper: forget the cached recall for `cwd` (or all cwds when
 * omitted). Forces the next `recallFor(cwd)` to re-read disk.
 *
 * Production code never calls this — the cache is intended to live
 * for the duration of the agent process.
 *
 * @internal
 */
export function _resetSessionCache(cwd?: string): void {
  if (cwd === undefined) {
    cache.clear()
  } else {
    cache.delete(cwd)
  }
}
