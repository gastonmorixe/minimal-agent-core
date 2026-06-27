/**
 * Tests for the context-budget pure helpers.
 *
 * Two functions, both pure (functional core, no I/O):
 *
 * - `clampMaxOutputTokens` - reserve output room that actually fits the
 *   model's context window. This is the fix for the OpenAI Responses
 *   `context_length_exceeded` failure: that surface validates
 *   `input_tokens + max_output_tokens <= context_window`, so requesting
 *   the model's full output ceiling on a near-full history is rejected
 *   even though the input alone "fits".
 *
 * - `estimateRequestInputTokens` - a rough, model-aware estimate of how
 *   many tokens the outgoing request body carries (system + messages +
 *   tool schemas), so the clamp has an `inputTokens` to subtract.
 */

import { describe, expect, it } from "bun:test"

import type { Message } from "../client/types.ts"

import {
  clampMaxOutputTokens,
  DEFAULT_OUTPUT_SAFETY_MARGIN,
  estimateRequestInputTokens,
  MIN_OUTPUT_TOKENS,
} from "./context-budget.ts"

describe("clampMaxOutputTokens", () => {
  it("returns the model max unchanged when there is plenty of room", () => {
    const out = clampMaxOutputTokens({
      modelMax: 128_000,
      contextWindow: 1_050_000,
      inputTokens: 10_000,
      safetyMargin: 0,
    })
    expect(out).toBe(128_000)
  })

  it("shrinks the budget to what fits when input is near the window", () => {
    // 1_050_000 window, 1_000_000 of input, 0 margin → only 50_000 left,
    // which is less than the 128_000 model max, so we get 50_000.
    const out = clampMaxOutputTokens({
      modelMax: 128_000,
      contextWindow: 1_050_000,
      inputTokens: 1_000_000,
      safetyMargin: 0,
    })
    expect(out).toBe(50_000)
  })

  it("subtracts the safety margin from the available room", () => {
    const out = clampMaxOutputTokens({
      modelMax: 128_000,
      contextWindow: 1_050_000,
      inputTokens: 1_000_000,
      safetyMargin: 10_000,
    })
    expect(out).toBe(40_000)
  })

  it("never returns below the MIN_OUTPUT_TOKENS floor, even when over-full", () => {
    const out = clampMaxOutputTokens({
      modelMax: 128_000,
      contextWindow: 1_050_000,
      inputTokens: 1_100_000, // already over the window
      safetyMargin: 0,
    })
    expect(out).toBe(MIN_OUTPUT_TOKENS)
  })

  it("returns the model max when contextWindow is unknown (0 / undefined)", () => {
    expect(
      clampMaxOutputTokens({ modelMax: 128_000, contextWindow: 0, inputTokens: 999_999 }),
    ).toBe(128_000)
    expect(
      clampMaxOutputTokens({ modelMax: 128_000, contextWindow: undefined, inputTokens: 999_999 }),
    ).toBe(128_000)
  })

  it("applies a non-zero default safety margin when none is passed", () => {
    expect(DEFAULT_OUTPUT_SAFETY_MARGIN).toBeGreaterThan(0)
    const out = clampMaxOutputTokens({
      modelMax: 128_000,
      contextWindow: 1_050_000,
      inputTokens: 1_000_000,
    })
    // 50_000 available minus the default margin.
    expect(out).toBe(50_000 - DEFAULT_OUTPUT_SAFETY_MARGIN)
  })

  it("never returns more than the model max even on a huge window", () => {
    const out = clampMaxOutputTokens({
      modelMax: 32_768,
      contextWindow: 2_000_000,
      inputTokens: 0,
      safetyMargin: 0,
    })
    expect(out).toBe(32_768)
  })

  it("returns an integer (floors fractional inputs)", () => {
    const out = clampMaxOutputTokens({
      modelMax: 128_000,
      contextWindow: 1_000_000,
      inputTokens: 933_333.7,
      safetyMargin: 0.5,
    })
    expect(Number.isInteger(out)).toBe(true)
  })
})

describe("estimateRequestInputTokens", () => {
  it("returns 0 for an empty request", () => {
    expect(estimateRequestInputTokens({ modelId: undefined, messages: [] })).toBe(0)
  })

  it("counts text from user and assistant messages", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "x".repeat(40) }] },
      { role: "assistant", content: [{ type: "text", text: "y".repeat(40) }] },
    ]
    // default ratio is ~3.5 chars/token → 80 chars ≈ 23 tokens.
    const out = estimateRequestInputTokens({ modelId: undefined, messages })
    expect(out).toBeGreaterThanOrEqual(18)
    expect(out).toBeLessThanOrEqual(25)
  })

  it("counts a plain-string message content", () => {
    const messages: Message[] = [{ role: "user", content: "q".repeat(40) }]
    const out = estimateRequestInputTokens({ modelId: undefined, messages })
    expect(out).toBeGreaterThanOrEqual(8)
  })

  it("counts tool_use input and tool_result content", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "z".repeat(40) } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", content: "w".repeat(40) }],
      },
    ]
    const out = estimateRequestInputTokens({ modelId: undefined, messages })
    // tool_use input JSON (~50+ chars) + tool_result 40 chars → above 15 tokens.
    expect(out).toBeGreaterThanOrEqual(15)
  })

  it("includes the system prompt text", () => {
    const withSystem = estimateRequestInputTokens({
      modelId: undefined,
      messages: [],
      system: [{ type: "text", text: "s".repeat(400) }],
    })
    // 400 chars ≈ 100 tokens.
    expect(withSystem).toBeGreaterThanOrEqual(90)
  })

  it("includes tool schema sizes", () => {
    const withTools = estimateRequestInputTokens({
      modelId: undefined,
      messages: [],
      tools: [
        {
          name: "Bash",
          description: "d".repeat(400),
          input_schema: { type: "object", properties: {} },
        },
      ],
    })
    expect(withTools).toBeGreaterThanOrEqual(90)
  })

  it("counts thinking-block text (it still occupies the window on resend)", () => {
    const messages: Message[] = [
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "t".repeat(400), signature: "sig" }],
      },
    ]
    const out = estimateRequestInputTokens({ modelId: undefined, messages })
    expect(out).toBeGreaterThanOrEqual(90)
  })
})
