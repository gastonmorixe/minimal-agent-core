/**
 * Walk a directory tree for `Glob`, bounded in time and resilient to
 * unreadable directories.
 *
 * `Bun.Glob.scan` is the obvious implementation and the wrong one for a tool
 * that runs inside a live TUI, for two reasons verified against Bun 1.4.4:
 *
 * 1. **One unreadable directory discards the whole result.** A `scan` that
 *    meets an `EPERM` throws out of the `for await`, so a tree of thousands of
 *    directories returns zero matches because one of them was protected. This
 *    is not hypothetical: `**\/agents_rules.py` from `~/` failed with
 *    `Glob error: EPERM: operation not permitted, open 'Downloads'`, and the
 *    caller learned nothing about the rest of the tree. Walking one directory
 *    at a time lets the walk skip it and say so.
 * 2. **It cannot be interrupted on a deadline.** There is no per-entry hook to
 *    check a clock, so a recursive pattern over a large tree runs to
 *    completion. The same call from `~/Projects` took ~40 s across 382k
 *    directories, which is indistinguishable from a hang to the caller.
 *
 * Match semantics still come from `Bun.Glob.match` on the `cwd`-relative path,
 * so results stay identical to `scan` for the same tree. `glob-walk.test.ts`
 * asserts that parity against `scan` so a future Bun change surfaces as a
 * failing test instead of a silent difference.
 *
 * @module tools/glob-walk
 */

import type { Dirent } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"

import { childEnv } from "@minimal-agent/core/plugin-api/utils/self-spawn"

/** Maximum entries `Glob` returns; a bigger match set is truncated. */
export const GLOB_MAX_ENTRIES = 100

/**
 * Default wall-clock budget for one walk, in milliseconds.
 *
 * Sized to be longer than an ordinary search and short enough that a runaway
 * one does not read as a hang. Grep caps itself at `GREP_TIMEOUT_MS`
 * (30 s) for a comparable reason.
 */
export const GLOB_TIMEOUT_MS = 10_000

/** Wall-clock budget actually used by {@link walkGlobMatches}. */
let globTimeoutMs = GLOB_TIMEOUT_MS

/**
 * Test-only: replace the walk deadline. Pass nothing to restore
 * {@link GLOB_TIMEOUT_MS}. Keeps timeout tests fast instead of waiting ten
 * real seconds for the deadline to fire.
 *
 * @param ms - Budget in milliseconds, or undefined to restore the default.
 */
export function _setGlobTimeoutMsForTests(ms?: number): void {
  globTimeoutMs = ms ?? GLOB_TIMEOUT_MS
}

/**
 * Directory names the walk never descends into.
 *
 * A `**` pattern under a developer tree is dominated by dependency and VCS
 * metadata: `~/Projects` holds 594 `node_modules` trees, and 191k of its 382k
 * directories are reachable only through them, so pruning them halves the
 * walk. `Bun.Glob`'s `ignore` option is a no-op in Bun 1.4.4 (verified), which
 * is why this lives in the walk rather than in a scan option.
 *
 * Disable with `GLOB_PRUNE=false` in the environment.
 */
const GLOB_PRUNED_DIRS = ["node_modules", ".git"]

/**
 * Whether the walk skips {@link GLOB_PRUNED_DIRS}.
 *
 * @returns True unless `GLOB_PRUNE` is exactly `"false"`.
 */
function globPruningEnabled(): boolean {
  return childEnv().GLOB_PRUNE !== "false"
}

/** Outcome of one walk: matches plus why the walk may be incomplete. */
export interface GlobWalkResult {
  /** Matches relative to the search root, unsorted, capped at {@link GLOB_MAX_ENTRIES}. */
  entries: string[]
  /** Directories that could not be read and were skipped. */
  skippedDirs: number
  /** Whether the deadline stopped the walk before the tree was exhausted. */
  timedOut: boolean
  /** Whether the caller's abort signal stopped the walk. */
  aborted: boolean
}

/**
 * Collect glob matches by walking `cwd` one directory at a time.
 *
 * The walk is breadth-depth agnostic (an explicit stack, so a deep tree cannot
 * overflow the JS stack) and yields to the event loop at every directory:
 * `readdir` is async on purpose, because a synchronous walk would freeze the
 * TUI for the whole traversal.
 *
 * The signal and the deadline are both checked between directories, so an
 * abort or timeout takes effect promptly even deep into a large tree.
 *
 * @param pattern - Glob pattern, matched against `cwd`-relative paths.
 * @param cwd - Directory to start from.
 * @param signal - Abort signal; checked between directories.
 * @returns Matches plus how many directories were unreadable and whether the
 *   deadline fired. Never throws for an unreadable directory.
 */
export async function walkGlobMatches(
  pattern: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<GlobWalkResult> {
  const glob = new Bun.Glob(pattern)
  const entries: string[] = []
  const deadline = Date.now() + globTimeoutMs
  const prune = globPruningEnabled()
  const pending: string[] = [""]
  let skippedDirs = 0

  while (pending.length > 0) {
    if (signal?.aborted) return { entries, skippedDirs, timedOut: false, aborted: true }
    // `>=` not `>`: a zero budget must fire on this very check, and a walk
    // landing exactly on the deadline is out of time either way.
    if (Date.now() >= deadline) return { entries, skippedDirs, timedOut: true, aborted: false }
    const relDir = pending.pop() as string

    let dirents: Dirent[]
    try {
      dirents = await readdir(relDir === "" ? cwd : join(cwd, relDir), { withFileTypes: true })
    } catch {
      // Unreadable directory (EPERM under a privacy-protected path, EACCES, or
      // a path that vanished mid-walk). Skip it and keep the matches found so
      // far instead of failing the entire call.
      skippedDirs++
      continue
    }

    for (const dirent of dirents) {
      const name = dirent.name
      // `dot:false` parity: skip leading-dot entries, and never descend into them.
      if (name.startsWith(".")) continue
      const relPath = relDir === "" ? name : `${relDir}/${name}`
      const isDir = dirent.isDirectory()

      if (prune && isDir && GLOB_PRUNED_DIRS.includes(name)) continue
      if (glob.match(relPath)) {
        entries.push(relPath)
        if (entries.length >= GLOB_MAX_ENTRIES) {
          return { entries, skippedDirs, timedOut: false, aborted: false }
        }
      }
      if (isDir) pending.push(relPath)
    }
  }

  return { entries, skippedDirs, timedOut: false, aborted: false }
}
