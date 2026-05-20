/**
 * Pure builder for the one-time "status ready" hint banner that appears
 * above the REPL prompt at session start.
 *
 * Lifted out of `src/agent.ts` so the banner can be written ONCE from
 * `src/index.ts`, BEFORE any resume replay. Previously the banner was
 * emitted from inside `runRepl` / `runReplLiveArea`, which on resume
 * placed it BELOW the replayed content (visible jump: header → replay
 * → hint, instead of header → hint → replay).
 *
 * The trailing `\n\n` (NOT `\n`) is load-bearing: it provides the one
 * blank row of breathing room between the hint row and whatever comes
 * next (resume separator, prompt, etc.). The compositor's
 * `capBlankLines` caps consecutive `\n` runs in scrollback at 2, so a
 * single blank row is the max we'll ever see even if downstream code
 * adds more.
 *
 * @module ready-banner
 */
import { c } from "./agent.ts"
import type { ModeManager } from "./modes.ts"

/**
 * Build the dim/colored banner string. Pure : no I/O, no side effects.
 *
 * @param modeManager When non-null AND `hasModes()` is true, appends a
 *   `· shift+tab cycle mode` tail to the hint row.
 * @returns ANSI-tagged banner: `\n  status ready\n  <hints>\n\n`.
 */
export function buildReadyBanner(modeManager: ModeManager | null): string {
  const dot = c.faintWhite("·")
  const baseHint =
    `${c.faintWhite("enter")} ${c.bold("send")}  ${dot}  ` +
    `${c.faintWhite("shift+enter")} ${c.bold("new line")}  ${dot}  ` +
    `${c.faintWhite("ctrl+c")} ${c.bold("quit")}`
  const modeHint =
    modeManager && modeManager.hasModes()
      ? `  ${dot}  ${c.faintWhite("shift+tab")} ${c.bold("cycle mode")}`
      : ""
  return `\n  ${c.bold(c.purple("status"))} ${c.faintWhite("ready")}\n  ${baseHint}${modeHint}\n\n`
}
