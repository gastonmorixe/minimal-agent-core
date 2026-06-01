import { describe, expect, it } from "bun:test"

import { transcriptTail } from "./output.ts"

function jsonl(...records: object[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`
}

describe("transcriptTail", () => {
  it("renders tool calls and text with timestamps", () => {
    const text = jsonl(
      {
        kind: "assistant",
        ts: "2026-05-30T12:00:01.000Z",
        content: [
          { type: "text", text: "looking for callers" },
          { type: "tool_use", name: "Grep", input: { pattern: "fork(" } },
        ],
      },
      { kind: "tool_result", ts: "2026-05-30T12:00:02.000Z", content: "..." },
      {
        kind: "assistant",
        ts: "2026-05-30T12:00:03.000Z",
        content: [{ type: "tool_use", name: "Read", input: { file_path: "src/x.ts" } }],
      },
    )
    const lines = transcriptTail(text)
    expect(lines).toEqual([
      "12:00:01 · looking for callers",
      "12:00:01 → Grep: fork(",
      "12:00:03 → Read: src/x.ts",
    ])
  })

  it("caps to the last maxEvents", () => {
    const recs = Array.from({ length: 20 }, (_, i) => ({
      kind: "assistant",
      ts: "2026-05-30T12:00:00.000Z",
      content: [{ type: "tool_use", name: `T${i}`, input: {} }],
    }))
    const lines = transcriptTail(jsonl(...recs), 5)
    expect(lines).toHaveLength(5)
    expect(lines[4]).toContain("T19")
  })

  it("is tolerant of blank/corrupt lines and empty input", () => {
    expect(transcriptTail("")).toEqual([])
    expect(transcriptTail("\n{bad\n")).toEqual([])
  })
})
