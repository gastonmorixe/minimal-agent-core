/**
 * Resolve the default prompt for a bare `/loop`.
 *
 * Precedence (first found wins): `<cwd>/.claude/loop.md`, then
 * `~/.claude/loop.md`, then the built-in maintenance prompt. The file is
 * plain markdown, read as-is and capped at 25,000 bytes (matching the
 * scheduled-tasks contract).
 *
 * @module schedule/lib/loop-md
 */

import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const MAX_BYTES = 25_000

/** The built-in maintenance prompt used when no `loop.md` exists. */
export const BUILTIN_MAINTENANCE =
  "Work through the following, in order, and stop when nothing applies:\n" +
  "1. Continue any unfinished work from this conversation.\n" +
  "2. Tend to the current branch's pull request: address review comments, " +
  "investigate failed CI runs, and resolve merge conflicts.\n" +
  "3. If nothing above is pending, run a small cleanup pass (a bug hunt or a " +
  "simplification).\n" +
  "Do not start new initiatives outside that scope. Irreversible actions such as " +
  "pushing or deleting only proceed when they continue something this transcript " +
  "already authorized. If everything is green and quiet, say so in one line."

/** Read a loop.md file, capped at 25KB. Returns null on any read error. */
function readCapped(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    const text = readFileSync(path, "utf-8")
    const trimmed = text.slice(0, MAX_BYTES).trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

/**
 * Resolve the bare-`/loop` prompt for a working directory.
 *
 * @param cwd - The agent's current working directory.
 * @param home - Override for `~` (testing). Defaults to `os.homedir()`.
 */
export function resolveLoopPrompt(cwd: string, home: string = homedir()): string {
  return (
    readCapped(join(cwd, ".claude", "loop.md")) ??
    readCapped(join(home, ".claude", "loop.md")) ??
    BUILTIN_MAINTENANCE
  )
}
