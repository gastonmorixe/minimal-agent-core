/**
 * 15e.3: compaction errors and fallback causes are facts, never text (rows
 * c3..c10). Each failure path still fails or falls back the same way. No
 * decision reads an error text.
 */

import { describe, expect, it } from "bun:test"

import {
  CompactBusyError,
  CompactModeUnsupportedError,
  CompactRaceError,
  CompactSendPolicyError,
  CompactSummaryStreamError,
} from "../errors/compact.ts"
import type { Message } from "../llm/messages.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { COMPACT_TEST_TEXT } from "../test-utils/compact-test-text.ts"

import { type CompactArgsError, parseCompactArgs } from "./context-compact.ts"
import { runCompact } from "./run-compact.ts"

function hist(n = 10): Message[] {
  const messages: Message[] = []
  for (let i = 0; i < n; i++) {
    messages.push({ role: "user", content: `u${i}` })
    messages.push({ role: "assistant", content: `a${i}` })
  }
  return messages
}

function base(messages: Message[], notes: string[] = []) {
  return {
    text: COMPACT_TEST_TEXT,
    lifecycle: NOOP_LIFECYCLE,
    messages,
    model: "no-such-model-15e3",
    auth: { type: "api-key" as const, token: "x" },
    reason: "manual" as const,
    appendNote: (t: string) => notes.push(t),
  }
}

describe("typed compaction errors (message is always empty)", () => {
  it("c3: a second compact of the same history throws CompactBusyError; the first one commits", async () => {
    const messages = hist()
    const first = runCompact({ ...base(messages), mode: "remote" })
    const err = await runCompact({ ...base(messages), mode: "tail" }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CompactBusyError)
    expect((err as Error).message).toBe("")
    expect((err as CompactBusyError).toJSON()).toEqual({ kind: "CompactBusyError", fields: {} })
    const stats = await first
    expect(stats.kind).toBe("local")
    expect(messages.length).toBe(stats.messagesAfter)
  })

  it("c4: a history change during the compact throws CompactRaceError; history keeps the change", async () => {
    const messages = hist()
    const pending = runCompact({ ...base(messages), mode: "remote" })
    messages.push({ role: "user", content: "late" })
    const err = await pending.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CompactRaceError)
    expect((err as Error).message).toBe("")
    expect(messages.length).toBe(21)
  })

  it("c5: fork throws CompactModeUnsupportedError {mode:fork}; history unchanged; note has no prose", async () => {
    const messages = hist()
    const notes: string[] = []
    const err = await runCompact({ ...base(messages, notes), mode: "fork" }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(CompactModeUnsupportedError)
    expect((err as Error).message).toBe("")
    expect((err as CompactModeUnsupportedError).toJSON()).toEqual({
      kind: "CompactModeUnsupportedError",
      fields: { mode: "fork" },
    })
    expect(messages.length).toBe(20)
    expect(notes).toEqual(["compact: fork reason=manual unsupported=fork messages 20->20"])
  })

  it("c7: remote unavailable falls back to the stub with code remote_unavailable", async () => {
    const messages = hist()
    const notes: string[] = []
    const stats = await runCompact({ ...base(messages, notes), mode: "remote" })
    expect(stats.kind).toBe("local")
    expect(stats.remoteError).toEqual({ code: "remote_unavailable" })
    expect(notes[0]).toBe("compact: remote fallback=local code=remote_unavailable")
  })

  it("c8: CompactSummaryStreamError keeps retryable, 401 status and cause as facts", () => {
    const cause = new Error("HTTP 401")
    const err = new CompactSummaryStreamError(
      { retryable: true, category: "auth", detail: "", status: 401 },
      { cause },
    )
    expect(err.message).toBe("")
    expect(err.retryable).toBe(true)
    expect(err.status).toBe(401)
    expect(err.detail).toBeUndefined()
    expect(err.cause).toBe(cause)
  })

  it("c9: CompactSendPolicyError holds the error name only", () => {
    const err = new CompactSendPolicyError("TypeError")
    expect(err.message).toBe("")
    expect(err.toJSON()).toEqual({
      kind: "CompactSendPolicyError",
      fields: { errorName: "TypeError" },
    })
  })
})

describe("c10: parseCompactArgs returns codes and tokens, no text", () => {
  it.each<[string, CompactArgsError]>([
    ["bogus", { code: "unknown_argument", token: "bogus" }],
    ["local tail", { code: "duplicate_mode", token: "tail" }],
    ["tail mode=local", { code: "duplicate_mode", token: "mode=local" }],
    ["mode=wide", { code: "unknown_mode", token: "mode=wide", value: "wide" }],
    ["tail=x", { code: "bad_tail", token: "tail=x", value: "x" }],
    ["tail=-1", { code: "bad_tail", token: "tail=-1", value: "-1" }],
    ["zap=1", { code: "unknown_argument", token: "zap=1" }],
  ])("%s", (argv, error) => {
    expect(parseCompactArgs(argv)).toEqual({ error })
  })

  it("valid argv has no error", () => {
    expect(parseCompactArgs('local tail=3 focus="x y"')).toEqual({
      mode: "local",
      keepTail: 3,
      focus: "x y",
    })
  })
})
