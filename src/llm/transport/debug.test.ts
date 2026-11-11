import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { getDiagnosticBus, type LogEvent, Severity } from "../../bus/diagnostic-bus.ts"

import { debugRequestOptions, requestDumpLines } from "./debug.ts"
import type { SendOptions } from "./types.ts"

const REQUEST = {
  model: "test-model",
  maxTokens: 100,
  messages: [
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
    },
  ],
  system: [{ type: "text", text: "system text", cache_control: { type: "ephemeral" } }],
  tools: [{ name: "Read", description: "read a file" }],
  auth: { kind: "api-key", key: "sk-secret-value" },
} as unknown as SendOptions

describe("requestDumpLines", () => {
  it("renders the header and the body preview as plain text", () => {
    expect(requestDumpLines(REQUEST)).toEqual([
      "--- POST test-model ---",
      "  model: test-model",
      "  stream: true",
      "  max_tokens: 100",
      "  request_type: conversation",
      "  Body:",
      "    messages: [2 message(s)]",
      "      user: hello",
      '      assistant [← cached prefix ends here]: "hi"',
      "    system: [1 block(s)]",
      "      block 0 [cached]: system text",
      "    tools: [1 tool(s)]",
      "      Read: read a file",
    ])
  })

  it("has no ANSI escapes and never includes the credential", () => {
    const text = requestDumpLines(REQUEST).join("\n")
    expect(text).not.toContain("\u001b")
    expect(text).not.toContain("sk-secret-value")
  })

  // Regression: a multi-line system block (the real instructions prompt) put
  // raw newlines inside one row. The host's line-anchored `^ {6}` row regex
  // could not match it, so `system: [4 block(s)]` rendered only `block 0` and
  // the other three vanished. Every row must be exactly one line.
  it("keeps every row on a single line even when the source text is multi-line", () => {
    const multi = {
      ...REQUEST,
      system: [
        { type: "text", text: "identity" },
        { type: "text", text: "# Instructions\n\n- Be concise.\n- Be direct." },
        { type: "text", text: "# Tools\n\nPrefer dedicated tools." },
        { type: "text", text: "# Safety\n\nCheckpoint every 50 rounds." },
      ],
    } as unknown as SendOptions

    const lines = requestDumpLines(multi)
    expect(lines.filter((l) => l.includes("\n"))).toEqual([])

    const blocks = lines.filter((l) => /^ {6}block \d/.test(l))
    expect(blocks).toHaveLength(4)
    // The single-line block keeps its text as-is; the three multi-line ones
    // show the collapsed boundaries instead of losing their content.
    expect(blocks[0]).toBe("      block 0: identity")
    expect(blocks.slice(1).every((l) => l.includes("⏎"))).toBe(true)
  })

  it("marks the newlines it collapses so the block structure stays legible", () => {
    const multi = {
      ...REQUEST,
      system: [{ type: "text", text: "line one\nline two" }],
      tools: [],
      messages: [{ role: "user", content: "hi" }],
    } as unknown as SendOptions
    const row = requestDumpLines(multi).find((l) => l.includes("block 0")) ?? ""
    expect(row).toBe("      block 0: line one ⏎ line two")
  })

  // `--verbose` used to be a no-op in the dump: `truncate()` re-checked the
  // global env and ignored the cap argument, so previews stayed cut.
  it("emits a full continuation row when a preview is capped, and none when verbose", () => {
    const long = "x".repeat(300)
    const req = {
      ...REQUEST,
      tools: [{ name: "Mode", description: long }],
      messages: [{ role: "user", content: "hi" }],
      system: [],
    } as unknown as SendOptions

    const capped = requestDumpLines(req, false)
    const rowIndex = capped.findIndex((l) => l.startsWith("      Mode: "))
    expect(capped[rowIndex]).toContain("...(+")
    // The untruncated text follows on its own label-free row.
    expect(capped[rowIndex + 1]).toBe(`        ${long}`)

    const verbose = requestDumpLines(req, true)
    expect(verbose.some((l) => l.includes("...(+"))).toBe(false)
    expect(verbose.filter((l) => l.includes(long))).toHaveLength(1)
  })
})

describe("debugRequestOptions", () => {
  const previous = process.env.DEBUG
  let events: LogEvent[] = []
  let off: () => void = () => {}

  beforeEach(() => {
    events = []
    off = getDiagnosticBus().on("*", (e) => events.push(e))
  })

  afterEach(() => {
    off()
    if (previous === undefined) delete process.env.DEBUG
    else process.env.DEBUG = previous
  })

  it("emits one Debug diagnostic per dump line when DEBUG is set", () => {
    process.env.DEBUG = "1"
    debugRequestOptions(REQUEST)
    expect(events.map((e) => e.message)).toEqual(requestDumpLines(REQUEST))
    expect(events.every((e) => e.severity === Severity.Debug)).toBe(true)
    expect(events.every((e) => e.source === "transport.request-dump")).toBe(true)
  })

  it("emits nothing when DEBUG is unset", () => {
    delete process.env.DEBUG
    debugRequestOptions(REQUEST)
    expect(events).toEqual([])
  })
})
