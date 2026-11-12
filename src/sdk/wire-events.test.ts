import { describe, expect, test } from "bun:test"

import type { TurnNotice } from "../agent/turn-notice.ts"

import type {
  ItemCompletedEvent,
  TextDeltaEvent,
  ThinkingDeltaEvent,
  ToolCallEvent,
  ToolOutputEvent,
  ToolResultEvent,
} from "./events.ts"
import {
  deriveStopCause,
  toolKindOf,
  toolStatusOf,
  toWireMessageDelta,
  toWireMessageDone,
  toWireNotice,
  toWireToolFinished,
  toWireToolProgress,
  toWireToolStarted,
  toWireUsage,
  type WireEvent,
  type WireToolCategory,
} from "./wire-events.ts"

describe("toWireMessageDelta", () => {
  test("text_delta becomes the answer channel", () => {
    const e: TextDeltaEvent = { type: "text_delta", id: "1:text", text: "hi" }
    expect(toWireMessageDelta(e)).toEqual({
      type: "message_delta",
      messageId: "1:text",
      channel: "answer",
      text: "hi",
    })
  })

  test("thinking_delta becomes the reasoning channel", () => {
    const e: ThinkingDeltaEvent = { type: "thinking_delta", id: "1:thinking", text: "hmm" }
    expect(toWireMessageDelta(e)).toEqual({
      type: "message_delta",
      messageId: "1:thinking",
      channel: "reasoning",
      text: "hmm",
    })
  })
})

describe("toWireMessageDone", () => {
  test("a text item becomes the answer channel", () => {
    const e: ItemCompletedEvent = { type: "item_completed", itemType: "text", id: "a1", text: "ok" }
    expect(toWireMessageDone(e)).toEqual({
      type: "message_done",
      messageId: "a1",
      channel: "answer",
      text: "ok",
    })
  })

  test("a thinking item becomes the reasoning channel", () => {
    const e: ItemCompletedEvent = {
      type: "item_completed",
      itemType: "thinking",
      id: "a2",
      text: "because",
    }
    expect(toWireMessageDone(e)?.channel).toBe("reasoning")
  })

  test("a tool_use item has no message, by design", () => {
    const e: ItemCompletedEvent = {
      type: "item_completed",
      itemType: "tool_use",
      id: "a3",
      text: "Bash",
    }
    expect(toWireMessageDone(e)).toBeUndefined()
  })
})

describe("toWireToolStarted / toWireToolProgress / toWireToolFinished", () => {
  test("tool_call projects to tool_started", () => {
    const e: ToolCallEvent = {
      type: "tool_call",
      callId: "call-1",
      toolName: "Bash",
      input: { command: "ls" },
      inputSummary: "ls",
    }
    expect(toWireToolStarted(e)).toEqual({
      type: "tool_started",
      toolCallId: "call-1",
      toolName: "Bash",
      input: { command: "ls" },
      summary: "ls",
    })
  })

  test("tool_output projects to tool_progress", () => {
    const e: ToolOutputEvent = {
      type: "tool_output",
      callId: "call-1",
      toolName: "Bash",
      text: "out",
      truncated: false,
      totalBytes: 3,
    }
    expect(toWireToolProgress(e)).toEqual({
      type: "tool_progress",
      toolCallId: "call-1",
      text: "out",
      truncated: false,
      totalBytes: 3,
    })
  })

  test("an ok tool_result projects to status succeeded", () => {
    const e: ToolResultEvent = {
      type: "tool_result",
      id: "call-1",
      name: "Bash",
      isError: false,
      outputSummary: "done",
      durationMs: 12,
    }
    expect(toWireToolFinished(e)).toEqual({
      type: "tool_finished",
      toolCallId: "call-1",
      toolName: "Bash",
      status: "succeeded",
      summary: "done",
      durationMs: 12,
    })
  })

  test("an error tool_result projects to status failed", () => {
    const e: ToolResultEvent = { type: "tool_result", id: "call-2", name: "Bash", isError: true }
    expect(toWireToolFinished(e).status).toBe("failed")
  })
})

describe("toolStatusOf", () => {
  test("a tool_call is pending", () => {
    const e: ToolCallEvent = {
      type: "tool_call",
      callId: "c",
      toolName: "Bash",
      input: {},
      inputSummary: "",
    }
    expect(toolStatusOf(e)).toBe("pending")
  })

  test("an ok tool_result is succeeded, an error one is failed", () => {
    const ok: ToolResultEvent = { type: "tool_result", id: "c", name: "Bash", isError: false }
    const err: ToolResultEvent = { type: "tool_result", id: "c", name: "Bash", isError: true }
    expect(toolStatusOf(ok)).toBe("succeeded")
    expect(toolStatusOf(err)).toBe("failed")
  })
})

describe("toolKindOf", () => {
  test.each([
    ["Read", "read"],
    ["Write", "edit"],
    ["Edit", "edit"],
    ["Bash", "run"],
    ["Glob", "search"],
    ["Grep", "search"],
    ["Fetch", "fetch"],
    ["WebSearch", "fetch"],
    ["Task", "think"],
    ["Skill", "other"],
    ["SomePluginTool", "other"],
  ])("%s -> %s", (name, kind) => {
    expect(toolKindOf(name)).toBe(kind as WireToolCategory)
  })
})

