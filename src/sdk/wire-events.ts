/**
 * Neutral "wire event" projections of {@link AgentEvent}.
 *
 * `--output-format stream-json` (and `--json`) keep serializing
 * {@link AgentEvent} plus its envelope directly: those bytes are a frozen,
 * host-facing contract and this module changes none of them (see
 * `stream-json-writer.ts` and {@link serializeStreamJsonLine}, both
 * untouched by this file). This module is a generic wire mapper for any
 * external consumer that encodes agent events in its own format: for
 * example, a stream-json style writer or a host-mode plugin that speaks a
 * protocol over stdio. Rather than route stream-json through a shared type
 * (risk, no gain — see `research/2026-10-31-wire-event-mapper-design.md`
 * section 5 in the umbrella repo), core exposes only the PURE, STATELESS
 * pieces each encoder would otherwise have to re-derive: a neutral event
 * shape with no vendor or protocol vocabulary, a tool-name → category
 * table, a tool status projection, and an outcome+notice → stop-cause
 * projection.
 *
 * Nothing here is wired into any existing event path. Adding this file does
 * not change what any current sink receives or what any current format
 * writes: every function is a new, pure `AgentEvent → WireEvent` (or
 * `AgentEvent → some WireEvent field`) projection, called by nothing in
 * this package. An external encoder calls these directly. The
 * stream-json path keeps consuming {@link AgentEvent} as it always has.
 *
 * Design principles (from software-best-design-patterns):
 *   - Functional core: every export here is a pure function or a pure
 *     lookup table. No I/O, no host port, no process global.
 *   - Discriminated union: {@link WireEvent} and {@link WireStopCause} tag
 *     on a literal `kind`/`type`, narrowed exhaustively elsewhere with a
 *     `never` default, the same pattern as {@link AgentEvent}.
 *   - Neutral names: no protocol vocabulary (`sessionUpdate`,
 *     `agent_message_chunk`, `kind: "execute"`) and no stream-json
 *     vocabulary (`item_started`) leaks into this module. Each encoder
 *     supplies its own names.
 *
 * Scope note: protocol-specific stop-reason refinements (folding
 * `pause_turn` / `context_window_exceeded` / a completed-turn `error` into a
 * particular protocol stop reason plus metadata) and protocol config
 * pushes are OUT OF SCOPE here. They use protocol vocabulary that belongs
 * in each encoder, not in this neutral layer. See the design doc sections
 * 4a and 7a.
 *
 * @module sdk/wire-events
 */

import type { TurnNotice } from "../agent/turn-notice.ts"

import type {
  EventUsage,
  ItemCompletedEvent,
  TextDeltaEvent,
  ThinkingDeltaEvent,
  ToolCallEvent,
  ToolOutputEvent,
  ToolResultEvent,
} from "./events.ts"
import type { TurnOutcome } from "./stop-policy.ts"

// ---------------------------------------------------------------------------
// Neutral event shape
// ---------------------------------------------------------------------------

/** Lifecycle status of a tool call, from the neutral encoder's point of view. */
export type WireToolStatus = "pending" | "running" | "succeeded" | "failed" | "denied"

/**
 * Why a turn (or run) stopped, folded to the handful of causes every
 * encoder needs to tell apart. See {@link deriveStopCause}.
 */
export type WireStopCause =
  | { readonly kind: "completed" }
  | { readonly kind: "truncated"; readonly reason: "max_tokens" | "interrupted_text" }
  | { readonly kind: "refused"; readonly category: string | null; readonly message: string | null }
  | { readonly kind: "aborted" }
  | { readonly kind: "failed"; readonly message: string; readonly code?: string }
  | { readonly kind: "waiting" }

/** One assistant-text or reasoning chunk, live or final. */
export interface WireMessageDeltaEvent {
  readonly type: "message_delta"
  readonly messageId: string
  readonly channel: "answer" | "reasoning"
  readonly text: string
}

