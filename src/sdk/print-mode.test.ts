/**
 * Tests for the non-interactive output-mode helpers (Phase 4).
 *
 * Pure-function tests: every helper is a deterministic transform, so no
 * mocks, no I/O, no host. We assert on returned strings/values only.
 *
 * @module sdk/print-mode.test
 */

import { describe, expect, test } from "bun:test"

import type { AgentEvent } from "./events.ts"
import {
  formatFinalMessage,
  type OutputMode,
  renderEvent,
  renderHumanProgressLine,
  renderJsonEvent,
  selectOutputMode,
  shouldPrintFinalToStdout,
} from "./print-mode.ts"

describe("selectOutputMode", () => {
  test("--json wins even on a TTY", () => {
    expect(selectOutputMode({ isTTY: true, jsonFlag: true })).toBe("json")
    expect(selectOutputMode({ isTTY: false, jsonFlag: true })).toBe("json")
  })

  test("human when no --json, regardless of TTY", () => {
    expect(selectOutputMode({ isTTY: true, jsonFlag: false })).toBe("human")
    expect(selectOutputMode({ isTTY: false, jsonFlag: false })).toBe("human")
  })
})

describe("shouldPrintFinalToStdout", () => {
  test("json mode never prints prose to stdout (answer is in the event stream)", () => {
    expect(shouldPrintFinalToStdout({ mode: "json", isTTY: false })).toBe(false)
    expect(shouldPrintFinalToStdout({ mode: "json", isTTY: true })).toBe(false)
  })

  test("human mode prints to stdout only when NOT a TTY (piped/redirected)", () => {
    expect(shouldPrintFinalToStdout({ mode: "human", isTTY: false })).toBe(true)
    // interactive transcript already showed it -> don't double-print
    expect(shouldPrintFinalToStdout({ mode: "human", isTTY: true })).toBe(false)
  })
})

describe("formatFinalMessage", () => {
  test("human: trims trailing whitespace and ensures exactly one newline", () => {
    expect(formatFinalMessage("hello world", "human")).toBe("hello world\n")
    expect(formatFinalMessage("hello world\n\n\n", "human")).toBe("hello world\n")
    expect(formatFinalMessage("hello world   \t", "human")).toBe("hello world\n")
  })

  test("human: blank/empty answer yields empty string (nothing to print)", () => {
    expect(formatFinalMessage("", "human")).toBe("")
    expect(formatFinalMessage("   \n\t ", "human")).toBe("")
  })

  test("json: emits a single item_completed text event as one JSONL line", () => {
    const line = formatFinalMessage("the answer", "json")
    expect(line.endsWith("\n")).toBe(true)
    const parsed = JSON.parse(line)
    expect(parsed).toEqual({
      type: "item_completed",
      itemType: "text",
      id: "final",
      text: "the answer",
    })
  })

  test("json: preserves the answer verbatim (no trimming)", () => {
    const line = formatFinalMessage("trailing space \n", "json")
    expect(JSON.parse(line).text).toBe("trailing space \n")
  })
})

describe("renderJsonEvent", () => {
  test("serializes an event to one parseable JSONL line ending in newline", () => {
    const ev: AgentEvent = { type: "turn_started", turn: 0 }
    const line = renderJsonEvent(ev)
    expect(line).toBe(`${JSON.stringify(ev)}\n`)
    expect(JSON.parse(line)).toEqual({ type: "turn_started", turn: 0 })
  })

  test("concatenated lines form a valid JSONL stream", () => {
    const events: AgentEvent[] = [
      { type: "turn_started", turn: 0 },
      { type: "item_started", itemType: "tool_use", id: "t1" },
      { type: "tool_result", id: "t1", name: "Bash", isError: false },
    ]
    const stream = events.map(renderJsonEvent).join("")
    const lines = stream.trimEnd().split("\n")
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => JSON.parse(l).type)).toEqual([
      "turn_started",
      "item_started",
      "tool_result",
    ])
  })
})

describe("renderHumanProgressLine", () => {
  test("turn_started", () => {
    expect(renderHumanProgressLine({ type: "turn_started", turn: 2 })).toBe("· turn 2 started")
  })

  test("item_started shows the item kind", () => {
    expect(renderHumanProgressLine({ type: "item_started", itemType: "thinking", id: "x" })).toBe(
      "· thinking …",
    )
  })

  test("item_completed: tool_use shows the tool name, text/thinking are silent", () => {
    expect(
      renderHumanProgressLine({
        type: "item_completed",
        itemType: "tool_use",
        id: "t1",
        text: "Bash",
      }),
    ).toBe("· tool Bash")
    expect(
      renderHumanProgressLine({ type: "item_completed", itemType: "text", id: "x", text: "hi" }),
    ).toBe("")
    expect(renderHumanProgressLine({ type: "item_completed", itemType: "thinking", id: "y" })).toBe(
      "",
    )
  })

  test("tool_result shows ok/error status", () => {
    expect(
      renderHumanProgressLine({ type: "tool_result", id: "t1", name: "Read", isError: false }),
    ).toBe("· Read → ok")
    expect(
      renderHumanProgressLine({ type: "tool_result", id: "t2", name: "Write", isError: true }),
    ).toBe("· Write → error")
  })

  test("turn_completed shows stop reason + token usage", () => {
    const line = renderHumanProgressLine({
      type: "turn_completed",
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 100, outputTokens: 42 },
    })
    expect(line).toBe("· turn 1 done (end_turn; in 100 / out 42)")
  })

  test("turn_completed renders a null stop reason as an em-dash placeholder", () => {
    const line = renderHumanProgressLine({
      type: "turn_completed",
      turn: 0,
      stopReason: null,
      usage: { inputTokens: 1, outputTokens: 2 },
    })
    expect(line).toContain("turn 0 done")
    expect(line).toContain("in 1 / out 2")
  })

  test("error", () => {
    expect(renderHumanProgressLine({ type: "error", message: "boom" })).toBe("✗ boom")
  })
})

describe("renderEvent dispatch", () => {
  const ev: AgentEvent = { type: "turn_started", turn: 0 }

  test("json mode delegates to renderJsonEvent", () => {
    expect(renderEvent(ev, "json")).toBe(renderJsonEvent(ev))
  })

  test("human mode delegates to renderHumanProgressLine", () => {
    const mode: OutputMode = "human"
    expect(renderEvent(ev, mode)).toBe(renderHumanProgressLine(ev))
  })
})
