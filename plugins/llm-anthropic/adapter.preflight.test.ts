/**
 * Adapter-level integration tests for the preflight pipeline.
 *
 * Validates that the canonical preflight contract (`preflight` +
 * `applyResolution`) is correctly wired from the adapter to the
 * Anthropic-specific helpers in `./thinking-preflight.ts`, AND that
 * the `runPreflight` / `applyPreflightResolution` wrappers in the
 * canonical layer can dispatch through it after a real registration.
 *
 * @module llm/providers/anthropic/adapter.preflight.test
 */

import { afterEach, describe, expect, test } from "bun:test"

import { clearModelRegistry, clearProviderRegistry } from "../../src/llm/model-registry.ts"
import { applyPreflightResolution, runPreflight } from "../../src/llm/preflight.ts"

import { anthropicAdapter, bootstrapAnthropic } from "./adapter.ts"
import {
  ISSUE_THINKING_MODEL_MISMATCH,
  OPTION_CANCEL,
  OPTION_STRIP,
  OPTION_SWITCH_PREFIX,
} from "./thinking-preflight.ts"

const SIG_OPUS_4_7 =
  "EpUCCmMIDhgCKkAQrL0+hYeX1InhE2rPG/evDayIGjau7OuNGrVEhuuiHcjsNUMYeem+GdGa4uQZ0CSkPrBTu8RJV+0raNJqsAnnMg9jbGF1ZGUtb3B1cy00LTc4AEIIdGhpbmtpbmcSDG1OckwAeikdLQCZEBoMDqfO3jopjAX7TWK9IjCw9AXe8/qt/3o2D1cwTAA1KhBgQ9CHLqnxc2dc2DgVBaSuqU68CGodJjuTDNQ+Q9AqYDmahuPBysrWI+MW+edm+yueb3OO5LhhBJ0JXtoEezP0Fmz5NCdNL1mqh9XE0AxQLbztg6bc4GIAq9dCir4xqQaYIQMO86wzNY9WJQzHSLjv+CVsvLziTsDf/YmakkAUxRgB"

function buildReq(modelId = "claude-opus-4-8") {
  return {
    modelId,
    messages: [
      { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      {
        role: "assistant" as const,
        content: [
          { type: "thinking" as const, text: "...", signature: SIG_OPUS_4_7 },
          { type: "text" as const, text: "ok" },
        ],
      },
    ],
  }
}

describe("anthropicAdapter.preflight", () => {
  test("returns [] when no thinking mismatches", () => {
    const req = {
      modelId: "claude-opus-4-8",
      messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
    }
    expect(anthropicAdapter.preflight?.(req, { id: "claude-opus-4-8" } as never) ?? []).toEqual([])
  })

  test("returns one mismatch issue when stale signatures are present", () => {
    const req = buildReq("claude-opus-4-8")
    const issues = anthropicAdapter.preflight?.(req, { id: "claude-opus-4-8" } as never) ?? []
    expect(issues).toHaveLength(1)
    const issue = issues[0]
    expect(issue?.code).toBe(ISSUE_THINKING_MODEL_MISMATCH)
    expect(issue?.options.map((o) => o.id)).toEqual([
      OPTION_STRIP,
      `${OPTION_SWITCH_PREFIX}claude-opus-4-7`,
      OPTION_CANCEL,
    ])
  })
})

describe("anthropicAdapter.applyResolution", () => {
  test("STRIP option returns modify-request with stripped messages", () => {
    const req = buildReq()
    const res = anthropicAdapter.applyResolution!(req, ISSUE_THINKING_MODEL_MISMATCH, OPTION_STRIP)
    expect(res.kind).toBe("modify-request")
    if (res.kind !== "modify-request") return
    expect(res.request.messages).toHaveLength(2)
    const asst = res.request.messages[1]
    const types = Array.isArray(asst?.content) ? asst.content.map((b) => b.type) : []
    expect(types).toEqual(["text"])
    expect(res.adoptModelId).toBeUndefined()
  })

  test("SWITCH option returns modify-request with adoptModelId", () => {
    const req = buildReq()
    const res = anthropicAdapter.applyResolution!(
      req,
      ISSUE_THINKING_MODEL_MISMATCH,
      `${OPTION_SWITCH_PREFIX}claude-opus-4-7`,
    )
    expect(res.kind).toBe("modify-request")
    if (res.kind !== "modify-request") return
    expect(res.adoptModelId).toBe("claude-opus-4-7")
    const asst = res.request.messages[1]
    const types = Array.isArray(asst?.content) ? asst.content.map((b) => b.type) : []
    expect(types).toEqual(["thinking", "text"])
  })

  test("CANCEL option returns cancel", () => {
    const req = buildReq()
    const res = anthropicAdapter.applyResolution!(req, ISSUE_THINKING_MODEL_MISMATCH, OPTION_CANCEL)
    expect(res.kind).toBe("cancel")
  })

  test("unknown issue code throws", () => {
    const req = buildReq()
    expect(() => anthropicAdapter.applyResolution!(req, "x.unrelated", OPTION_STRIP)).toThrow(
      /unknown issue code/,
    )
  })

  test("unknown option id throws", () => {
    const req = buildReq()
    expect(() =>
      anthropicAdapter.applyResolution!(req, ISSUE_THINKING_MODEL_MISMATCH, "made-up"),
    ).toThrow(/unknown option id/)
  })
})

// End-to-end: runPreflight + applyPreflightResolution through a real
// registration of the Anthropic adapter + its model catalog.
describe("adapter + canonical preflight wrapper (e2e)", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
  })

  test("runPreflight resolves anthropic → adapter and surfaces the issue", () => {
    bootstrapAnthropic()
    const req = buildReq("claude-opus-4-8")
    const issues = runPreflight(req)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.code).toBe(ISSUE_THINKING_MODEL_MISMATCH)
  })

  test("applyPreflightResolution round-trips STRIP", () => {
    bootstrapAnthropic()
    const req = buildReq("claude-opus-4-8")
    const res = applyPreflightResolution(req, ISSUE_THINKING_MODEL_MISMATCH, OPTION_STRIP)
    expect(res.kind).toBe("modify-request")
  })

  test("applyPreflightResolution round-trips SWITCH with adoptModelId", () => {
    bootstrapAnthropic()
    const req = buildReq("claude-opus-4-8")
    const res = applyPreflightResolution(
      req,
      ISSUE_THINKING_MODEL_MISMATCH,
      `${OPTION_SWITCH_PREFIX}claude-opus-4-7`,
    )
    expect(res.kind).toBe("modify-request")
    if (res.kind !== "modify-request") return
    expect(res.adoptModelId).toBe("claude-opus-4-7")
  })
})
