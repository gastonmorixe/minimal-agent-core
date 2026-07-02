import { describe, expect, test } from "bun:test"

import { type AgentEvent, type EventSink, JsonlEventSink, serializeEvent } from "./events.ts"

describe("serializeEvent", () => {
  test("emits compact JSON plus a single trailing newline", () => {
    const e: AgentEvent = { type: "turn_started", turn: 0 }
    const line = serializeEvent(e)
    expect(line).toBe('{"type":"turn_started","turn":0}\n')
    expect(line.endsWith("\n")).toBe(true)
    // exactly one newline (the terminator), none embedded
    expect(line.split("\n")).toHaveLength(2)
  })

  test("round-trips through JSON.parse after stripping the newline", () => {
    const e: AgentEvent = {
      type: "turn_completed",
      turn: 3,
      stopReason: "end_turn",
      usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 5 },
    }
    const parsed = JSON.parse(serializeEvent(e).trimEnd())
    expect(parsed).toEqual(e)
  })

  test("preserves a null stopReason", () => {
    const e: AgentEvent = {
      type: "turn_completed",
      turn: 1,
      stopReason: null,
      usage: { inputTokens: 1, outputTokens: 2 },
    }
    const parsed = JSON.parse(serializeEvent(e).trimEnd())
    expect(parsed.stopReason).toBeNull()
  })

  test("concatenated lines form a valid JSONL stream", () => {
    const events: AgentEvent[] = [
      { type: "turn_started", turn: 0 },
      { type: "item_started", itemType: "tool_use", id: "tool_1" },
      { type: "tool_result", id: "tool_1", name: "Bash", isError: false },
      { type: "item_completed", itemType: "tool_use", id: "tool_1", text: "Bash" },
      {
        type: "turn_completed",
        turn: 0,
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    ]
    const stream = events.map(serializeEvent).join("")
    const lines = stream.split("\n").filter((l) => l.length > 0)
    expect(lines).toHaveLength(events.length)
    const reparsed = lines.map((l) => JSON.parse(l))
    expect(reparsed).toEqual(events)
  })

  test("omits undefined optional fields from the encoding", () => {
    const e: AgentEvent = { type: "item_completed", itemType: "text", id: "0" }
    const line = serializeEvent(e)
    // the optional `text` field is absent, not serialized as null
    expect(line).not.toContain('"text":')
    const parsed = JSON.parse(line.trimEnd())
    expect(Object.hasOwn(parsed, "text")).toBe(false)
    expect(parsed).toEqual(e)
  })
})

describe("JsonlEventSink", () => {
  test("writes one serialized line per emitted event", () => {
    const written: string[] = []
    const sink: EventSink = new JsonlEventSink((line) => written.push(line))

    sink.emit({ type: "turn_started", turn: 0 })
    sink.emit({ type: "error", message: "boom" })

    expect(written).toEqual([
      '{"type":"turn_started","turn":0}\n',
      '{"type":"error","message":"boom"}\n',
    ])
  })

  test("each write is exactly one JSONL record", () => {
    const written: string[] = []
    const sink = new JsonlEventSink((line) => written.push(line))
    sink.emit({ type: "item_completed", itemType: "thinking", id: "t0", text: "hmm" })
    expect(written).toHaveLength(1)
    expect(written[0]).toBe(
      '{"type":"item_completed","itemType":"thinking","id":"t0","text":"hmm"}\n',
    )
  })
})

describe("AgentEvent exhaustiveness", () => {
  // A consumer that narrows on `type` should hit every variant; this also
  // pins the variant tags so renaming one is a compile break here.
  function tag(e: AgentEvent): string {
    switch (e.type) {
      case "turn_started":
        return e.type
      case "item_started":
        return e.type
      case "item_completed":
        return e.type
      case "tool_result":
        return e.type
      case "turn_completed":
        return e.type
      case "notice":
        return e.type
      case "error":
        return e.type
      default: {
        const _never: never = e
        return _never
      }
    }
  }

  test("every variant narrows to its own tag", () => {
    const samples: AgentEvent[] = [
      { type: "turn_started", turn: 0 },
      { type: "item_started", itemType: "text", id: "0" },
      { type: "item_completed", itemType: "text", id: "0", text: "hi" },
      { type: "tool_result", id: "t1", name: "Read", isError: true },
      {
        type: "turn_completed",
        turn: 0,
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      {
        type: "notice",
        notice: { kind: "refusal", severity: "error", category: null, message: null },
      },
      { type: "error", message: "x" },
    ]
    for (const s of samples) expect(tag(s)).toBe(s.type)
  })
})
