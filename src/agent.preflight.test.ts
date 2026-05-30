/**
 * End-to-end integration test for the preflight pipeline inside
 * `Agent.run()`.
 *
 * Wires a real Anthropic provider registration + a stubbed sendFn + a
 * stubbed askUser callback, then drives `agent.run()` and asserts that:
 *
 *  - clean messages → no askUser call
 *  - mismatched thinking → askUser called exactly once; chosen option
 *    is applied to the messages BEFORE sendFn sees them
 *  - SWITCH option mutates `this.model`
 *  - user cancel throws AbortError
 *
 * @module agent.preflight.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import {
  bootstrapAnthropic,
  ISSUE_THINKING_MODEL_MISMATCH,
  OPTION_CANCEL,
  OPTION_STRIP,
  OPTION_SWITCH_PREFIX,
} from "../plugins/llm-anthropic/index.ts"
import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth.ts"
import type { Message, SendOptions, StreamedResponse } from "./client.ts"
import { clearModelRegistry, clearProviderRegistry } from "./llm/model-registry.ts"

const SIG_OPUS_4_7 =
  "EpUCCmMIDhgCKkAQrL0+hYeX1InhE2rPG/evDayIGjau7OuNGrVEhuuiHcjsNUMYeem+GdGa4uQZ0CSkPrBTu8RJV+0raNJqsAnnMg9jbGF1ZGUtb3B1cy00LTc4AEIIdGhpbmtpbmcSDG1OckwAeikdLQCZEBoMDqfO3jopjAX7TWK9IjCw9AXe8/qt/3o2D1cwTAA1KhBgQ9CHLqnxc2dc2DgVBaSuqU68CGodJjuTDNQ+Q9AqYDmahuPBysrWI+MW+edm+yueb3OO5LhhBJ0JXtoEezP0Fmz5NCdNL1mqh9XE0AxQLbztg6bc4GIAq9dCir4xqQaYIQMO86wzNY9WJQzHSLjv+CVsvLziTsDf/YmakkAUxRgB"

interface CapturedSend {
  modelId: string | undefined
  messages: Message[]
}

function makeAuth(): AuthResult {
  return { type: "api-key", token: "test-token" }
}

function makeSendFn(captured: CapturedSend[]) {
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    captured.push({
      modelId: opts.model,
      messages: structuredClone(opts.messages),
    })
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

function staleAssistant(): Message {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "old thoughts", signature: SIG_OPUS_4_7 },
      { type: "text", text: "old reply" },
    ],
  }
}

describe("Agent.run preflight integration", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
  })

  it("no askUser → no preflight at all; old thinking blocks are sent as-is", async () => {
    bootstrapAnthropic()
    const captured: CapturedSend[] = []
    const agent = new Agent({
      auth: makeAuth(),
      model: "claude-opus-4-8",
      sendFn: makeSendFn(captured),
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "previous" }] },
        staleAssistant(),
      ],
    })

    for await (const _ of agent.run("hi")) {
      // drain
    }

    expect(captured).toHaveLength(1)
    const asst = captured[0]?.messages[1]
    const types = Array.isArray(asst?.content) ? asst.content.map((b) => b.type) : []
    // Without preflight, the thinking block is sent verbatim.
    expect(types).toContain("thinking")
  })

  it("askUser + clean messages → askUser is never called", async () => {
    bootstrapAnthropic()
    const captured: CapturedSend[] = []
    let askCalls = 0
    const agent = new Agent({
      auth: makeAuth(),
      model: "claude-opus-4-8",
      sendFn: makeSendFn(captured),
    })

    for await (const _ of agent.run("hi", {
      askUser: async () => {
        askCalls++
        return null
      },
    })) {
      // drain
    }

    expect(askCalls).toBe(0)
    expect(captured).toHaveLength(1)
  })

  it("askUser + mismatch + STRIP → sendFn sees stripped messages, same model", async () => {
    bootstrapAnthropic()
    const captured: CapturedSend[] = []
    let askCalls = 0
    let seenIssueCode = ""

    const agent = new Agent({
      auth: makeAuth(),
      model: "claude-opus-4-8",
      sendFn: makeSendFn(captured),
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        staleAssistant(),
      ],
    })

    for await (const _ of agent.run("hi", {
      askUser: async (issue) => {
        askCalls++
        seenIssueCode = issue.code
        return OPTION_STRIP
      },
    })) {
      // drain
    }

    expect(askCalls).toBe(1)
    expect(seenIssueCode).toBe(ISSUE_THINKING_MODEL_MISMATCH)
    expect(captured).toHaveLength(1)
    const sent = captured[0]
    expect(sent?.modelId).toBe("claude-opus-4-8") // unchanged
    // Stale assistant is the SECOND message in history; its thinking
    // block should be gone from what sendFn received.
    const asst = sent?.messages[1]
    const types = Array.isArray(asst?.content) ? asst.content.map((b) => b.type) : []
    expect(types).toEqual(["text"])
  })

  it("askUser + mismatch + SWITCH → agent.model updates and sendFn sees new model", async () => {
    bootstrapAnthropic()
    const captured: CapturedSend[] = []

    const agent = new Agent({
      auth: makeAuth(),
      model: "claude-opus-4-8",
      sendFn: makeSendFn(captured),
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        staleAssistant(),
      ],
    })

    for await (const _ of agent.run("hi", {
      askUser: async () => `${OPTION_SWITCH_PREFIX}claude-opus-4-7`,
    })) {
      // drain
    }

    expect(captured).toHaveLength(1)
    expect(captured[0]?.modelId).toBe("claude-opus-4-7")
    // Agent's internal model also updated for future turns.
    expect((agent as unknown as { model: string }).model).toBe("claude-opus-4-7")
    // Thinking block preserved (we kept the original model).
    const asst = captured[0]?.messages[1]
    const types = Array.isArray(asst?.content) ? asst.content.map((b) => b.type) : []
    expect(types).toContain("thinking")
  })

  it("askUser + mismatch + CANCEL → throws AbortError; sendFn never called", async () => {
    bootstrapAnthropic()
    const captured: CapturedSend[] = []

    const agent = new Agent({
      auth: makeAuth(),
      model: "claude-opus-4-8",
      sendFn: makeSendFn(captured),
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        staleAssistant(),
      ],
    })

    let threwAbort = false
    try {
      for await (const _ of agent.run("hi", {
        askUser: async () => OPTION_CANCEL,
      })) {
        // drain
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") threwAbort = true
      else throw err
    }
    expect(threwAbort).toBe(true)
    expect(captured).toHaveLength(0)
  })

  it("askUser + mismatch + askUser returns null → throws AbortError", async () => {
    bootstrapAnthropic()
    const captured: CapturedSend[] = []

    const agent = new Agent({
      auth: makeAuth(),
      model: "claude-opus-4-8",
      sendFn: makeSendFn(captured),
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "first" }] },
        staleAssistant(),
      ],
    })

    let threwAbort = false
    try {
      for await (const _ of agent.run("hi", { askUser: async () => null })) {
        // drain
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") threwAbort = true
      else throw err
    }
    expect(threwAbort).toBe(true)
  })
})
