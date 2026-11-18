/**
 * Semantic turn-notice values for out-of-band conditions the agent loop
 * needs to surface to the user (provider refusals, output-budget events,
 * reflection-ack confirmations).
 *
 * The agent core does NOT render these. It constructs a {@link TurnNotice}
 * (pure data, no ANSI) and emits it as a `notice` event. The host owns
 * presentation: the TUI paints a red banner for a refusal, a yellow `!` for
 * a budget warning, a dim `›` for a reflection ack. The CLI owns the plain
 * text (`startup/turn-notice-text.ts`).
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
 * Provider closed the SSE stream without a terminal event after one or more
 * complete tool calls. Closed tools were salvaged; partial calls discarded.
 * The loop continues from local transcript state (never replays the old body).
 */
export interface StreamInterruptedSalvagedNotice {
  kind: "stream_interrupted_salvaged"
  severity: "warn"
  /** How many complete tool calls were preserved. */
  completedToolCalls: number
}

/**
 * Provider closed mid-text (no complete tools). Partial assistant output was
 * preserved; the loop issues a bounded local continuation with a new body.
 */
export interface StreamInterruptedContinuingNotice {
  kind: "stream_interrupted_continuing"
  severity: "warn"
  attempt: number
  cap: number
}

/** Bounded local continuations for terminal-less mid-text exhausted. */
export interface StreamInterruptedCappedNotice {
  kind: "stream_interrupted_capped"
  severity: "warn"
  cap: number
}

/**
 * The loop needed an answer from the user, and the host gave it no
 * `askUser` port (a headless run). The ask was denied, and the request went
 * out unchanged.
 */
export interface AskDeniedNotice {
  kind: "ask_denied"
  severity: "warn"
  /** Machine code of the ask (for example a preflight issue code). */
  code: string
  /** Title of the ask. */
  title: string
}

/**
 * The core adopted a different model on its own, through the preflight
 * `adoptModelId` path (a provider issue resolution, not a user-requested
 * `setModel`). Emitted every time `to !== from`, so a client watching the
 * notice stream never keeps a stale model value. A host-mode plugin can
 * turn this notice into a model-change push in its own protocol.
 * `effortReset` is `true` when the new model does not support the
 * prior effort level, which the core already reset to the model default
 * (`undefined`) in the same step that adopted the model; `effortFrom` is
 * that prior level, or `null` when no reset happened.
 */
export interface ModelAdoptedNotice {
  kind: "model_adopted"
  severity: "info"
  from: string
  to: string
  effortReset: boolean
  effortFrom: string | null
  /**
   * The full target before the change. Set, together with `toTarget`, when
   * a target switch made the notice (`AgentCore.switchTarget`): then the
   * credential or the provider can change with the same model, and `from`
   * and `to` alone say nothing. A host reads the two targets to name each
   * value that changed. Absent for an automatic model adoption, which
   * changes only the model and its effort.
   */
  fromTarget?: NoticeTarget
  /** The full target after the change. See `fromTarget`. */
  toTarget?: NoticeTarget
}

/**
 * One target in a notice: the credential, the provider, the model and the
 * effort. An absent `effort` is the model default. Data only, no label.
 */
export interface NoticeTarget {
  credentialName?: string
  providerId?: string
  model: string
  effort?: string
}

/**
 * The preflight `adoptModelId` path named a model id the registry does not
 * know for the session's provider, even after the provider plugin had a
 * chance to register it ad hoc (`ProviderPlugin.registerAdHocModel`). The
 * core kept the current model and effort, and the turn went on. `model` is
 * the model the core kept. `requested` is the id the preflight named.
 * `reason` is the registry's error message.
 */
export interface ModelAdoptFailedNotice {
  kind: "model_adopt_failed"
  severity: "warn"
  model: string
  requested: string
  reason: string
}

/**
 * A `turn.willStop` hook halted the turn more than `cap` times in a row.
 * The loop stopped honoring the halt and ended the turn.
 */
export interface StopHookCappedNotice {
  kind: "stop_hook_capped"
  severity: "warn"
  cap: number
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
  | ReflectionAckNotice
  | StreamInterruptedSalvagedNotice
  | StreamInterruptedContinuingNotice
  | StreamInterruptedCappedNotice
  | AskDeniedNotice
  | ModelAdoptedNotice
  | ModelAdoptFailedNotice
  | StopHookCappedNotice

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
