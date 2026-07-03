/**
 * Coverage for Fix C: the agent requests the model's FULL output-token
 * budget instead of the transport's conservative 64k default.
 *
 * The transports default `max_tokens` to 64000. opus-4-8 actually supports
 * 128000. Capping every request at 64k meant a long turn hit the ceiling at
 * half the model's real budget, a direct contributor to the 2026-05-31
 * truncation incident. The agent now resolves the registered model's
 * `maxOutputTokens` capability and passes it on every request, while leaving
 * an unregistered model id alone (transport applies its own default).
 */

import { afterEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { SendOptions, StreamedResponse } from "../client/types.ts"
import { defaultCapabilities } from "../llm/capabilities.ts"
import { clearModelRegistry, registerModel } from "../llm/model-registry.ts"
import { makeCharRatioEstimator } from "../llm/token-estimate.ts"

import { Agent } from "./agent.ts"

const auth: AuthResult = { type: "api-key", token: "test-token" }

function registerModelWithCap(
  id: string,
  cap: number,
  contextWindow = 1_000_000,
  surfaceId: "surface-separate-budget" | "surface-shared-window" = "surface-separate-budget",
  charsPerToken?: number,
): void {
  registerModel({
    id,
    providerId: "testprov",
    surfaceId,
    displayName: id,
    knowledgeCutoff: "2025-01",
    capabilities: {
      ...defaultCapabilities(),
      contextWindow,
      maxOutputTokens: cap,
      // Some surfaces validate input + output against one shared window;
      // others treat the output budget as separate. Mirror that here so the
      // clamp fires for the shared-window surface and stays off for the
      // separate-budget one.
      outputTokensShareContextWindow: surfaceId === "surface-shared-window",
    },
    ...(charsPerToken ? { estimateTokens: makeCharRatioEstimator(charsPerToken) } : {}),
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

  it("does not clamp separate-budget surfaces, preserving their full output budget", async () => {
    registerModelWithCap("separate-budget-model", 128_000, 1_050_000, "surface-separate-budget")
    const sink: { opts?: SendOptions } = {}
    const agent = new Agent({
      auth,
      model: "separate-budget-model",
      sendFn: captureSendFn(sink),
      initialMessages: [{ role: "user", content: "x".repeat(3_500_000) }],
    })

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

  it("clamps maxTokens using the provider-scoped model estimator", async () => {
    // This model uses a 1-char-per-token estimator. If Agent ignored the
    // resolved entry and fell back to the global registry estimator, this
    // history would look tiny and the clamp would not fire.
    registerModelWithCap("shared-window-model", 128_000, 1_050_000, "surface-shared-window", 1)
    const sink: { opts?: SendOptions } = {}
    const agent = new Agent({
      auth,
      model: "shared-window-model",
      sendFn: captureSendFn(sink),
      initialMessages: [
        {
          role: "user",
          // Provider-scoped estimator is 1 char/token, so this is roughly
          // 1,000,000 input tokens before the new turn + system prompt.
          content: "x".repeat(1_000_000),
        },
      ],
    })

    const gen = agent.run("hi")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    expect(sink.opts?.maxTokens).toBeDefined()
    expect(sink.opts?.maxTokens).toBeLessThan(128_000)
    expect(sink.opts?.maxTokens).toBeGreaterThanOrEqual(1_024)
  })
})
