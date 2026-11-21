/**
 * Turn wrap-up: end a run politely, with one last short model turn.
 *
 * A host (for example a headless worker that got SIGTERM) aborts the run
 * signal with a {@link WrapUpReason} (kind `wrap_up`, with optional
 * `text`, `tools` and `deadlineAt`). That is not a user abort: the run
 * does not end as `aborted`. The loop ends the in-flight request, the
 * retry wait and the tool run. It closes each tool call that has no
 * result, then sends ONE
 * final request with the host note, short timeouts, and at most one retry
 * (only for a transient error, and only when time stays). It runs the tool
 * calls of that answer, then the run ends with outcome `truncated`.
 *
 * Time budget: the final turn ends at the earlier of
 * {@link WRAP_UP_DEADLINE_MS} after its start and the host
 * {@link WrapUpReason.deadlineAt}. Thus a slow unwind of the in-flight
 * step (a tool that is slow to obey the abort) reduces the final turn, and
 * the host force-exit does not cut it.
 *
 * Events: each `turn_started` of the final turn has its `turn_completed`.
 * When the final request gives no answer (the sends failed, or the budget
 * ended), `turn_completed` has `stopReason` "error" and zero usage. With
 * no note and a history that ends on the assistant, no request goes out,
 * and no turn events come. `run_finished` `truncated` comes once.
 *
 * Lifecycle: the final turn calls `turnEnd` with {@link WRAP_UP_TURN_END}
 * (`ok` false, `aborted` true, `error` "wrap_up"). That is the shape of
 * an aborted turn (`turn.aborted` hook), not of a failed turn. No
 * recovery runs for it.
 *
 * Limit: a wrap-up before the round request exists (during the session
 * open or the turn-start hooks) has no final turn. No work exists yet, so
 * the run ends as a plain abort: `error` "aborted" and `run_finished`
 * `aborted`, also when the step threw {@link WrapUpAbortError}. The host
 * still ends the process (the CLI exits 143).
 *
 * Core knows no tool name and holds no model text. The host gives both in
 * the {@link WrapUpReason}.
 *
 * @module sdk/wrap-up
 */

import { closeInterruptedToolCalls } from "../agent/history-repair.ts"
import type { SyntheticTextResolver } from "../agent/synthetic-text.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"
import type { ContentBlock, ToolUseBlock } from "../llm/messages.ts"
import { classifyError } from "../llm/transport/retry-policy.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"
import {
  isWrapUpAbort,
  isWrapUpReason,
  WRAP_UP_REASON,
  WrapUpAbortError,
  type WrapUpReason,
} from "../llm/transport/wrap-up-abort.ts"
import { NO_SIDEBAND } from "../sideband/api.ts"
import { renderCoreBody } from "../sideband/core-render.ts"
import type { SidebandApi } from "../sideband/types.ts"

import { EMPTY_RESPONSE, toEventStopReason, toEventUsage } from "./agent-core-helpers.ts"
import { type ResponseRecordDeps, recordModelResponse } from "./agent-core-round.ts"
import type { AgentEvent } from "./events.ts"
import type { LifecyclePort } from "./lifecycle.ts"
import type { AttemptSend, RoundRequest } from "./send-attempt.ts"
import type { TurnOutcome } from "./stop-policy.ts"
import { persistSyntheticToolResult, runToolCalls, type ToolCallHost } from "./tool-calls.ts"

export {
  isWrapUpAbort,
  isWrapUpReason,
  WRAP_UP_REASON,
  WrapUpAbortError,
  type WrapUpReason,
} from "../llm/transport/wrap-up-abort.ts"

/** Pre-headers timeout of the final request, in ms. */
export const WRAP_UP_HEADERS_TIMEOUT_MS = 10_000
/** Mid-stream idle timeout of the final request, in ms. */
export const WRAP_UP_IDLE_TIMEOUT_MS = 10_000
/** Hard limit of one final request attempt, in ms. */
export const WRAP_UP_ATTEMPT_TIMEOUT_MS = 18_000
/** Attempts of the final request: one send and at most one retry. */
export const WRAP_UP_MAX_ATTEMPTS = 2
/** Hard limit of the whole final turn (request, one retry, tool calls), in ms. */
export const WRAP_UP_DEADLINE_MS = 40_000
/** The retry of the final request needs at least this time left, in ms. */
export const WRAP_UP_RETRY_MIN_MS = 12_000
/** The final turn always gets at least this budget, in ms (a past `deadlineAt`). */
export const WRAP_UP_MIN_BUDGET_MS = 1000

/** The send options of the final request: short timeouts. */
export const WRAP_UP_SEND_OPTIONS = Object.freeze({
  responseHeadersTimeoutMs: WRAP_UP_HEADERS_TIMEOUT_MS,
  streamIdleTimeoutMs: WRAP_UP_IDLE_TIMEOUT_MS,
  attemptHardTimeoutMs: WRAP_UP_ATTEMPT_TIMEOUT_MS,
})

