import { describe, expect, it } from "bun:test"

import { parseFinalText, parseProgress } from "./progress.ts"
import { ZERO_PROGRESS } from "./types.ts"

/** Build a JSONL transcript from record objects. */
function jsonl(...records: object[]): string {
  return `${records.map((r) => JSON.stringify(r)).join("\n")}\n`
}

describe("parseProgress", () => {
  it("returns zero for an empty / meta-only transcript", () => {
    expect(parseProgress("")).toEqual(ZERO_PROGRESS)
    expect(
      parseProgress(jsonl({ kind: "meta", sid: "x" }, { kind: "user", content: "hi" })),
    ).toEqual(ZERO_PROGRESS)
  })

  it("counts tool_use blocks and sums billed tokens across assistant turns", () => {
    const text = jsonl(
      {
        kind: "assistant",
        content: [
          { type: "text", text: "let me look" },
          { type: "tool_use", name: "Grep", input: { pattern: "fork(" } },
        ],
        usage: { input_tokens: 1000, output_tokens: 200 },
      },
      { kind: "tool_result", content: "..." },
      {
        kind: "assistant",
        content: [{ type: "tool_use", name: "Read", input: { file_path: "src/x.ts" } }],
        usage: { input_tokens: 1500, output_tokens: 120 },
      },
    )
    const p = parseProgress(text)
    expect(p.tools).toBe(2)
    expect(p.tokens).toBe(1000 + 200 + 1500 + 120)
    expect(p.lastTool).toBe("Read")
    expect(p.lastActivity).toBe("Read: src/x.ts") // most recent activity, with its arg
  })

  it("uses a text snippet as lastActivity when the latest block is prose", () => {
    const text = jsonl({
      kind: "assistant",
      content: [
        { type: "text", text: "I have finished analyzing the parser and here is the summary" },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    })
    const p = parseProgress(text)
    expect(p.tools).toBe(0)
    expect(p.lastActivity).toContain("I have finished analyzing")
  })

  it("tolerates blank + corrupt lines", () => {
    const good = JSON.stringify({
      kind: "assistant",
      content: [{ type: "tool_use", name: "Bash", input: { command: "echo hi" } }],
      usage: { output_tokens: 3 },
    })
    const p = parseProgress(`\n${good}\n{ not json\n`)
    expect(p.tools).toBe(1)
    expect(p.lastActivity).toBe("Bash: echo hi")
  })
})

describe("parseFinalText", () => {
  it("returns undefined when there is no assistant text at all", () => {
    expect(parseFinalText("")).toBeUndefined()
    expect(parseFinalText(jsonl({ kind: "user", content: "hi" }))).toBeUndefined()
    // a tool-only assistant turn is not a final synthesis
    expect(
      parseFinalText(
        jsonl({ kind: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] }),
      ),
    ).toBeUndefined()
  })

  it("returns the LAST assistant message that contains text", () => {
    const text = jsonl(
      { kind: "assistant", content: [{ type: "text", text: "first thoughts" }] },
      { kind: "tool_result", content: "..." },
      {
        kind: "assistant",
        content: [{ type: "text", text: "FINAL: I found 3 callers in foo.ts" }],
      },
    )
    expect(parseFinalText(text)).toBe("FINAL: I found 3 callers in foo.ts")
  })

  it("skips a trailing tool-only turn and uses the last PROSE turn", () => {
    const text = jsonl(
      { kind: "assistant", content: [{ type: "text", text: "my summary is here" }] },
      {
        kind: "assistant",
        content: [{ type: "tool_use", name: "Read", input: { file_path: "x" } }],
      },
    )
    expect(parseFinalText(text)).toBe("my summary is here")
  })

  it("joins multiple text blocks in the final message", () => {
    const text = jsonl({
      kind: "assistant",
      content: [
        { type: "text", text: "part one" },
        { type: "tool_use", name: "X", input: {} },
        { type: "text", text: "part two" },
      ],
    })
    expect(parseFinalText(text)).toBe("part one\n\npart two")
  })

  it("clips a runaway final message and marks the cut", () => {
    const huge = "x".repeat(5000)
    const out = parseFinalText(
      jsonl({ kind: "assistant", content: [{ type: "text", text: huge }] }),
      100,
    )
    expect(out?.length).toBe(100)
    expect(out?.endsWith("…")).toBe(true)
  })
})