/** The message `messageId` is complete. `text`, when present, is the full body. */
export interface WireMessageDoneEvent {
  readonly type: "message_done"
  readonly messageId: string
  readonly channel: "answer" | "reasoning"
  readonly text?: string
}

/** A tool call started: the model asked to run it, and the loop is about to. */
export interface WireToolStartedEvent {
  readonly type: "tool_started"
  readonly toolCallId: string
  readonly toolName: string
  readonly input: Record<string, unknown>
  readonly summary: string
}

/** Incremental tool output, model-facing text, capped (see {@link ToolOutputEvent}). */
export interface WireToolProgressEvent {
  readonly type: "tool_progress"
  readonly toolCallId: string
  readonly text: string
  readonly truncated: boolean
  readonly totalBytes: number
}

/** A tool call finished, successfully or not. */
export interface WireToolFinishedEvent {
  readonly type: "tool_finished"
  readonly toolCallId: string
  readonly toolName: string
  readonly status: WireToolStatus
  readonly summary?: string
  readonly durationMs?: number
}

/** Token usage for the turn just completed. Tokens only; core has no cost or window size. */
export interface WireUsageEvent extends EventUsage {
  readonly type: "usage"
}

/**
 * An out-of-band condition, folded to a protocol-neutral shape: a stable
 * `code` (the core {@link TurnNotice}'s `kind`) plus whatever extra fields
 * that notice carries, as opaque `detail`. An encoder that wants the exact
 * {@link TurnNotice} shape still has it on the original {@link AgentEvent};
 * this projection is for an encoder that only wants severity + a code to
 * route on.
 */
export interface WireNoticeEvent {
  readonly type: "notice"
  readonly severity: "info" | "warn" | "error"
  readonly code: string
  readonly detail?: Record<string, unknown>
}

/** The turn (or run) stopped. See {@link WireStopCause}. */
export interface WireTurnStoppedEvent {
  readonly type: "turn_stopped"
  readonly cause: WireStopCause
}

/**
 * The neutral wire event. Narrow on `type`, the same discipline as
 * {@link AgentEvent}. There is deliberately no 1:1 mapping to it: some
 * `AgentEvent`s have no wire counterpart (`item_started` / `item_completed`
 * for a `tool_use` item are internal bookkeeping an encoder gets from
 * `tool_started` / `tool_finished` instead; `turn_started`, `status`,
 * `user_message`, `quota`, and `ask_user` are host/UI concerns with no
 * neutral shape yet).
 */
export type WireEvent =
  | WireMessageDeltaEvent
  | WireMessageDoneEvent
  | WireToolStartedEvent
  | WireToolProgressEvent
  | WireToolFinishedEvent
  | WireUsageEvent
  | WireNoticeEvent
  | WireTurnStoppedEvent

// ---------------------------------------------------------------------------
// Pure projections: AgentEvent -> WireEvent
// ---------------------------------------------------------------------------

/**
 * Project a {@link TextDeltaEvent} or {@link ThinkingDeltaEvent} to a
 * {@link WireMessageDeltaEvent}. The item id becomes `messageId`; `text_delta`
 * is the `answer` channel, `thinking_delta` is `reasoning`.
 */
export function toWireMessageDelta(
  event: TextDeltaEvent | ThinkingDeltaEvent,
): WireMessageDeltaEvent {
  return {
    type: "message_delta",
    messageId: event.id,
    channel: event.type === "text_delta" ? "answer" : "reasoning",
    text: event.text,
  }
}

/**
 * Project an {@link ItemCompletedEvent} to a {@link WireMessageDoneEvent}, or
 * `undefined` for a `tool_use` item (it has no message channel; an encoder
 * gets the tool's completion from {@link toWireToolFinished} instead).
 */
export function toWireMessageDone(event: ItemCompletedEvent): WireMessageDoneEvent | undefined {
  if (event.itemType === "tool_use") return undefined
  return {
    type: "message_done",
    messageId: event.id,
    channel: event.itemType === "text" ? "answer" : "reasoning",
    text: event.text,
  }
}

