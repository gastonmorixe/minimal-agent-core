/**
 * Semantic turn-notice values for out-of-band conditions the agent loop
 * needs to surface to the user (provider refusals, output-budget events,
 * reflection-ack confirmations).
 *
 * The agent core does NOT render these. It constructs a {@link TurnNotice}
 * (pure data, no ANSI) and hands it to the host through the `onNotice`
 * hook on `Agent.run` opts. The host owns presentation: the TUI paints a
 * red banner for a refusal, a yellow `!` for a budget warning, a dim `›`
 * for a reflection ack. Headless callers get a style-free one-liner
 * fallback through `onTranscriptLine` so the signal is never dropped.
 *
 * This replaces the earlier single-purpose `stop-notice.ts`: refusals are
 * now one `kind` among several, so every ANSI `writeTranscript` call that
 * used to live in the core loop routes through one seam.
 *
 * Design notes (see software-best-design-patterns skill):
 *   - Functional core, imperative shell: `detectStopNotice` is a pure
 *     projection; every other notice is a plain value literal built at
 *     its site. No I/O, no styling.
 *   - Discriminated union: `kind` is a literal tag; a host renderer
 *     narrows exhaustively with `switch (n.kind)` and a `never` default,
 *     so a newly-added kind is a compile error until it is handled.
 *   - DIP: the core depends on the hook signature, never on the
 *     compositor or the ANSI palette.
 *
 * @module agent/turn-notice
 */

/** Stop reasons that indicate the provider terminated the turn abnormally. */
const STOP_NOTICE_KINDS = ["refusal", "content_filter"] as const

/** The kind of abnormal provider termination. */
export type StopNoticeKind = (typeof STOP_NOTICE_KINDS)[number]

/**
 * Presentational severity, chosen by the core so the host can map it to a
 * treatment (color / glyph) without re-deriving intent from `kind`.
 *   - `error`: the turn was killed against the user's intent (refusal).
 *   - `warn`:  a budget ceiling was hit; the run adapted or stopped.
 *   - `info`:  a benign confirmation (reflection ack).
 */
export type NoticeSeverity = "error" | "warn" | "info"

/** Provider safety layer ended the turn (refusal / content filter). */
export interface StopNotice {
  kind: StopNoticeKind
  severity: "error"
  /**
   * Provider-reported category (`stopDetails.type`) when it adds
   * information beyond {@link kind}; `null` when absent or merely
   * repeating the stop reason.
   */
  category: string | null
  /** Provider-reported human-readable explanation, when present. */
  message: string | null
}

/** A response hit the output-token ceiling mid tool-call; the in-flight call was salvaged. */
export interface MaxTokensSalvagedNotice {
  kind: "max_tokens_salvaged"
  severity: "warn"
}

/** A truncated response is being auto-continued (attempt N of cap). */
export interface MaxTokensContinuingNotice {
  kind: "max_tokens_continuing"
  severity: "warn"
  attempt: number
  cap: number
}

/** The auto-continue streak cap was hit; the run stopped rather than loop. */
export interface MaxTokensCappedNotice {
  kind: "max_tokens_capped"
  severity: "warn"
  cap: number
}

/** The emergency tool-rounds cap was reached; a tools-disabled wrap-up follows. */
export interface ToolRoundsCappedNotice {
  kind: "tool_rounds_capped"
  severity: "warn"
  cap: number
}

/** The model opted out of the next K reflection checkpoints. */
export interface ReflectionAckNotice {
  kind: "reflection_ack"
  severity: "info"
  silenceFor: number
  reason: string
  /** True when the ack arrived via the tool_use fallback rather than the text scan. */
  fromToolFallback: boolean
}

/**
 * The discriminated union of every out-of-band condition the agent loop
 * surfaces. Narrow on `kind`.
 */
export type TurnNotice =
  | StopNotice
  | MaxTokensSalvagedNotice
  | MaxTokensContinuingNotice
  | MaxTokensCappedNotice
  | ToolRoundsCappedNotice
  | ReflectionAckNotice

/**
 * Project a turn's stop reason + details into a {@link StopNotice}, or
 * `null` for every normal termination (end_turn / tool_use / max_tokens /
 * pause_turn / ...). Pure function; safe to call every turn. (`max_tokens`
 * is handled by the loop's continuation machinery, not here.)
 */
export function detectStopNotice(
  stopReason: string | null,
  stopDetails?: { type: string; message?: string } | null,
): StopNotice | null {
  if (!STOP_NOTICE_KINDS.includes(stopReason as StopNoticeKind)) return null
  const kind = stopReason as StopNoticeKind
  const category = stopDetails?.type && stopDetails.type !== kind ? stopDetails.type : null
  return { kind, severity: "error", category, message: stopDetails?.message ?? null }
}

/**
 * Style-free one-line rendering used as the core's fallback when the host
 * did not supply an `onNotice` hook (headless scripts, tests). Hosts with
 * a real display should ignore this and render their own treatment. The
 * exhaustive `switch` makes a new {@link TurnNotice} kind a compile error
 * until it is given a plain rendering here too.
 */
export function formatTurnNoticePlain(notice: TurnNotice): string {
  switch (notice.kind) {
    case "refusal":
    case "content_filter": {
      const label = notice.kind === "refusal" ? "refusal" : "content filter"
      const category = notice.category ? ` (${notice.category})` : ""
      const message = notice.message ? ` — ${notice.message}` : ""
      return `[${label}] The provider's safety layer ended the response${category}${message}. The reply above (if any) is incomplete; rephrasing the request usually gets past a false positive.`
    }
    case "max_tokens_salvaged":
      return "[max_tokens] Response hit the max_tokens ceiling mid tool-call; salvaged the in-flight call and continuing."
    case "max_tokens_continuing":
      return `[max_tokens] Response hit the max_tokens ceiling; auto-continuing (${notice.attempt}/${notice.cap}).`
    case "max_tokens_capped":
      return `[max_tokens] Response hit the max_tokens ceiling ${notice.cap} times in a row; stopping. Consider narrowing the request or raising max_tokens.`
    case "tool_rounds_capped":
      return `[tool cap] Emergency cap reached (${notice.cap} tool rounds); sending final tools-disabled wrap-up.`
    case "reflection_ack": {
      const suffix = notice.reason.length > 0 ? ` — ${notice.reason}` : ""
      const via = notice.fromToolFallback ? " (from tool_use fallback)" : ""
      return `reflection ack: silencing next ${notice.silenceFor} checkpoint${notice.silenceFor === 1 ? "" : "s"}${suffix}${via}`
    }
    default: {
      const _exhaustive: never = notice
      return _exhaustive
    }
  }
}
