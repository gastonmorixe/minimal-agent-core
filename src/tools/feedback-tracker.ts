/**
 * Streak / pattern soft-warnings — "Layer 3" of the size-feedback design.
 *
 * Companion to the static prompt improvements (Layer 1, in tool descriptions)
 * and the in-band `[truncated: ...]` notice (Layer 2, in
 * {@link import("./truncation.ts").truncateToolOutput}). This layer is the
 * dynamic / reactive nudge: when the agent observes a *pattern* across
 * multiple tool calls — e.g. **3 consecutive truncations of the same tool**
 * — it appends a single-line meta-note to the next `tool_result.content`
 * so the model can correct course.
 *
 * Design choices:
 *
 *  - **State lives per-Agent, not per-tool.** Tracker is a small object the
 *    `Agent` instance owns and consults at every `executeTool` site. Tools
 *    themselves stay stateless (`executeTool(name, input, opts)` is per-call
 *    by design — see `src/tools.ts`).
 *
 *  - **Notes ride in `tool_result.content`, not in a side channel.** The
 *    model reads `content` as part of its next request — adding a one-line
 *    `[note: ...]` at the end is the smallest possible delivery mechanism.
 *    No new message types, no hooks, no bus.
 *
 *  - **Never user-visible.** The TUI's `formatToolPreview` strips trailing
 *    `[truncated: ...]` notices already; the same stripping applies to the
 *    `[note: ...]` line we add here, since both share the audience-split
 *    rule (model-facing strings stay model-facing).
 *
 *  - **Reset on success.** A non-truncated call breaks the streak — we don't
 *    nag if the model just had a bad turn. Threshold-and-reset semantics
 *    are the simplest signal for "you're stuck in a loop" without
 *    drowning the model in repeated warnings.
 *
 *  - **One note per fire.** Once a streak triggers, we emit the note and
 *    reset the counter to zero. The model gets one nudge, not three.
 *
 *  - **Per-tool counters.** `Read` truncating doesn't reset the `Bash`
 *    streak — they're independent failure modes.
 *
 * Future directions (not implemented yet, kept here as a roadmap):
 *  - Cross-tool patterns (e.g. "5 Bash calls in a row that could have been
 *    Read+Grep").
 *  - Configurable thresholds via `~/.minimal-agent/config.jsonc`.
 *  - Custom note text per tool (Read paging vs. Grep narrowing).
 */

/**
 * Default streak threshold: number of consecutive truncations on the same
 * tool before the tracker emits a soft note. Three is empirically the
 * sweet spot — one truncation can be a fluke, two could be follow-up
 * reads, three is "you're not noticing the pattern".
 */
export const DEFAULT_STREAK_THRESHOLD = 3

/**
 * Per-tool note text. Kept terse — the `[truncated: ...]` notice already
 * carried the verb-form action hint; the streak note is a meta-observation
 * about the *pattern*, not the individual call.
 */
const STREAK_NOTES: Record<string, string> = {
  Read:
    "you've truncated 3 Read calls in a row. Use the totals from the last " +
    "[truncated: ...] notice to compute a single offset+limit that lands " +
    "where you actually need to read, instead of paging from byte 0.",
  Grep:
    'you\'ve truncated 3 Grep calls in a row. Try `output_mode: "files_with_matches"` ' +
    "(densest), tighten the pattern, add a `glob`/`path` filter, or set " +
    "`head_limit` explicitly rather than letting the cap fire.",
  Bash:
    "you've truncated 3 Bash calls in a row. Bound output at the source: " +
    "`head -c`, `head -n`, `tail`, `sed -n '1,Np'`, or pipe through a " +
    "filter. The post-hoc cap is lossy — pre-bounding gives usable signal.",
  Glob:
    "you've truncated 3 Glob calls in a row. Narrow the pattern (e.g. add a " +
    "subdirectory prefix or restrict the file extension) instead of " +
    "matching the world.",
}
const STREAK_NOTE_DEFAULT =
  "you've truncated 3 calls of this tool in a row. Re-think the parameters; " +
  "see the [truncated: ...] notice on each prior call for resume hints."

/**
 * Stateful tracker for tool-level streak patterns. One instance per
 * {@link import("../agent.ts").Agent}; consulted on every tool dispatch.
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
      // return — no note.
      this.streaks.delete(tool)
      return null
    }
    const next = (this.streaks.get(tool) ?? 0) + 1
    if (next >= this.threshold) {
      // Threshold fired: emit the note, reset the counter so we don't
      // nag the model on every subsequent call. If they keep truncating
      // they'll hit threshold again — but with `threshold` more calls
      // between nudges, not every call.
      this.streaks.delete(tool)
      const body = STREAK_NOTES[tool] ?? STREAK_NOTE_DEFAULT
      return `[note: ${body}]`
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
