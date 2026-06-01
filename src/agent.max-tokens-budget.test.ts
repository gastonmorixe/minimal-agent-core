/**
 * Coverage for Fix C: the agent requests the model's FULL output-token
 * budget instead of the transport's conservative 64k default.
 *
 * The transports default `max_tokens` to 64000. opus-4-8 actually supports
 * 128000. Capping every request at 64k meant a long turn hit the ceiling at
 * half the model's real budget — a direct contributor to the 2026-05-31
 * truncation incident. The agent now resolves the registered model's
 * `maxOutputTokens` capability and passes it on every request, while leaving
 * an unregistered model id alone (transport applies its own default).
 */

import { afterEach, describe, expect, it } from "bun:test"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth.ts"
import type { SendOptions, StreamedResponse } from "./client.ts"
import { defaultCapabilities } from "./llm/capabilities.ts"
import { clearModelRegistry, registerModel } from "./llm/model-registry.ts"

const auth: AuthResult = { type: "api-key", token: "test-token" }

function registerModelWithCap(id: string, cap: number): void {
  registerModel({
    id,
    providerId: "testprov",
    surfaceId: "anthropic-messages",
    displayName: id,
    knowledgeCutoff: "2025-01",
    capabilities: { ...defaultCapabilities(), contextWindow: 1_000_000, maxOutputTokens: cap },
    pricing: {
      inputUSD: 1,
      outputUSD: 1,
      cacheWriteUSD: 1,
      cacheReadUSD: 1,
      webSearchPerCallUSD: 0,
    },
  })
}

/** Capture the first sendFn opts, then end the turn cleanly. */
function captureSendFn(sink: { opts?: SendOptions }) {
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    sink.opts ??= opts
    yield "ok"
    return {
      blocks: [{ type: "text" as const, text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

afterEach(() => {
  clearModelRegistry()
})

describe("Agent requests the model's full output budget (Fix C)", () => {
  it("passes maxTokens = the registered model's maxOutputTokens", async () => {
    registerModelWithCap("big-model", 128_000)
    const sink: { opts?: SendOptions } = {}
    const agent = new Agent({ auth, model: "big-model", sendFn: captureSendFn(sink) })

    const gen = agent.run("hi")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    expect(sink.opts?.maxTokens).toBe(128_000)
  })

  it("omits maxTokens for an unregistered model id (transport default applies)", async () => {
    const sink: { opts?: SendOptions } = {}
    const agent = new Agent({ auth, model: "totally-unknown-model", sendFn: captureSendFn(sink) })

    const gen = agent.run("hi")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    expect(sink.opts?.maxTokens).toBeUndefined()
  })
})