/** Project a {@link ToolCallEvent} to a {@link WireToolStartedEvent}. */
export function toWireToolStarted(event: ToolCallEvent): WireToolStartedEvent {
  return {
    type: "tool_started",
    toolCallId: event.callId,
    toolName: event.toolName,
    input: event.input,
    summary: event.inputSummary,
  }
}

/** Project a {@link ToolOutputEvent} to a {@link WireToolProgressEvent}. */
export function toWireToolProgress(event: ToolOutputEvent): WireToolProgressEvent {
  return {
    type: "tool_progress",
    toolCallId: event.callId,
    text: event.text,
    truncated: event.truncated,
    totalBytes: event.totalBytes,
  }
}

/**
 * Project a {@link ToolResultEvent} to a {@link WireToolFinishedEvent}. The
 * status comes from {@link toolStatusOf}: core has no "denied" signal of its
 * own (a hook deny comes back as an `isError` result), so a denial is a
 * `failed` status here. An encoder that wants to say "denied" derives that
 * itself from its own approval-gate state, not from this projection.
 */
export function toWireToolFinished(event: ToolResultEvent): WireToolFinishedEvent {
  return {
    type: "tool_finished",
    toolCallId: event.id,
    toolName: event.name,
    status: toolStatusOf(event),
    summary: event.outputSummary,
    durationMs: event.durationMs,
  }
}

/** Project an {@link EventUsage} to a {@link WireUsageEvent}. Tokens only. */
export function toWireUsage(usage: EventUsage): WireUsageEvent {
  return { type: "usage", ...usage }
}

/**
 * Project a {@link TurnNotice} to a {@link WireNoticeEvent}: `kind` becomes
 * the stable `code`, `severity` carries over as-is (core's `"warn"` stays
 * `"warn"` here; an encoder maps it to its own protocol value, such as
 * `"warning"` — that mapping is protocol vocabulary, not a neutral concern),
 * and every other field lands in `detail`.
 */
export function toWireNotice(notice: TurnNotice): WireNoticeEvent {
  const { kind, severity, ...rest } = notice
  const detail = rest as Record<string, unknown>
  return Object.keys(detail).length === 0
    ? { type: "notice", severity, code: kind }
    : { type: "notice", severity, code: kind, detail }
}

// ---------------------------------------------------------------------------
// Tool status + category
// ---------------------------------------------------------------------------

/**
 * The status a tool call has reached, from the two `AgentEvent`s that carry
 * one: `pending` the moment the loop is about to run it, then `succeeded` or
 * `failed` from the matching result. `running` and `denied` are states an
 * encoder tracks itself (there is no single `AgentEvent` for "now running"
 * or "denied by a hook"; see {@link toWireToolFinished}'s doc).
 */
export function toolStatusOf(event: ToolCallEvent | ToolResultEvent): WireToolStatus {
  return event.type === "tool_call" ? "pending" : event.isError ? "failed" : "succeeded"
}

/**
 * Neutral tool category, independent of any protocol's `kind` vocabulary.
 * `delete` and `move` have no current built-in tool (core ships Read, Write,
 * Edit, Glob, Grep, Bash only — `src/tools/tool-definitions.ts`); they are in
 * the enum so a future tool, or a plugin tool an encoder wants to classify,
 * has somewhere to land without widening this type again.
 */
export type WireToolCategory =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "run"
  | "fetch"
  | "think"
  | "other"

/**
 * Tool name → category, for the built-in tools (`src/tools/tool-definitions.ts`)
 * and the first-party plugin tools named in the design doc (section 6):
 * `Fetch`, `WebSearch` (`ma-fetch-plugin`, `ma-web-search-plugin`), `Task`
 * (`ma-tasks-plugin`), `Skill` (`ma-skills-plugin`). Any other name,
 * built-in or from a plugin core does not know about, is `other`.
 */