/** The `turnEnd` payload of the final turn: an aborted turn, not a failed turn. */
export const WRAP_UP_TURN_END = Object.freeze({
  ok: false,
  aborted: true,
  error: "wrap_up",
} as const)

/** The tool list of the final request (see {@link WrapUpReason.tools}). */
export function wrapUpTools<T extends { name: string }>(
  tools: readonly T[] | undefined,
  only: readonly string[] | undefined,
): T[] | undefined {
  if (!tools) return undefined
  const kept = only && only.length > 0 ? tools.filter((t) => only.includes(t.name)) : []
  return kept.length > 0 ? kept : [...tools]
}

/** The sideband kind of the wrap-up note: the tag and the block mark. */
const WRAP_UP_KIND = "wrap-up"

/**
 * The user content of the final turn: the host note in one `wrap-up` tag
 * (`renderCoreBody`, design step 6), or nothing when the note is blank. No
 * codec, or no `wrap-up` kind: the note text with no wrapper. The block has
 * the mark `sideband: { kind: "wrap-up" }` in both cases (design step 12c).
 */
export function wrapUpContent(
  sb: Pick<SidebandApi, "render">,
  reason: WrapUpReason,
): ContentBlock[] {
  const text = reason.text?.trim()
  if (!text) return []
  return [
    {
      type: "text",
      text: renderCoreBody(sb, WRAP_UP_KIND, { body: text }),
      sideband: { kind: WRAP_UP_KIND },
    },
  ]
}

/**
 * The time budget of the final turn, in ms: {@link WRAP_UP_DEADLINE_MS},
 * or less when the host `deadlineAt` comes first. Never less than
 * {@link WRAP_UP_MIN_BUDGET_MS}.
 */
export function wrapUpBudgetMs(reason: WrapUpReason, now: number): number {
  const { deadlineAt } = reason
  if (deadlineAt === undefined || !Number.isFinite(deadlineAt)) return WRAP_UP_DEADLINE_MS
  return Math.max(WRAP_UP_MIN_BUDGET_MS, Math.min(WRAP_UP_DEADLINE_MS, deadlineAt - now))
}

/** What `AgentCore` keeps during a run for a wrap-up. */
export interface WrapUpState {
  /** The turn signal. A wrap-up abort of it starts the final turn. */
  signal?: AbortSignal
  /** The round request of the turn (system prompt, tools, send options). */
  req?: RoundRequest
  /**
   * The last round that started. A resumed turn starts from its checkpoint
   * round, so the core sets it with `req`. Each run starts a new state.
   */
  round?: number
}

/** What the final turn needs from the core. */
export interface WrapUpHost {
  /** The response record steps (history, session log, item events). */
  readonly record: ResponseRecordDeps
  /** The tool step. */
  readonly tools: ToolCallHost
  /** One send of the current history (the core's `sendAttempt`). */
  readonly send: (
    req: RoundRequest,
    round: number,
  ) => AsyncGenerator<string, AttemptSend, undefined>
  readonly text: SyntheticTextResolver
  /** The sideband API that renders the host note. Omitted: none (no note). */
  readonly sideband?: Pick<SidebandApi, "render">
  readonly diagnostics: Diagnostics
  readonly lifecycle: LifecyclePort
  /**
   * Wall clock in epoch ms (for {@link WrapUpReason.deadlineAt}). Default:
   * the clock of `tools` (the core retry clock, default `Date.now`).
   */
  readonly now?: () => number
}

/** Throw {@link WrapUpAbortError} when `signal` aborted for a wrap-up. */
export function throwIfWrapUp(signal: AbortSignal | undefined): void {
  if (isWrapUpAbort(signal)) throw new WrapUpAbortError()
}

/**
 * A {@link WrapUpAbortError} with no final turn (no round request yet) is
 * a plain abort: it emits `error` "aborted" and gives an `AbortError` with
 * the wrap-up error as `cause`. Other errors stay, with no event.
 */
export function wrapUpAsAbort(err: unknown, emit: (event: AgentEvent) => void): unknown {
  if (!(err instanceof WrapUpAbortError)) return err
  emit({ type: "error", message: "aborted" })
  return Object.assign(new Error("aborted"), { name: "AbortError", cause: err })
}

/** Put the host note at the end of history. */
function appendNote(host: WrapUpHost, wrap: WrapUpReason): void {
  const { messages, persistence } = host.record
  const note = wrapUpContent(host.sideband ?? NO_SIDEBAND, wrap)
  if (note.length === 0) return
  const last = messages[messages.length - 1]
  if (last?.role === "user" && Array.isArray(last.content))
    last.content = [...last.content, ...note]
  else messages.push({ role: "user", content: note })
  persistence?.appendUser(note)
}

/**
 * Send the final request: at most {@link WRAP_UP_MAX_ATTEMPTS}. A retry
 * only follows a transient error, and only when
 * {@link WRAP_UP_RETRY_MIN_MS} or more stays before `endsAt`.
 */
