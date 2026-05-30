/**
 * Tests for `preflight-pipeline.ts` — the legacy↔canonical bridge that
 * the agent loop wraps around each sendFn call.
 *
 * Covers:
 *  - clean request (no provider issues) round-trips messages + model id
 *  - mismatch issue → user picks STRIP → messages stripped, same model
 *  - mismatch issue → user picks SWITCH → messages preserved, new model
 *  - mismatch issue → user Esc'd → cancelled = true, originals returned
 *  - explicit cancel option → cancelled = true
 *  - askUser is called once per issue
 *
 * @module agent/preflight-pipeline.test
 */

import { afterEach, describe, expect, test } from "bun:test"

import type { Message } from "../client.ts"
import {
  bootstrapAnthropic,
  ISSUE_THINKING_MODEL_MISMATCH,
  OPTION_CANCEL,
  OPTION_STRIP,
  OPTION_SWITCH_PREFIX,
} from "../../plugins/llm-anthropic/index.ts"
import { clearModelRegistry, clearProviderRegistry } from "../llm/model-registry.ts"

import { runPreflightPipeline } from "./preflight-pipeline.ts"

const SIG_OPUS_4_7 =
  "EpUCCmMIDhgCKkAQrL0+hYeX1InhE2rPG/evDayIGjau7OuNGrVEhuuiHcjsNUMYeem+GdGa4uQZ0CSkPrBTu8RJV+0raNJqsAnnMg9jbGF1ZGUtb3B1cy00LTc4AEIIdGhpbmtpbmcSDG1OckwAeikdLQCZEBoMDqfO3jopjAX7TWK9IjCw9AXe8/qt/3o2D1cwTAA1KhBgQ9CHLqnxc2dc2DgVBaSuqU68CGodJjuTDNQ+Q9AqYDmahuPBysrWI+MW+edm+yueb3OO5LhhBJ0JXtoEezP0Fmz5NCdNL1mqh9XE0AxQLbztg6bc4GIAq9dCir4xqQaYIQMO86wzNY9WJQzHSLjv+CVsvLziTsDf/YmakkAUxRgB"

function makeMessages(opts: { withMismatch: boolean }): Message[] {
  if (!opts.withMismatch) {
    return [{ role: "user", content: [{ type: "text", text: "hi" }] }]
  }
  return [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "old reasoning", signature: SIG_OPUS_4_7 },
        { type: "text", text: "ok" },
      ],
    },
  ]
}

describe("runPreflightPipeline", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
  })

  test("no provider registered → no issues, round-trips inputs", async () => {
    let askCalls = 0
    const out = await runPreflightPipeline({
      messages: makeMessages({ withMismatch: false }),
      modelId: "claude-opus-4-8",
      askUser: async () => {
        askCalls++
        return null
      },
    })
    expect(askCalls).toBe(0)
    expect(out.cancelled).toBe(false)
    expect(out.modelId).toBe("claude-opus-4-8")
  })

  test("provider registered, clean messages → no issues", async () => {
    bootstrapAnthropic()
    let askCalls = 0
    const out = await runPreflightPipeline({
      messages: makeMessages({ withMismatch: false }),
      modelId: "claude-opus-4-8",
      askUser: async () => {
        askCalls++
        return null
      },
    })
    expect(askCalls).toBe(0)
    expect(out.cancelled).toBe(false)
    expect(out.modelId).toBe("claude-opus-4-8")
    expect(out.adoptModelId).toBeUndefined()
  })

  test("mismatch + STRIP → strips thinking, same model", async () => {
    bootstrapAnthropic()
    const msgs = makeMessages({ withMismatch: true })
    let askCalls = 0
    let seenIssueCode = ""
    const out = await runPreflightPipeline({
      messages: msgs,
      modelId: "claude-opus-4-8",
      askUser: async (issue) => {
        askCalls++
        seenIssueCode = issue.code
        return OPTION_STRIP
      },
    })
    expect(askCalls).toBe(1)
    expect(seenIssueCode).toBe(ISSUE_THINKING_MODEL_MISMATCH)
    expect(out.cancelled).toBe(false)
    expect(out.modelId).toBe("claude-opus-4-8")
    expect(out.adoptModelId).toBeUndefined()
    // Stripped: only text block remains in the assistant message.
    const asst = out.messages[1]
    expect(asst?.role).toBe("assistant")
    const blocks = Array.isArray(asst?.content) ? asst.content : []
    expect(blocks.map((b) => b.type)).toEqual(["text"])
  })

  test("mismatch + SWITCH → adopts model, preserves thinking", async () => {
    bootstrapAnthropic()
    const msgs = makeMessages({ withMismatch: true })
    const out = await runPreflightPipeline({
      messages: msgs,
      modelId: "claude-opus-4-8",
      askUser: async () => `${OPTION_SWITCH_PREFIX}claude-opus-4-7`,
    })
    expect(out.cancelled).toBe(false)
    expect(out.modelId).toBe("claude-opus-4-7")
    expect(out.adoptModelId).toBe("claude-opus-4-7")
    const asst = out.messages[1]
    const blocks = Array.isArray(asst?.content) ? asst.content : []
    // Thinking + text both still there.
    expect(blocks.map((b) => b.type)).toEqual(["thinking", "text"])
  })

  test("mismatch + user-cancel (askUser returns null) → cancelled", async () => {
    bootstrapAnthropic()
    const msgs = makeMessages({ withMismatch: true })
    const out = await runPreflightPipeline({
      messages: msgs,
      modelId: "claude-opus-4-8",
      askUser: async () => null,
    })
    expect(out.cancelled).toBe(true)
    // Originals returned untouched.
    expect(out.messages).toBe(msgs)
    expect(out.modelId).toBe("claude-opus-4-8")
  })

  test("mismatch + explicit CANCEL option → cancelled", async () => {
    bootstrapAnthropic()
    const msgs = makeMessages({ withMismatch: true })
    const out = await runPreflightPipeline({
      messages: msgs,
      modelId: "claude-opus-4-8",
      askUser: async () => OPTION_CANCEL,
    })
    expect(out.cancelled).toBe(true)
    expect(out.messages).toBe(msgs)
  })

  test("askUser receives the full issue, including detail + options", async () => {
    bootstrapAnthropic()
    const msgs = makeMessages({ withMismatch: true })
    type Capture = { code: string; title: string; detail: string; optCount: number }
    let captured: Capture | null = null
    await runPreflightPipeline({
      messages: msgs,
      modelId: "claude-opus-4-8",
      askUser: async (issue) => {
        captured = {
          code: issue.code,
          title: issue.title,
          detail: issue.detail,
          optCount: issue.options.length,
        } as Capture
        return null
      },
    })
    expect(captured).not.toBeNull()
    const c = captured as unknown as Capture
    expect(c.code).toBe(ISSUE_THINKING_MODEL_MISMATCH)
    expect(c.title).toMatch(/different model/i)
    expect(c.optCount).toBe(3)
  })

  test("does not mutate the input messages array", async () => {
    bootstrapAnthropic()
    const msgs = makeMessages({ withMismatch: true })
    const before = JSON.stringify(msgs)
    await runPreflightPipeline({
      messages: msgs,
      modelId: "claude-opus-4-8",
      askUser: async () => OPTION_STRIP,
    })
    expect(JSON.stringify(msgs)).toBe(before)
  })
})
