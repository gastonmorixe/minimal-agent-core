/**
 * Tests for `thinking-preflight.ts` — Anthropic's preflight logic for
 * detecting model-mismatched thinking blocks and applying the user's
 * resolution.
 *
 * Uses real signatures captured from session cc53c9fe (the actual bug
 * report) plus synthetic shapes for edge cases.
 *
 * @module llm/providers/anthropic/thinking-preflight.test
 */

import { describe, expect, test } from "bun:test"

import type { CanonicalMessage } from "../../src/llm/canonical-messages.ts"
import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"

import {
  applyMismatchResolution,
  buildMismatchIssue,
  findThinkingMismatches,
  ISSUE_THINKING_MODEL_MISMATCH,
  normalizeModelId,
  OPTION_CANCEL,
  OPTION_STRIP,
  OPTION_SWITCH_PREFIX,
  stripThinkingBlocks,
} from "./thinking-preflight.ts"

// Real signatures from cc53c9fe-7f91-45cd-91c4-6f3ddc74e20b.jsonl.
const SIG_OPUS_4_7 =
  "EpUCCmMIDhgCKkAQrL0+hYeX1InhE2rPG/evDayIGjau7OuNGrVEhuuiHcjsNUMYeem+GdGa4uQZ0CSkPrBTu8RJV+0raNJqsAnnMg9jbGF1ZGUtb3B1cy00LTc4AEIIdGhpbmtpbmcSDG1OckwAeikdLQCZEBoMDqfO3jopjAX7TWK9IjCw9AXe8/qt/3o2D1cwTAA1KhBgQ9CHLqnxc2dc2DgVBaSuqU68CGodJjuTDNQ+Q9AqYDmahuPBysrWI+MW+edm+yueb3OO5LhhBJ0JXtoEezP0Fmz5NCdNL1mqh9XE0AxQLbztg6bc4GIAq9dCir4xqQaYIQMO86wzNY9WJQzHSLjv+CVsvLziTsDf/YmakkAUxRgB"

const SIG_OPUS_4_8 =
  "EsoCCmMIDhgCKkCg3zHIYqE7PGjs0sXXx0WnzdaGrK9KWQcvg/dzaVhCgroOSFq6QoCXzfQkMTEd3BxKdjROwTr5RnEGjKfYTB9gMg9jbGF1ZGUtb3B1cy00LTg4AEIIdGhpbmtpbmcSDNDCE09b7dmEAIiL/xoMqTv4VdY27mgG2KJcIjDE834tb7K5j8hvYKEFhOMg2CK7owhNniW31Txp4TjDB/SK2gNlrvOFJlBvBVRYoqoqlAF1lO2FGpXAprB2W8WJhC2SnqNWg9Au7EVTJ8oWwxXt4eq1JQzUNt9AcEwq700UpU2WU5QOR2m7L3ISarGx1Z1rmQmLsy9NRPg5U0foLr8DQYJt4Ad5ZkQ/wTMN7zc9o+597T0GOR6VfyAoliGgx5jQyWQthodz2qHvmAODtClEr8SWU0D8ui4CMgeTdVCSTUg8BgaFGAE="

function makeReq(messages: CanonicalMessage[], modelId = "claude-opus-4-8"): CanonicalRequest {
  return { modelId, messages }
}

function assistantWithThinking(sigs: string[]): CanonicalMessage {
  return {
    role: "assistant",
    content: [
      ...sigs.map((s) => ({ type: "thinking" as const, text: "...", signature: s })),
      { type: "text", text: "ok" },
    ],
  }
}