async function* sendFinal(
  host: WrapUpHost,
  req: RoundRequest,
  round: number,
  endsAt: number,
): AsyncGenerator<string, StreamedResponse | undefined, undefined> {
  const now = host.now ?? (() => host.tools.now())
  for (let attempt = 1; attempt <= WRAP_UP_MAX_ATTEMPTS; attempt++) {
    if (req.signal?.aborted) return undefined
    const sent = yield* host.send(req, round)
    if (sent.kind === "response") return sent.response
    const errorClass = classifyError(sent.err)?.errorClass
    const left = endsAt - now()
    host.diagnostics.warn("agent.wrap-up-failed", `final turn attempt ${attempt} failed`, {
      attempt,
      error: String(sent.err),
      errorClass: errorClass ?? "unclassified",
      leftMs: left,
    })
    if (errorClass !== "transient" || left < WRAP_UP_RETRY_MIN_MS) return undefined
  }
  return undefined
}

/**
 * Run the ONE final turn of a wrap-up. Each tool call with no result gets
 * the `tool_result.interrupted_by_stop` result (it never runs again). The
 * host note goes at the end of history. The request uses the short
 * timeouts and at most one retry. The tool calls of the answer run once
 * (only the tools that the final request advertised). The run always ends
 * with outcome `truncated`: this function emits `run_finished` itself, also
 * when a step throws (the error goes to diagnostics, never to the caller).
 * `cause` is the error that ended the in-flight step. When it is not the
 * {@link WrapUpAbortError} itself (a bug at the same time), it goes to the
 * `agent.wrap-up-cause` diagnostic.
 *
 * @yields The text deltas of the final answer.
 */
export async function* runWrapUpTurn(
  host: WrapUpHost,
  state: WrapUpState & { req: RoundRequest },
  cause?: unknown,
): AsyncGenerator<string, StreamedResponse & { outcome: TurnOutcome }, undefined> {
  const { req } = state
  if (cause !== undefined && !(cause instanceof WrapUpAbortError)) {
    host.diagnostics.warn("agent.wrap-up-cause", "the step failed during a wrap-up", {
      cause: String(cause),
    })
  }
  const { messages, persistence, emit } = host.record
  const round = (state.round ?? 0) + 1
  // True from `turn_started` until its `turn_completed`.
  let turnOpen = false
  try {
    const reason: unknown = state.signal?.reason
    const wrap: WrapUpReason = isWrapUpReason(reason) ? reason : WRAP_UP_REASON
    const now = host.now ?? (() => host.tools.now())
    const budgetMs = wrapUpBudgetMs(wrap, now())
    const endsAt = now() + budgetMs
    host.diagnostics.warn("agent.wrap-up", "wrap-up requested: one final turn", {
      round,
      budgetMs,
    })
    for (const b of closeInterruptedToolCalls(messages, host.text)) {
      persistSyntheticToolResult(persistence, b)
    }
    appendNote(host, wrap)
    // With no note, a history that ends on the assistant has no new request.
    if (messages[messages.length - 1]?.role !== "user") {
      return { ...EMPTY_RESPONSE, outcome: "truncated" }
    }
    const deadline = AbortSignal.timeout(budgetMs)
    const tools = wrapUpTools(req.tools, wrap.tools)
    const { signal: _turnSignal, ...base } = req
    const finalReq: RoundRequest = {
      ...base,
      ...(tools ? { tools } : {}),
      sendOpts: { ...req.sendOpts, ...WRAP_UP_SEND_OPTIONS },
      signal: deadline,
    }
    emit({ type: "turn_started", turn: round })
    turnOpen = true
    const response = yield* sendFinal(host, finalReq, round, endsAt)
    if (!response) return { ...EMPTY_RESPONSE, outcome: "truncated" }
    recordModelResponse(host.record, response, round)
    const allowed = new Set((tools ?? []).map((t) => t.name))
    const calls = response.blocks.filter(
      (b): b is ToolUseBlock => b.type === "tool_use" && allowed.has(b.name),
    )
    if (calls.length > 0) {
      const results = await runToolCalls(host.tools, calls, deadline)
      messages.push({ role: "user", content: results })
    }
    // A call to a tool that the final request did not advertise never runs.
    for (const b of closeInterruptedToolCalls(messages, host.text)) {
      persistSyntheticToolResult(persistence, b)
    }
    turnOpen = false
    emit({
      type: "turn_completed",
      turn: round,
      stopReason: toEventStopReason(response.stopReason),
      usage: toEventUsage(response.usage),
    })
    return { ...response, outcome: "truncated" }
  } catch (err) {
    // The final turn never fails the run: the run still ends `truncated`.
    host.diagnostics.error("agent.wrap-up-failed", "final turn failed", { error: String(err) })
    return { ...EMPTY_RESPONSE, outcome: "truncated" }
  } finally {
    // No answer (or a throw): close the open turn, so the events pair up.
    if (turnOpen) {
      emit({
        type: "turn_completed",
        turn: round,
        stopReason: "error",
        usage: toEventUsage(undefined),
      })
    }
    void host.lifecycle.turnEnd?.(WRAP_UP_TURN_END)
    // The run always ends `truncated`, also after a throw above.
    emit({ type: "run_finished", outcome: "truncated" })
  }
}
