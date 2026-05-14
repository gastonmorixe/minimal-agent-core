/**
 * Tool-header time hint.
 *
 * Renders a small "when did this fire" suffix that the agent appends to
 * the `╭ <icon> <label>  <content>` tool header. The format is one of:
 *
 *   - `HH:MM:SS`           when the day matches the previous tool's day
 *   - `Mon DD HH:MM:SS`    on the first tool of a session OR after the
 *                          calendar day rolls over (English short month,
 *                          no year — the year is overkill for a session
 *                          that lasts hours, and `--resume` only reaches
 *                          back days at most in practice)
 *
 * Day-tracking is stateful: the caller threads a `ToolTimeTracker`
 * through every tool render so the date prefix only re-emits when it
 * actually changes. The tracker is shared between session-replay and
 * the live REPL so a replayed session that ends on May 14 followed by
 * a live tool on May 15 cleanly shows the rollover prefix on the first
 * live header.
 *
 * Pure module — no I/O, no terminal coupling. The agent decides on
 * dimming + the leading `· ` separator at the call site.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function formatHMS(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

function formatMonthDay(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

/**
 * Result of {@link fmtToolTime}.
 */
export interface ToolTimeFmt {
  /**
   * The user-visible suffix body (no leading `· `, no ANSI codes). The
   * agent wraps with its own dim color and `· ` separator.
   */
  text: string
  /**
   * Resolved day key (e.g. `"Thu May 14 2026"`). The caller uses this
   * as the next call's `lastShownDay` so the date prefix only repaints
   * on actual day rollover. Includes the year, so a session running
   * across years still re-emits the prefix on Jan 1 even though the
   * year is not displayed inline.
   */
  day: string
}

/**
 * Format a tool-execution timestamp for inline display in a tool header.
 *
 * @param epochMs - The tool's execution moment, in epoch ms.
 * @param lastShownDay - The previous tool's resolved {@link ToolTimeFmt.day},
 *   or `null` when no prior tool has been rendered. `null` forces the date
 *   prefix on the first call (cold-start).
 */
export function fmtToolTime(epochMs: number, lastShownDay: string | null): ToolTimeFmt {
  const d = new Date(epochMs)
  // `Date.toDateString()` returns e.g. "Thu May 14 2026" — stable
  // across locales (always English) and includes the year, so the
  // date prefix correctly re-emits on Jan 1 of the next year even
  // though the year is not displayed inline.
  const day = d.toDateString()
  const time = formatHMS(d)
  if (day === lastShownDay) return { text: time, day }
  return { text: `${formatMonthDay(d)} ${time}`, day }
}

/**
 * Stateful wrapper around {@link fmtToolTime}. Shared between
 * session-replay and the live REPL so day-rollover behaves correctly
 * across both. Construct one per Agent / session-replay invocation.
 */
export class ToolTimeTracker {
  private lastShownDay: string | null = null

  /**
   * Format `epochMs` and advance internal day state.
   */
  format(epochMs: number): string {
    const fmt = fmtToolTime(epochMs, this.lastShownDay)
    this.lastShownDay = fmt.day
    return fmt.text
  }

  /**
   * Reset to cold-start. The next {@link format} call will include the
   * date prefix even if it matches the previously-tracked day. Mostly
   * useful in tests.
   */
  reset(): void {
    this.lastShownDay = null
  }
}