const TOOL_CATEGORIES: Readonly<Record<string, WireToolCategory>> = {
  Read: "read",
  Write: "edit",
  Edit: "edit",
  Bash: "run",
  Glob: "search",
  Grep: "search",
  Fetch: "fetch",
  WebSearch: "fetch",
  Task: "think",
  Skill: "other",
}

/** Look up a tool's neutral category. Unknown names are `other`. */
export function toolKindOf(toolName: string): WireToolCategory {
  return TOOL_CATEGORIES[toolName] ?? "other"
}

// ---------------------------------------------------------------------------
// Stop-cause derivation
// ---------------------------------------------------------------------------

/**
 * What {@link deriveStopCause} reads: the run's {@link TurnOutcome}, the last
 * {@link TurnNotice} seen in the run (if any — only `refusal` / `content_filter`,
 * `max_tokens_capped`, and `stream_interrupted_capped` change the result),
 * and, for a `failed` outcome, the last `error` event's message/code.
 */
export interface StopCauseInputs {
  readonly outcome: TurnOutcome
  readonly lastNotice?: TurnNotice | null
  readonly lastError?: { readonly message: string; readonly code?: string } | null
}

/**
 * Derive a neutral {@link WireStopCause} from a run's outcome plus its last
 * notice (never from `turn_completed` alone: a `truncated` run emits no
 * `turn_completed` — `agent-core.ts` `break`s out of the round loop before
 * the natural-exit path that would emit one). Table (design doc section 4):
 *
 * | outcome   | last notice               | cause                        |
 * |-----------|---------------------------|-------------------------------|
 * | completed | none                      | `completed`                   |
 * | completed | refusal / content_filter  | `refused` (category, message) |
 * | truncated | max_tokens_capped         | `truncated` / `max_tokens`    |
 * | truncated | stream_interrupted_capped | `truncated` / `interrupted_text` |
 * | aborted   | any                       | `aborted`                     |
 * | failed    | —                         | `failed` (from `lastError`)   |
 * | waiting   | —                         | `waiting`                     |
 *
 * This is deliberately the coarse, SHARED cut only. A protocol-specific
 * refinement (reading `turn_completed.stopReason` to tell `end_turn` apart
 * from a completed-turn `pause_turn` / `context_window_exceeded` / `error`,
 * each with its own protocol metadata) stays in each encoder. It needs
 * protocol vocabulary this neutral type does not carry. See design doc
 * section 4a.
 */
export function deriveStopCause(inputs: StopCauseInputs): WireStopCause {
  const { outcome, lastNotice } = inputs
  switch (outcome) {
    case "aborted":
      return { kind: "aborted" }
    case "waiting":
      return { kind: "waiting" }
    case "failed":
      return {
        kind: "failed",
        message: inputs.lastError?.message ?? "the turn failed",
        ...(inputs.lastError?.code === undefined ? {} : { code: inputs.lastError.code }),
      }
    case "completed":
      if (lastNotice?.kind === "refusal" || lastNotice?.kind === "content_filter") {
        return { kind: "refused", category: lastNotice.category, message: lastNotice.message }
      }
      return { kind: "completed" }
    case "truncated":
      if (lastNotice?.kind === "max_tokens_capped") {
        return { kind: "truncated", reason: "max_tokens" }
      }
      if (lastNotice?.kind === "stream_interrupted_capped") {
        return { kind: "truncated", reason: "interrupted_text" }
      }
      // VERIFIED (agent-core.ts): a `truncated` outcome is only ever reached
      // right after one of the two capped notices above. Neither present is
      // an invariant violation in the caller's event bookkeeping, not a
      // case this table has a real answer for.
      throw new Error(`truncated outcome with no capped notice (got ${lastNotice?.kind ?? "none"})`)
    default: {
      const _exhaustive: never = outcome
      throw new Error(`unhandled turn outcome: ${String(_exhaustive)}`)
    }
  }
}
