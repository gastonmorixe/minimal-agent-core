/**
 * The v2 stop table (spec section 2.1) as the oracle for `decideNext`: one
 * test per row, in the table's fixed check order.
 *
 * @module sdk/stop-policy.test
 */

import { describe, expect, it } from "bun:test"

import type { ClassifiedError } from "../llm/transport/retry-policy.ts"

import {
  type AttemptResult,
  decideNext,
  type LoopState,
  MAX_INTERRUPTED_TURN_CONTINUATIONS,
  MAX_TOKENS_CONTINUATION_CAP,
  type ResponseFacts,
} from "./stop-policy.ts"

const fresh: LoopState = {
  aborted: false,
  streaks: { maxTokens: 0, interrupted: 0 },
  recoveriesTried: [],
}

function response(facts: Partial<ResponseFacts>): AttemptResult {
  return {
    kind: "response",
    response: { stopReason: "end_turn", toolUseCount: 0, terminalLess: false, ...facts },
  }
}

function error(e: Omit<ClassifiedError, "error">): AttemptResult {
  return { kind: "error", error: { ...e, error: new Error(e.cause) } }
}

describe("decideNext (stop table v2)", () => {
  it("row 1: an aborted signal stops `aborted`, before any other row", () => {
    const d = decideNext({ ...fresh, aborted: true }, response({ toolUseCount: 2 }))
    expect(d.row).toBe(1)
    expect(d).toMatchObject({ kind: "stop", outcome: "aborted" })
    // Row 1 also wins over an error.
    const e = decideNext(
      { ...fresh, aborted: true },
      error({ errorClass: "permanent", cause: "x" }),
    )
    expect(e.row).toBe(1)
  })

  it("row 2: tool_use blocks run the tools and keep the max_tokens streak", () => {
    const state = { ...fresh, streaks: { maxTokens: 3, interrupted: 1 } }
    const d = decideNext(state, response({ stopReason: "tool_use", toolUseCount: 1 }))
    expect(d.row).toBe(2)
    expect(d).toMatchObject({ kind: "run_tools", salvaged: false })
    // The loop resets maxTokens after one successful tool call (row 2 effect).
    expect(d.streaks).toEqual({ maxTokens: 3, interrupted: 0 })
  })

  it("row 3: max_tokens with streak 1 to 5 continues", () => {
    const first = decideNext(fresh, response({ stopReason: "max_tokens" }))
    expect(first.row).toBe(3)
    expect(first).toMatchObject({ kind: "continue", reason: "max_tokens", attempt: 1 })
    const fifth = decideNext(
      { ...fresh, streaks: { maxTokens: MAX_TOKENS_CONTINUATION_CAP - 1, interrupted: 0 } },
      response({ stopReason: "max_tokens" }),
    )
    expect(fifth.row).toBe(3)
    expect(fifth.streaks.maxTokens).toBe(MAX_TOKENS_CONTINUATION_CAP)
  })

  it("row 4: max_tokens with streak above 5 stops `truncated` (D20)", () => {
    const d = decideNext(
      { ...fresh, streaks: { maxTokens: MAX_TOKENS_CONTINUATION_CAP, interrupted: 0 } },
      response({ stopReason: "max_tokens" }),
    )
    expect(d.row).toBe(4)
    expect(d).toMatchObject({ kind: "stop", outcome: "truncated", reason: "max_tokens" })
  })

  it("row 5: a terminal-less close after text, streak 1, continues", () => {
    const d = decideNext(fresh, response({ terminalLess: true }))
    expect(d.row).toBe(5)
    expect(d).toMatchObject({ kind: "continue", reason: "interrupted_text", attempt: 1 })
  })

  it("row 6: the same close with streak above 1 stops `truncated` (D20)", () => {
    const d = decideNext(
      { ...fresh, streaks: { maxTokens: 0, interrupted: MAX_INTERRUPTED_TURN_CONTINUATIONS } },
      response({ terminalLess: true }),
    )
    expect(d.row).toBe(6)
    expect(d).toMatchObject({ kind: "stop", outcome: "truncated", reason: "interrupted_text" })
  })

  it("row 7: a terminal-less close after a completed tool call salvages the tools", () => {
    const d = decideNext(
      fresh,
      response({ stopReason: "tool_use", toolUseCount: 1, terminalLess: true }),
    )
    expect(d.row).toBe(7)
    expect(d).toMatchObject({ kind: "run_tools", salvaged: true })
  })

  it("row 8: a terminal-less close with no completed tool call retries", () => {
    const d = decideNext(
      fresh,
      error({ errorClass: "transient", cause: "stream_closed_without_terminal" }),
    )
    expect(d.row).toBe(8)
    expect(d.kind).toBe("retry")
  })

  it("row 9: a transient error retries", () => {
    const d = decideNext(fresh, error({ errorClass: "transient", cause: "rate_limit_error" }))
    expect(d.row).toBe(9)
    expect(d.kind).toBe("retry")
  })

  it("row 10: a recoverable error runs its recovery once per round", () => {
    const e = error({ errorClass: "recoverable", recovery: "compact", cause: "recoverable" })
    const d = decideNext(fresh, e)
    expect(d.row).toBe(10)
    expect(d).toMatchObject({ kind: "recover", action: "compact" })
    // After the recovery ran, the same error is "invalid after recovery": row 11.
    const again = decideNext({ ...fresh, recoveriesTried: ["compact"] }, e)
    expect(again.row).toBe(11)
    // A quota wait may repeat: a later reset is a new wait.
    const quota = error({
      errorClass: "recoverable",
      recovery: "wait_for_quota",
      resetAt: 1,
      cause: "rate_limit_error",
    })
    expect(decideNext({ ...fresh, recoveriesTried: ["wait_for_quota"] }, quota).row).toBe(10)
  })

  it("row 11: a permanent error stops `waiting` (the run pauses, it does not end)", () => {
    const d = decideNext(fresh, error({ errorClass: "permanent", cause: "permanent" }))
    expect(d.row).toBe(11)
    expect(d).toMatchObject({ kind: "stop", outcome: "waiting" })
  })

  it("row 12: a refused tool batch stops `failed`", () => {
    const d = decideNext(fresh, { kind: "tool_batch_refused", reason: "policy" })
    expect(d.row).toBe(12)
    expect(d).toMatchObject({ kind: "stop", outcome: "failed", reason: "policy" })
  })

  it("row 13: end_turn or stop_sequence with no tool_use stops `completed`", () => {
    for (const stopReason of ["end_turn", "stop_sequence"]) {
      const d = decideNext(
        { ...fresh, streaks: { maxTokens: 2, interrupted: 0 } },
        response({ stopReason }),
      )
      expect(d.row).toBe(13)
      expect(d).toMatchObject({ kind: "stop", outcome: "completed" })
      expect(d.streaks).toEqual({ maxTokens: 0, interrupted: 0 })
    }
  })

  it("has no `capped` outcome: no row counts rounds or retries", () => {
    // A thousand transient failures in a row still decide `retry`.
    const e = error({ errorClass: "transient", cause: "overloaded_error" })
    for (let i = 0; i < 1000; i++) expect(decideNext(fresh, e).kind).toBe("retry")
  })
})
