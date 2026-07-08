/**
 * Streak / pattern soft-warnings, "Layer 3" of the size-feedback design.
 *
 * Companion to the static prompt improvements (Layer 1, in tool descriptions)
 * and the in-band `[truncated: ...]` notice (Layer 2, in
 * `truncateToolOutput` (in `./truncation.ts`)). This layer is the
 * dynamic / reactive nudge: when the agent observes a pattern across
 * multiple tool calls, such as 3 consecutive truncations of the same tool,
 * it appends a single-line meta-note to the next `tool_result.content`
 * so the model can correct course.
 *
 * Design choices:
 *
 *  - State lives per-Agent, not per-tool. Tracker is a small object the
 *    `Agent` instance owns and consults at every `executeTool` site. Tools
 *    themselves stay stateless (`executeTool(name, input, opts)` is per-call
 *    by design, see `src/tools.ts`).
 *
 *  - Notes ride in `tool_result.content`, not in a side channel. The
 *    model reads `content` as part of its next request. Adding a one-line
 *    `[note: ...]` at the end is the smallest possible delivery mechanism.
 *    No new message types, no hooks, no bus.
 *
 *  - Never user-visible. The TUI's `formatToolPreview` strips trailing
 *    `[truncated: ...]` notices already. The same stripping applies to the
 *    `[note: ...]` line we add here, since both share the audience-split
 *    rule (model-facing strings stay model-facing).
 *
 *  - Reset on success. A non-truncated call breaks the streak. We don't
 *    nag if the model just had a bad turn. Threshold-and-reset semantics
 *    are the simplest signal for "you're stuck in a loop" without
 *    drowning the model in repeated warnings.
 *
 *  - One note per fire. Once a streak triggers, we emit the note and
 *    reset the counter to zero. The model gets one nudge, not three.
 *
 *  - Per-tool counters. `Read` truncating doesn't reset the `Bash`
 *    streak. They're independent failure modes.
 *
 * Future directions (not implemented yet, kept here as a roadmap):
 *  - Cross-tool patterns (e.g. "5 Bash calls in a row that could have been
 *    Read+Grep").
 *  - Configurable thresholds via `~/.minimal-agent/config.jsonc`.
 *  - Custom note text per tool (Read paging vs. Grep narrowing).
 */

import { streakNote } from "./PROMPTS.ts"

/**
 * Default streak threshold: number of consecutive truncations on the same
 * tool before the tracker emits a soft note. Three is empirically the
 * sweet spot: one truncation can be a fluke, two could be follow-up
 * reads, three is "you're not noticing the pattern".
 */
export const DEFAULT_STREAK_THRESHOLD = 3

/**
 * Stateful tracker for tool-level streak patterns. One instance per
 * `Agent` (in `../agent.ts`); consulted on every tool dispatch.
 *
 * Usage from `agent.ts`:
 *
 * ```ts
 * const tracker = new ToolFeedbackTracker()
 * // ... per tool call:
 * const note = tracker.observe(name, !!result._truncInfo?.truncated)
 * if (note) result.content += `\n\n${note}`
 * ```
 *
 * The tracker mutates only its own internal state; callers do all the
 * appending. Pure data-in / string-out at the API boundary so it's
 * trivial to test.
 */
export class ToolFeedbackTracker {
  private streaks = new Map<string, number>()
  private readonly threshold: number

  constructor(threshold: number = DEFAULT_STREAK_THRESHOLD) {
    this.threshold = threshold
  }

  /**
   * Record an observation for a single tool call.
   *
   * @param tool - Tool name (e.g. "Read", "Bash")
   * @param truncated - Whether the call's output was clamped by the
   *   universal truncator (i.e. `_truncInfo.truncated === true`).
   * @returns A `[note: ...]` string when the streak threshold just fired,
   *   `null` otherwise. The string is meant to be appended verbatim to
   *   the model-facing `tool_result.content` (with a `\n\n` separator).
   *   The tracker resets the per-tool counter when it fires, so the model
   *   gets exactly one nudge per streak.
   */
  observe(tool: string, truncated: boolean): string | null {
    if (!truncated) {
      // A successful (non-truncated) call breaks the streak. Reset and
      // return: no note.
      this.streaks.delete(tool)
      return null
    }
    const next = (this.streaks.get(tool) ?? 0) + 1
    if (next >= this.threshold) {
      // Threshold fired: emit the note, reset the counter so we don't
      // nag the model on every subsequent call. If they keep truncating
      // they'll hit threshold again, but with `threshold` more calls
      // between nudges, not every call.
      this.streaks.delete(tool)
      return streakNote(tool, this.threshold)
    }
    this.streaks.set(tool, next)
    return null
  }

  /**
   * Current streak length for a tool. Mainly for tests and diagnostics.
   * Returns 0 when the tool has never truncated or was just reset.
   */
  streakOf(tool: string): number {
    return this.streaks.get(tool) ?? 0
  }

  /** Reset all per-tool counters. Useful between sessions / on resume. */
  reset(): void {
    this.streaks.clear()
  }
}
