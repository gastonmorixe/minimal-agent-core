/**
 * Tests for the session-tokens accumulator. Pinned to a stable shape
 * because the `quota-status` plugin reads `getSessionTokens()` to render
 * the footer.
 */

import { afterEach, describe, expect, it } from "bun:test"

import { defaultCapabilities } from "@minimal-agent/plugin-api/llm/capabilities"

import { clearModelRegistry, registerModel } from "../llm/model-registry.ts"

import {
  addSessionEstimatedUsage,
  addSessionUsage,
  clearSessionTokens,
  getSessionTokens,
} from "./session-tokens.ts"

afterEach(() => clearSessionTokens())

describe("session-tokens", () => {
  it("starts at zero with zero turns", () => {
    const t = getSessionTokens()
    expect(t).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
      total: 0,
      turns: 0,
      contextSize: 0,
      contextSizeEstimated: false,
    })
  })

  it("accumulates each cumulative field across turns", () => {
    addSessionUsage({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5,
    })
    addSessionUsage({
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 0,
    })
    const t = getSessionTokens()
    expect(t.input).toBe(11)
    expect(t.output).toBe(22)
    expect(t.cacheRead).toBe(33)
    expect(t.cacheCreate).toBe(5)
    expect(t.total).toBe(11 + 22 + 33 + 5)
    expect(t.turns).toBe(2)
  })

  it("contextSize REPLACES on each turn (no accumulation)", () => {
    // This is the key fix: cumulative-sum of cache_read across turns
    // produces an ~N×-inflated "session footprint" because the same
    // cached prefix is re-read every turn. contextSize snapshots the
    // LATEST turn instead, so it tracks "what's actually in the
    // model's context window right now."
    addSessionUsage({
      input_tokens: 10,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5,
    })
    expect(getSessionTokens().contextSize).toBe(45)

    // A subsequent turn re-reads the same prefix + a few new input
    // tokens. contextSize should equal the LATEST turn (50), not
    // 45 + 50 = 95.
    addSessionUsage({
      input_tokens: 2,
      cache_read_input_tokens: 48,
      cache_creation_input_tokens: 0,
    })
    expect(getSessionTokens().contextSize).toBe(50)
    // The cumulative `cacheRead` is still inflated (documented).
    expect(getSessionTokens().cacheRead).toBe(78)
  })

  it("contextSize excludes output (not yet known at message_start)", () => {
    addSessionUsage({
      input_tokens: 10,
      output_tokens: 9999, // arbitrarily large to make the test obvious
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5,
    })
    expect(getSessionTokens().contextSize).toBe(45)
  })

  it("ignores undefined and missing fields", () => {
    addSessionUsage(undefined)
    addSessionUsage({})
    addSessionUsage({ output_tokens: 7 })
    const t = getSessionTokens()
    expect(t.total).toBe(7)
    // An empty `{}` still counts as a turn (the API returned a response);
    // undefined does not.
    expect(t.turns).toBe(2)
    // No turn carried any input/cache, so contextSize stayed at 0.
    expect(t.contextSize).toBe(0)
  })

  it("returns a copy so callers cannot mutate internal state", () => {
    addSessionUsage({ input_tokens: 1 })
    const t = getSessionTokens()
    t.input = 999
    t.contextSize = 999
    expect(getSessionTokens().input).toBe(1)
    expect(getSessionTokens().contextSize).toBe(1)
  })

  it("clearSessionTokens resets everything", () => {
    addSessionUsage({
      input_tokens: 5,
      output_tokens: 6,
      cache_read_input_tokens: 100,
    })
    expect(getSessionTokens().contextSize).toBe(105)
    clearSessionTokens()
    const t = getSessionTokens()
    expect(t.total).toBe(0)
    expect(t.turns).toBe(0)
    expect(t.contextSize).toBe(0)
  })

  it("addSessionEstimatedUsage adds an estimated contextSize and guards bad inputs", () => {
    addSessionEstimatedUsage(0)
    addSessionEstimatedUsage(-10)
    addSessionEstimatedUsage(Number.NaN)
    expect(getSessionTokens().turns).toBe(0)
    expect(getSessionTokens().contextSizeEstimated).toBe(false)

    addSessionEstimatedUsage(42.2)
    const t = getSessionTokens()
    expect(t.turns).toBe(1)
    expect(t.total).toBe(43) // ceil
    expect(t.contextSize).toBe(43)
    expect(t.contextSizeEstimated).toBe(true)

    clearSessionTokens()
    addSessionUsage({ input_tokens: 10, cache_read_input_tokens: 5 })
    expect(getSessionTokens().contextSizeEstimated).toBe(false)
    addSessionEstimatedUsage(7)
    expect(getSessionTokens().contextSizeEstimated).toBe(true)
  })

  it("contextSize includes output when model shares the context window", () => {
    const modelId = "test-share-window-evelyn-gaston"
    registerModel({
      id: modelId,
      providerId: "test-provider",
      surfaceId: "test-surface",
      displayName: "Test Share",
      capabilities: {
        ...defaultCapabilities(),
        contextWindow: 100_000,
        maxOutputTokens: 8_000,
        outputTokensShareContextWindow: true,
      },
      pricing: {
        inputUSD: 0,
        outputUSD: 0,
        cacheWriteUSD: 0,
        cacheReadUSD: 0,
        webSearchPerCallUSD: 0,
      },
    })
    const prevModel = process.env.MINIMAL_AGENT_MODEL
    const prevProvider = process.env.MINIMAL_AGENT_PROVIDER
    process.env.MINIMAL_AGENT_MODEL = modelId
    process.env.MINIMAL_AGENT_PROVIDER = "test-provider"
    try {
      addSessionUsage({
        input_tokens: 10,
        output_tokens: 9999,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 5,
      })
      expect(getSessionTokens().contextSize).toBe(10 + 30 + 5 + 9999)
    } finally {
      if (prevModel === undefined) delete process.env.MINIMAL_AGENT_MODEL
      else process.env.MINIMAL_AGENT_MODEL = prevModel
      if (prevProvider === undefined) delete process.env.MINIMAL_AGENT_PROVIDER
      else process.env.MINIMAL_AGENT_PROVIDER = prevProvider
      clearModelRegistry()
    }
  })
})
