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
