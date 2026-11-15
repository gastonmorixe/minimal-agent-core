/**
 * Canonical usage meaning, consumer side. `inputTokens` is the uncached input
 * only. `cacheReadTokens` and `cacheCreationTokens` are disjoint from it.
 * The legacy stream bridge, the session token totals (context-window `used`),
 * and the cost calculator must count each input token once. The adapter
 * goldens live next to each adapter in plugin-api/src/llm.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { addSessionUsage, clearSessionTokens, getSessionTokens } from "../session/session-tokens.ts"

import type { CanonicalEvent, CanonicalUsage } from "./canonical-events.ts"
import { assembleStreamedResponse } from "./codec/stream-assembler.ts"
import { calculateUsageCost, type MTokRate } from "./pricing.ts"
import { resetStreamDeltaAccumulator } from "./transport/stream-delta.ts"

async function* fromArray(events: CanonicalEvent[]): AsyncIterable<CanonicalEvent> {
  for (const ev of events) yield ev
}

/** Run one turn through the legacy bridge and fold its usage into the session. */
async function contextUsed(usage: CanonicalUsage): Promise<number> {
  const events: CanonicalEvent[] = [
    { type: "message_start", messageId: "m1", modelId: "test-model", initialUsage: usage },
    { type: "text_start", index: 0 },
    { type: "text_delta", index: 0, text: "ok" },
    { type: "text_stop", index: 0, finalText: "ok" },
    { type: "message_delta", stopReason: "end_turn", usage },
    { type: "message_stop" },
  ]
  const gen = assembleStreamedResponse(fromArray(events), {})
  let next = await gen.next()
  while (!next.done) next = await gen.next()
  addSessionUsage(next.value.usage)
  return getSessionTokens().contextSize
}

const RATE: MTokRate = {
  inputUSD: 10,
  outputUSD: 0,
  cacheWriteUSD: 20,
  cacheReadUSD: 1,
  webSearchPerCallUSD: 0,
}

const savedModel = process.env.MINIMAL_AGENT_MODEL

beforeEach(() => {
  // No model: the context size counts the input side only.
  delete process.env.MINIMAL_AGENT_MODEL
  clearSessionTokens()
})

afterEach(() => {
  if (savedModel === undefined) delete process.env.MINIMAL_AGENT_MODEL
  else process.env.MINIMAL_AGENT_MODEL = savedModel
  clearSessionTokens()
  resetStreamDeltaAccumulator()
})

describe("canonical usage consumers count each input token once", () => {
  it("used is input + cache read: 1300 + 200 = 1500", async () => {
    const usage: CanonicalUsage = { inputTokens: 1300, outputTokens: 40, cacheReadTokens: 200 }
    expect(await contextUsed(usage)).toBe(1500)
    expect(getSessionTokens().input).toBe(1300)
    expect(getSessionTokens().cacheRead).toBe(200)
  })

  it("used is input + cache read + cache write: 1000 + 200 + 50 = 1250", async () => {
    const usage: CanonicalUsage = {
      inputTokens: 1000,
      outputTokens: 40,
      cacheReadTokens: 200,
      cacheCreationTokens: 50,
    }
    expect(await contextUsed(usage)).toBe(1250)
  })

  it("cost prices each input counter once, at its own rate", () => {
    const cost = calculateUsageCost(
      { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 200, cacheCreationTokens: 50 },
      RATE,
    )
    expect(cost.inputUSD).toBeCloseTo((1000 / 1e6) * 10, 12)
    expect(cost.cacheReadUSD).toBeCloseTo((200 / 1e6) * 1, 12)
    expect(cost.cacheCreationUSD).toBeCloseTo((50 / 1e6) * 20, 12)
    expect(cost.totalUSD).toBeCloseTo((1000 * 10 + 200 * 1 + 50 * 20) / 1e6, 12)
  })
})
