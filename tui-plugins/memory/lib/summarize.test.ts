/**
 * Tests for {@link summarize}.
 *
 * All tests inject `authProvider` and `sendFn` to avoid hitting the
 * real keychain / API. The system prompt and send options are
 * inspectable via a captured-args helper.
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../../../src/auth.ts"
import type { SendOptions } from "../../../src/client.ts"

import {
  buildSystemPrompt,
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_RATIO,
  MIN_OUTPUT_RATIO,
  summarize,
  SummarizeError,
} from "./summarize.ts"

const FAKE_AUTH: AuthResult = { type: "oauth", token: "test-token", accountUuid: "test-account" }

function captureSendArgs(response: string): {
  sendFn: (opts: SendOptions) => Promise<string>
  calls: SendOptions[]
} {
  const calls: SendOptions[] = []
  const sendFn = async (opts: SendOptions) => {
    calls.push(opts)
    return response
  }
  return { sendFn, calls }
}

// A reasonably-sized input — 600 chars of plausible bullet content
const INPUT_600 = "- ".concat(
  Array.from({ length: 20 }, (_, i) => `[#abc${i}] [2026-05-14T00:00:00-04:00] body ${i}`).join(
    "\n- ",
  ),
)

// A response that comfortably clears MIN_OUTPUT_RATIO (5%) for INPUT_600.
const LONG_ENOUGH_RESPONSE =
  "## Cluster A\n- takeaway one. Sources: #abc1, #abc2\n- takeaway two. Sources: #abc3\n## Cluster B\n- takeaway three. Sources: #abc4, #abc5, #abc6\n"

describe("summarize — happy path", () => {
  it("sends a single user message with the memoryMd as text", async () => {
    const { sendFn, calls } = captureSendArgs(LONG_ENOUGH_RESPONSE)
    await summarize(INPUT_600, { model: "claude-haiku-test", scope: "project" }, {
      authProvider: async () => FAKE_AUTH,
      sendFn,
    })
    expect(calls.length).toBe(1)
    const sent = calls[0]
    expect(sent.messages.length).toBe(1)
    expect(sent.messages[0].role).toBe("user")
    const block = sent.messages[0].content[0] as { type: string; text: string }
    expect(block.type).toBe("text")
    expect(block.text).toBe(INPUT_600)
  })

  it("uses the configured model", async () => {
    const { sendFn, calls } = captureSendArgs(LONG_ENOUGH_RESPONSE)
    await summarize(INPUT_600, { model: "claude-custom", scope: "project" }, {
      authProvider: async () => FAKE_AUTH,
      sendFn,
    })
    expect(calls[0].model).toBe("claude-custom")
  })

  it("sends thinking:false and requestType:title for cheap calls", async () => {
    const { sendFn, calls } = captureSendArgs(LONG_ENOUGH_RESPONSE)
    await summarize(INPUT_600, { model: "claude-haiku-test", scope: "project" }, {
      authProvider: async () => FAKE_AUTH,
      sendFn,
    })
    expect(calls[0].thinking).toBe(false)
    expect(calls[0].requestType).toBe("title")
    expect(calls[0].stream).toBe(false)
  })

  it("returns the trimmed LLM output", async () => {
    const body = "## Cluster A\n- takeaway. Sources: #a, #b\n## Cluster B\n- another. Sources: #c, #d\n## Cluster C\n- third. Sources: #e, #f, #g"
    const response = "  \n" + body + "\n  \n"
    const { sendFn } = captureSendArgs(response)
    const out = await summarize(
      INPUT_600,
      { model: "claude-haiku-test", scope: "project" },
      { authProvider: async () => FAKE_AUTH, sendFn },
    )
    expect(out).toBe(body)
  })
})

describe("summarize — failure modes", () => {
  it("throws SummarizeError kind=auth-failed when auth throws", async () => {
    const { sendFn } = captureSendArgs("does not matter")
    let thrown: unknown
    try {
      await summarize(
        INPUT_600,
        { model: "claude-haiku-test", scope: "project" },
        {
          authProvider: async () => {
            throw new Error("no creds in keychain")
          },
          sendFn,
        },
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SummarizeError)
    expect((thrown as SummarizeError).kind).toBe("auth-failed")
  })

  it("throws SummarizeError kind=send-failed when sendFn throws", async () => {
    let thrown: unknown
    try {
      await summarize(
        INPUT_600,
        { model: "claude-haiku-test", scope: "project" },
        {
          authProvider: async () => FAKE_AUTH,
          sendFn: async () => {
            throw new Error("network down")
          },
        },
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SummarizeError)
    expect((thrown as SummarizeError).kind).toBe("send-failed")
  })

  it("throws SummarizeError kind=timeout when LLM call exceeds timeoutMs", async () => {
    let thrown: unknown
    try {
      await summarize(
        INPUT_600,
        { model: "claude-haiku-test", scope: "project", timeoutMs: 50 },
        {
          authProvider: async () => FAKE_AUTH,
          sendFn: () => new Promise((_resolve) => setTimeout(_resolve, 5000)),
        },
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SummarizeError)
    expect((thrown as SummarizeError).kind).toBe("timeout")
  })

  it("throws SummarizeError kind=empty-output for whitespace-only response", async () => {
    let thrown: unknown
    try {
      await summarize(
        INPUT_600,
        { model: "claude-haiku-test", scope: "project" },
        {
          authProvider: async () => FAKE_AUTH,
          sendFn: async () => "    \n\n   ",
        },
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SummarizeError)
    expect((thrown as SummarizeError).kind).toBe("empty-output")
  })

  it("throws SummarizeError kind=too-short when output < MIN_OUTPUT_RATIO of input", async () => {
    const inputLen = INPUT_600.length
    const tooShort = "x".repeat(Math.floor(inputLen * MIN_OUTPUT_RATIO) - 1)
    let thrown: unknown
    try {
      await summarize(
        INPUT_600,
        { model: "claude-haiku-test", scope: "project" },
        {
          authProvider: async () => FAKE_AUTH,
          sendFn: async () => tooShort,
        },
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SummarizeError)
    expect((thrown as SummarizeError).kind).toBe("too-short")
  })

  it("throws SummarizeError kind=too-long when output > input length", async () => {
    const tooLong = INPUT_600 + "x".repeat(10)
    let thrown: unknown
    try {
      await summarize(
        INPUT_600,
        { model: "claude-haiku-test", scope: "project" },
        {
          authProvider: async () => FAKE_AUTH,
          sendFn: async () => tooLong,
        },
      )
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(SummarizeError)
    expect((thrown as SummarizeError).kind).toBe("too-long")
  })
})

describe("buildSystemPrompt", () => {
  it("contains the scope-specific framing for project", () => {
    const sp = buildSystemPrompt("project")
    expect(sp).toContain("this codebase")
    expect(sp).not.toContain("across any project")
  })

  it("contains the scope-specific framing for global", () => {
    const sp = buildSystemPrompt("global")
    expect(sp).toContain("across any project")
    expect(sp).not.toContain("this codebase")
  })

  it("instructs the model to cite ids", () => {
    const sp = buildSystemPrompt("project")
    expect(sp).toMatch(/Sources: ?#id/)
  })

  it("forbids inventing facts", () => {
    const sp = buildSystemPrompt("project")
    expect(sp.toLowerCase()).toContain("do not invent")
  })

  it("forbids verbatim copying", () => {
    const sp = buildSystemPrompt("project")
    expect(sp).toMatch(/distill|do not include.*verbatim/i)
  })
})

describe("constants", () => {
  it("DEFAULT_TIMEOUT_MS is reasonable for session start", () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000)
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })

  it("MIN_OUTPUT_RATIO < MAX_OUTPUT_RATIO and within (0, 1]", () => {
    expect(MIN_OUTPUT_RATIO).toBeGreaterThan(0)
    expect(MAX_OUTPUT_RATIO).toBeLessThanOrEqual(1)
    expect(MIN_OUTPUT_RATIO).toBeLessThan(MAX_OUTPUT_RATIO)
  })
})
