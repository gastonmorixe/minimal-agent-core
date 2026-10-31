/**
 * Tool fact helpers (spec S19): input/output summaries and the UTF-8 cap.
 *
 * @module sdk/tool-facts.test
 */

import { describe, expect, it } from "bun:test"

import type { ToolUseBlock } from "../llm/messages.ts"

import { capUtf8, summarizeToolInput, summarizeToolOutput, toolOutputEvent } from "./tool-facts.ts"

describe("summarizeToolInput", () => {
  it("falls back to compact JSON with no headerKey", () => {
    expect(summarizeToolInput({ pattern: "x", path: "src" })).toBe('{"pattern":"x","path":"src"}')
  })

  it("prefers the headerKey field when present and a non-empty string", () => {
    expect(summarizeToolInput({ url: "https://example.com", method: "GET" }, "url")).toBe(
      "https://example.com",
    )
  })

  it("falls back to JSON when the headerKey field is missing or blank", () => {
    expect(summarizeToolInput({ a: 1 }, "url")).toBe('{"a":1}')
    // The JSON fallback also collapses whitespace (it is a display summary,
    // not a round-trippable value), so the blank value reads as one space.
    expect(summarizeToolInput({ url: "  " }, "url")).toBe('{"url":" "}')
  })

  it("collapses whitespace and cuts very long values", () => {
    const long = "x".repeat(200)
    const out = summarizeToolInput({ q: long }, "q")
    expect(out.length).toBeLessThanOrEqual(120)
    expect(out.endsWith("…")).toBe(true)
  })
})

describe("summarizeToolOutput", () => {
  it("summarizes a single-line string output", () => {
    expect(summarizeToolOutput("hello world")).toBe("hello world")
  })

  it("counts the remaining non-empty lines", () => {
    expect(summarizeToolOutput("line one\nline two\nline three")).toBe("line one (+2 lines)")
    expect(summarizeToolOutput("only\n\n")).toBe("only")
  })

  it("is empty for empty output", () => {
    expect(summarizeToolOutput("")).toBe("")
  })

  it("reads text blocks and tags other block types", () => {
    expect(
      summarizeToolOutput([
        { type: "text", text: "caption" },
        { type: "image", source: { type: "url", url: "x" } },
      ]),
    ).toBe("caption (+1 line)")
  })
})

describe("capUtf8", () => {
  it("leaves short text untouched", () => {
    expect(capUtf8("hi", 100)).toEqual({ text: "hi", truncated: false, totalBytes: 2 })
  })

  it("cuts to a character boundary, never splitting a multi-byte codepoint", () => {
    const text = "a".repeat(10) + "€" // € is 3 bytes in UTF-8
    const { text: cut, truncated, totalBytes } = capUtf8(text, 11)
    expect(truncated).toBe(true)
    expect(totalBytes).toBe(13)
    expect(cut).toBe("a".repeat(10))
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(11)
  })
})

describe("toolOutputEvent", () => {
  const tool: ToolUseBlock = { type: "tool_use", id: "c1", name: "Grep", input: {} }

  it("builds the tool_output event with the real byte count", () => {
    const ev = toolOutputEvent(tool, "found it")
    expect(ev).toEqual({
      type: "tool_output",
      callId: "c1",
      toolName: "Grep",
      text: "found it",
      truncated: false,
      totalBytes: 8,
    })
  })
})