describe("findThinkingMismatches", () => {
  test("empty messages → no mismatches", () => {
    expect(findThinkingMismatches([], "claude-opus-4-8")).toEqual([])
  })

  test("user-only messages → no mismatches", () => {
    const msgs: CanonicalMessage[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]
    expect(findThinkingMismatches(msgs, "claude-opus-4-8")).toEqual([])
  })

  test("assistant without thinking blocks → no mismatches", () => {
    const msgs: CanonicalMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "no thinking here" }] },
    ]
    expect(findThinkingMismatches(msgs, "claude-opus-4-8")).toEqual([])
  })

  test("matching model signature → no mismatch", () => {
    const msgs: CanonicalMessage[] = [assistantWithThinking([SIG_OPUS_4_8])]
    expect(findThinkingMismatches(msgs, "claude-opus-4-8")).toEqual([])
  })

  test("matching with [1m] suffix on target → no mismatch", () => {
    const msgs: CanonicalMessage[] = [assistantWithThinking([SIG_OPUS_4_8])]
    expect(findThinkingMismatches(msgs, "claude-opus-4-8[1m]")).toEqual([])
  })

  test("opus-4-7 signature with opus-4-8 target → one mismatch", () => {
    const msgs: CanonicalMessage[] = [assistantWithThinking([SIG_OPUS_4_7])]
    const out = findThinkingMismatches(msgs, "claude-opus-4-8")
    expect(out).toHaveLength(1)
    expect(out[0]?.messageIndex).toBe(0)
    expect(out[0]?.blockIndex).toBe(0)
    expect(out[0]?.signedByModel).toBe("claude-opus-4-7")
  })

  test("mixed signatures: only the wrong-model ones flagged", () => {
    const msgs: CanonicalMessage[] = [
      assistantWithThinking([SIG_OPUS_4_7, SIG_OPUS_4_8, SIG_OPUS_4_7]),
    ]
    const out = findThinkingMismatches(msgs, "claude-opus-4-8")
    expect(out).toHaveLength(2)
    expect(out.map((m) => m.blockIndex)).toEqual([0, 2])
  })

  test("multiple assistant messages, indices preserved", () => {
    const msgs: CanonicalMessage[] = [
      { role: "user", content: [{ type: "text", text: "a" }] },
      assistantWithThinking([SIG_OPUS_4_7]),
      { role: "user", content: [{ type: "text", text: "b" }] },
      assistantWithThinking([SIG_OPUS_4_7, SIG_OPUS_4_7]),
    ]
    const out = findThinkingMismatches(msgs, "claude-opus-4-8")
    expect(out.map((m) => ({ mi: m.messageIndex, bi: m.blockIndex }))).toEqual([
      { mi: 1, bi: 0 },
      { mi: 3, bi: 0 },
      { mi: 3, bi: 1 },
    ])
  })

  test("thinking block without signature → ignored", () => {
    const msgs: CanonicalMessage[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", text: "...", signature: undefined as unknown as string }],
      },
    ]
    expect(findThinkingMismatches(msgs, "claude-opus-4-8")).toEqual([])
  })

  test("thinking block with un-decodable signature → ignored", () => {
    const msgs: CanonicalMessage[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", text: "...", signature: "not-decodable" }],
      },
    ]
    expect(findThinkingMismatches(msgs, "claude-opus-4-8")).toEqual([])
  })

  test("simulates cc53c9fe shape: 22 thinking blocks across 33 assistants", () => {
    // Reduced shape but representative: 16 blocks signed by 4-7 +
    // 6 blocks signed by 4-8 spread across alternating assistants.
    const messages: CanonicalMessage[] = []
    let asstCount = 0
    let oldSigs = 0
    let newSigs = 0
    while (oldSigs + newSigs < 22) {
      messages.push({ role: "user", content: [{ type: "text", text: "u" }] })
      const sigs: string[] = []
      // Toggle old/new to roughly mirror "block 1-16 are 4-7, 17-22 are 4-8".
      while (oldSigs < 16 && sigs.length < 3) {
        sigs.push(SIG_OPUS_4_7)
        oldSigs++
      }
      while (newSigs < 6 && sigs.length < 3 && oldSigs >= 16) {
        sigs.push(SIG_OPUS_4_8)
        newSigs++
      }
      messages.push(assistantWithThinking(sigs))
      asstCount++
      if (asstCount > 50) break // safety
    }
    const out = findThinkingMismatches(messages, "claude-opus-4-8")
    expect(out).toHaveLength(16)
    expect(out.every((m) => m.signedByModel === "claude-opus-4-7")).toBe(true)
  })
})