describe("toWireUsage", () => {
  test("copies the token fields verbatim", () => {
    expect(toWireUsage({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 2 })).toEqual({
      type: "usage",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
    })
  })
})

describe("toWireNotice", () => {
  test("a severity-only notice has no detail", () => {
    const notice: TurnNotice = { kind: "max_tokens_salvaged", severity: "warn" }
    expect(toWireNotice(notice)).toEqual({
      type: "notice",
      severity: "warn",
      code: "max_tokens_salvaged",
    })
  })

  test("extra fields land in detail", () => {
    const notice: TurnNotice = { kind: "max_tokens_capped", severity: "warn", cap: 5 }
    expect(toWireNotice(notice)).toEqual({
      type: "notice",
      severity: "warn",
      code: "max_tokens_capped",
      detail: { cap: 5 },
    })
  })

  test("core severity passes through unmapped (warn stays warn, not ACP's warning)", () => {
    const notice: TurnNotice = {
      kind: "refusal",
      severity: "error",
      category: null,
      message: null,
    }
    expect(toWireNotice(notice).severity).toBe("error")
  })
})

describe("deriveStopCause", () => {
  test("completed with no notice is completed", () => {
    expect(deriveStopCause({ outcome: "completed" })).toEqual({ kind: "completed" })
  })

  test("completed with a refusal notice is refused", () => {
    const lastNotice: TurnNotice = {
      kind: "refusal",
      severity: "error",
      category: "policy",
      message: "nope",
    }
    expect(deriveStopCause({ outcome: "completed", lastNotice })).toEqual({
      kind: "refused",
      category: "policy",
      message: "nope",
    })
  })

  test("completed with a content_filter notice is refused", () => {
    const lastNotice: TurnNotice = {
      kind: "content_filter",
      severity: "error",
      category: null,
      message: null,
    }
    expect(deriveStopCause({ outcome: "completed", lastNotice })).toEqual({
      kind: "refused",
      category: null,
      message: null,
    })
  })

  test("truncated with max_tokens_capped is truncated/max_tokens", () => {
    const lastNotice: TurnNotice = { kind: "max_tokens_capped", severity: "warn", cap: 5 }
    expect(deriveStopCause({ outcome: "truncated", lastNotice })).toEqual({
      kind: "truncated",
      reason: "max_tokens",
    })
  })

  test("truncated with stream_interrupted_capped is truncated/interrupted_text", () => {
    const lastNotice: TurnNotice = { kind: "stream_interrupted_capped", severity: "warn", cap: 1 }
    expect(deriveStopCause({ outcome: "truncated", lastNotice })).toEqual({
      kind: "truncated",
      reason: "interrupted_text",
    })
  })

  test("truncated with no capped notice throws (invariant violation)", () => {
    expect(() => deriveStopCause({ outcome: "truncated" })).toThrow()
  })

  test("aborted is aborted regardless of notice", () => {
    expect(deriveStopCause({ outcome: "aborted" })).toEqual({ kind: "aborted" })
  })

  test("waiting is waiting", () => {
    expect(deriveStopCause({ outcome: "waiting" })).toEqual({ kind: "waiting" })
  })

  test("failed carries the last error's message and code", () => {
    expect(
      deriveStopCause({
        outcome: "failed",
        lastError: { message: "boom", code: "E_BOOM" },
      }),
    ).toEqual({ kind: "failed", message: "boom", code: "E_BOOM" })
  })

  test("failed carries the structured error when the last error has one", () => {
    const error = { kind: "SomeError", fields: { a: 1 } }
    expect(deriveStopCause({ outcome: "failed", lastError: { message: "", error } })).toEqual({
      kind: "failed",
      message: "",
      error,
    })
  })

  test("failed from a plain error has no error key, JSON unchanged", () => {
    const out = deriveStopCause({ outcome: "failed", lastError: { message: "boom", code: "E" } })
    expect("error" in out).toBe(false)
    expect(JSON.stringify(out)).toBe('{"kind":"failed","message":"boom","code":"E"}')
  })

  test("failed with no recorded error still returns a message", () => {
    expect(deriveStopCause({ outcome: "failed" })).toEqual({
      kind: "failed",
      message: "the turn failed",
    })
  })
})

// Exhaustiveness guard: every WireEvent variant this module can produce is
// narrowable with a `never`-default switch, the same discipline AgentEvent
// consumers use (turn-notice.ts).
function assertExhaustive(event: WireEvent): string {
  switch (event.type) {
    case "message_delta":
      return "message_delta"
    case "message_done":
      return "message_done"
    case "tool_started":
      return "tool_started"
    case "tool_progress":
      return "tool_progress"
    case "tool_finished":
      return "tool_finished"
    case "usage":
      return "usage"
    case "notice":
      return "notice"
    case "turn_stopped":
      return "turn_stopped"
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

describe("WireEvent", () => {
  test("every variant narrows exhaustively", () => {
    const event: WireEvent = { type: "usage", inputTokens: 1, outputTokens: 1 }
    expect(assertExhaustive(event)).toBe("usage")
  })
})