describe("normalizeModelId", () => {
  test("strips [1m] suffix", () => {
    expect(normalizeModelId("claude-opus-4-8[1m]")).toBe("claude-opus-4-8")
  })
  test("strips [2m] suffix", () => {
    expect(normalizeModelId("claude-sonnet-4-6[2m]")).toBe("claude-sonnet-4-6")
  })
  test("leaves bare id alone", () => {
    expect(normalizeModelId("claude-opus-4-7")).toBe("claude-opus-4-7")
  })
  test("case-insensitive on suffix", () => {
    expect(normalizeModelId("claude-opus-4-8[1M]")).toBe("claude-opus-4-8")
  })
})

describe("buildMismatchIssue", () => {
  test("throws on empty mismatches", () => {
    expect(() => buildMismatchIssue([], "claude-opus-4-8")).toThrow(/non-empty/)
  })

  test("single-signer issue has strip + one switch + cancel", () => {
    const issue = buildMismatchIssue(
      [{ messageIndex: 1, blockIndex: 0, signedByModel: "claude-opus-4-7" }],
      "claude-opus-4-8",
    )
    expect(issue.code).toBe(ISSUE_THINKING_MODEL_MISMATCH)
    expect(issue.title).toContain("different model")
    expect(issue.detail).toContain("claude-opus-4-7")
    expect(issue.detail).toContain("claude-opus-4-8")
    expect(issue.options.map((o) => o.id)).toEqual([
      OPTION_STRIP,
      `${OPTION_SWITCH_PREFIX}claude-opus-4-7`,
      OPTION_CANCEL,
    ])
    // Strip is default and destructive.
    const strip = issue.options.find((o) => o.id === OPTION_STRIP)
    expect(strip?.isDefault).toBe(true)
    expect(strip?.destructive).toBe(true)
  })

  test("multiple signers: switch options ordered by frequency", () => {
    const mismatches = [
      { messageIndex: 1, blockIndex: 0, signedByModel: "claude-opus-4-5" },
      { messageIndex: 2, blockIndex: 0, signedByModel: "claude-opus-4-7" },
      { messageIndex: 3, blockIndex: 0, signedByModel: "claude-opus-4-7" },
      { messageIndex: 4, blockIndex: 0, signedByModel: "claude-opus-4-7" },
      { messageIndex: 5, blockIndex: 0, signedByModel: "claude-opus-4-5" },
    ]
    const issue = buildMismatchIssue(mismatches, "claude-opus-4-8")
    // claude-opus-4-7 has 3 blocks, claude-opus-4-5 has 2.
    expect(issue.options.map((o) => o.id)).toEqual([
      OPTION_STRIP,
      `${OPTION_SWITCH_PREFIX}claude-opus-4-7`,
      `${OPTION_SWITCH_PREFIX}claude-opus-4-5`,
      OPTION_CANCEL,
    ])
  })

  test("target [1m] suffix is normalized in the detail text", () => {
    const issue = buildMismatchIssue(
      [{ messageIndex: 1, blockIndex: 0, signedByModel: "claude-opus-4-7" }],
      "claude-opus-4-8[1m]",
    )
    // The detail should reference the BASE id, not the [1m] form.
    expect(issue.detail).toContain("claude-opus-4-8")
    expect(issue.detail).not.toContain("[1m]")
  })

  test("issue carries a default selection", () => {
    const issue = buildMismatchIssue(
      [{ messageIndex: 1, blockIndex: 0, signedByModel: "claude-opus-4-7" }],
      "claude-opus-4-8",
    )
    expect(issue.options.filter((o) => o.isDefault === true)).toHaveLength(1)
  })
})

describe("stripThinkingBlocks", () => {
  test("removes thinking blocks from assistant messages", () => {
    const msgs: CanonicalMessage[] = [assistantWithThinking([SIG_OPUS_4_7, SIG_OPUS_4_8])]
    const out = stripThinkingBlocks(msgs)
    const first = out[0]
    expect(first?.role).toBe("assistant")
    expect(Array.isArray(first?.content) ? first.content : []).toEqual([
      { type: "text", text: "ok" },
    ])
  })

  test("preserves text + tool_use + tool_result blocks", () => {
    const msgs: CanonicalMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "...", signature: SIG_OPUS_4_7 },
          { type: "text", text: "thought about it" },
          { type: "tool_use", id: "x1", name: "Bash", input: { cmd: "ls" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "x1",
            content: [{ type: "text", text: "ok" }],
          },
        ],
      },
    ]
    const out = stripThinkingBlocks(msgs)
    const asstContent = Array.isArray(out[0]?.content) ? out[0].content : []
    expect(asstContent.map((b) => b.type)).toEqual(["text", "tool_use"])
    const userContent = Array.isArray(out[1]?.content) ? out[1].content : []
    expect(userContent.map((b) => b.type)).toEqual(["tool_result"])
  })

  test("returns the same array contents when no thinking blocks present", () => {
    const msgs: CanonicalMessage[] = [
      { role: "assistant", content: [{ type: "text", text: "hi" }] },
    ]
    const out = stripThinkingBlocks(msgs)
    expect(out).toEqual(msgs)
  })

  test("does not mutate the input", () => {
    const original: CanonicalMessage[] = [assistantWithThinking([SIG_OPUS_4_7])]
    const snapshot = JSON.stringify(original)
    stripThinkingBlocks(original)
    expect(JSON.stringify(original)).toBe(snapshot)
  })

  test("non-array content (string) is passed through unchanged", () => {
    const msgs: CanonicalMessage[] = [
      { role: "user", content: [{ type: "text", text: "string-y" }] },
    ]
    expect(stripThinkingBlocks(msgs)).toEqual(msgs)
  })
})

describe("applyMismatchResolution", () => {
  function buildReq(): CanonicalRequest {
    return makeReq(
      [
        { role: "user", content: [{ type: "text", text: "hello" }] },
        assistantWithThinking([SIG_OPUS_4_7]),
      ],
      "claude-opus-4-8",
    )
  }

  test("OPTION_STRIP returns modified request with stripped messages", () => {
    const out = applyMismatchResolution(buildReq(), OPTION_STRIP)
    expect(out.kind).toBe("modify-request")
    if (out.kind !== "modify-request") return
    expect(out.messages).toHaveLength(2)
    const asst = out.messages[1]
    expect(Array.isArray(asst?.content) ? asst.content.map((b) => b.type) : []).toEqual(["text"])
    expect(out.adoptModelId).toBeUndefined()
  })

  test("OPTION_CANCEL returns cancel", () => {
    expect(applyMismatchResolution(buildReq(), OPTION_CANCEL)).toEqual({ kind: "cancel" })
  })

  test("switch:<modelId> adopts the model without stripping", () => {
    const out = applyMismatchResolution(buildReq(), `${OPTION_SWITCH_PREFIX}claude-opus-4-7`)
    expect(out.kind).toBe("modify-request")
    if (out.kind !== "modify-request") return
    expect(out.adoptModelId).toBe("claude-opus-4-7")
    // Messages still carry the thinking block.
    const asst = out.messages[1]
    const types = Array.isArray(asst?.content) ? asst.content.map((b) => b.type) : []
    expect(types).toContain("thinking")
  })

  test("switch with empty model id → unknown-option", () => {
    const out = applyMismatchResolution(buildReq(), OPTION_SWITCH_PREFIX)
    expect(out.kind).toBe("unknown-option")
  })

  test("unknown option id → unknown-option", () => {
    const out = applyMismatchResolution(buildReq(), "made-up")
    expect(out).toEqual({ kind: "unknown-option", optionId: "made-up" })
  })
})
