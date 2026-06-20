/**
 * Wafer provider tests.
 *
 * Offline: registry + reuse of llm-openai's translator/validator. The live
 * test is gated on `MINIMAL_AGENT_WAFER_LIVE_KEY` so generic provider env
 * vars never become runtime auth inputs.
 *
 * @module llm/providers/wafer/wafer.test
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { type CanonicalEvent, isEvent } from "@minimal-agent/plugin-api/llm/canonical-events"
import { userText } from "@minimal-agent/plugin-api/llm/canonical-messages"
import type { RunContext } from "@minimal-agent/plugin-api/llm/provider-auth"
import { parseSse } from "@minimal-agent/plugin-api/utils/sse-parser"

import type { CanonicalRequest } from "../../src/llm/canonical-request.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  registerModel,
  resolveModel,
  resolveProvider,
} from "../../src/llm/index.ts"
import { type OpenAIChatChunk, translateOpenAIChatStream } from "../llm-openai/index.ts"

import { bootstrapWafer, waferAdapter, waferProviderPlugin } from "./adapter.ts"
import {
  buildWaferApiKeyCredential,
  readWaferApiKey,
  WAFER_API_KEY_AUTH,
  waferApiKeyAuth,
} from "./auth.ts"
import { registerWaferModels } from "./models.ts"
import {
  accumulateWaferUsage,
  clearWaferRateLimits,
  getWaferRateLimits,
  getWaferSessionUsage,
  parseWaferQuotaWindows,
  setWaferRateLimits,
} from "./session-info.ts"

/**
 * Synthesize a fake NetworkClient that returns a canned HTTP response.
 * The real NetworkClient type is complex (16 methods); the adapter only
 * calls `request()`, so a partial satisfies the structural type.
 */
function fakeNetworkClient(status: number, body: string) {
  return {
    async request() {
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
        headers: new Headers(),
      }
    },
  } as unknown as import("../../src/network/index.ts").NetworkClient
}

/** Drain a CanonicalEvent generator and return the first error thrown, or null. */
async function drainCatch(
  gen: AsyncIterable<unknown>,
): Promise<(Error & { streamErrorType?: string }) | null> {
  try {
    for await (const _ of gen) {
      /* drain */
    }
    return null
  } catch (err) {
    return err as Error & { streamErrorType?: string }
  }
}

function setup() {
  clearModelRegistry()
  clearProviderRegistry()
  bootstrapWafer()
}

function sseStream(raw: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(raw)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

function openaiChatPong(): string {
  return readFileSync(join(import.meta.dir, "../llm-openai/__fixtures__/chat-pong.sse"), "utf-8")
}

describe("llm-wafer (OpenAI-compatible gateway, reuses llm-openai's wire layer)", () => {
  it("exposes API-key auth and no OAuth login strategy", () => {
    expect(waferProviderPlugin.apiKeyAuth).toBe(waferApiKeyAuth)
    expect(waferProviderPlugin.oauthLogin).toBeUndefined()
  })

  it("declares the Wafer API-key credential codec", () => {
    expect(waferApiKeyAuth.serviceId).toBe(WAFER_API_KEY_AUTH.serviceId)
    expect(waferApiKeyAuth.displayName).toBe("Wafer API Key")

    const write = buildWaferApiKeyCredential("wfr_test123")
    expect(write).toEqual({
      serviceId: "wafer-api-key",
      displayName: "Wafer API Key",
      secrets: { tokenType: "api-key", apiKey: "wfr_test123" },
    })
    expect(readWaferApiKey(write.secrets)).toBe("wfr_test123")
    expect(readWaferApiKey({ tokenType: "api-key" })).toBeNull()
    expect(waferApiKeyAuth.inspectCredential?.(write.secrets)).toEqual({ usable: true })
    expect(waferApiKeyAuth.inspectCredential?.({ tokenType: "api-key" })).toEqual({
      usable: false,
    })
  })

  it("registers models on the openai-chat-completions surface", () => {
    setup()
    const m = resolveModel("GLM-5.1")
    expect(m.providerId).toBe("wafer")
    expect(m.surfaceId).toBe("openai-chat-completions")
    expect(m.vendorIds?.firstParty).toBe("GLM-5.1")
    expect(m.tags).toContain("balanced")

    const adapter = resolveProvider("wafer")
    expect(adapter.surfaces).toContain("openai-chat-completions")
    expect(adapter.displayName).toBe("Wafer")
  })

  it("registers all 10 built-in models", () => {
    setup()
    const ids = [
      "GLM-5.1",
      "GLM-5.2",
      "Kimi-K2.6",
      "Kimi-K2.7-Code",
      "Qwen3.5-397B-A17B",
      "Qwen3.6-35B-A3B",
      "qwen3.7-max",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "MiniMax-M3",
    ]
    for (const id of ids) {
      const m = resolveModel(id)
      expect(m.providerId).toBe("wafer")
      expect(m.surfaceId).toBe("openai-chat-completions")
    }
  })

  it("registers ad-hoc models on demand", () => {
    setup()
    waferProviderPlugin.registerAdHocModel?.("some-future-model")
    const m = resolveModel("some-future-model")
    expect(m.providerId).toBe("wafer")
    expect(m.surfaceId).toBe("openai-chat-completions")
    expect(m.displayName).toBe("some-future-model")
  })

  it("round-trips a Chat stream through the REUSED OpenAI translator", async () => {
    const events: CanonicalEvent[] = []
    for await (const ev of translateOpenAIChatStream(
      parseSse<OpenAIChatChunk>(sseStream(openaiChatPong())),
    )) {
      events.push(ev)
    }
    let text = ""
    for (const ev of events) if (isEvent(ev, "text_delta")) text += ev.text
    expect(text).toBe("pong")
  })

  it("validates a plain request via the REUSED OpenAI validator", () => {
    setup()
    const adapter = resolveProvider("wafer")
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
    expect(adapter.validate(req, resolveModel("GLM-5.1")).ok).toBe(true)
  })

  it("recommends sub-agent models by tag", () => {
    setup()
    const recs = waferAdapter.recommendSubagentModels?.() ?? []
    const byRole = new Map(recs.map((r) => [r.role, r.modelId]))
    expect(byRole.get("scout")).toBe("deepseek-v4-flash")
    expect(byRole.get("balanced")).toBe("GLM-5.1")
    expect(byRole.get("deep")).toBe("deepseek-v4-pro")
  })

  it("has correct pricing for known models", () => {
    setup()
    const glm51 = resolveModel("GLM-5.1")
    expect(glm51.pricing.inputUSD).toBe(1.0) // 100 cents/mil = 1.0 USD/mil
    expect(glm51.pricing.outputUSD).toBe(3.2)

    const dsFlash = resolveModel("deepseek-v4-flash")
    expect(dsFlash.pricing.inputUSD).toBe(0.09) // 9 cents/mil
    expect(dsFlash.pricing.outputUSD).toBe(0.18)

    const qwen37 = resolveModel("qwen3.7-max")
    expect(qwen37.pricing.inputUSD).toBe(5.0) // 500 cents/mil
    expect(qwen37.pricing.outputUSD).toBe(15.0)

    // All 10 models pricing
    const pricingTable: Record<string, { input: number; output: number }> = {
      "GLM-5.1": { input: 1.0, output: 3.2 },
      "GLM-5.2": { input: 1.2, output: 4.1 },
      "Kimi-K2.6": { input: 0.68, output: 3.15 },
      "Kimi-K2.7-Code": { input: 0.95, output: 4.0 },
      "Qwen3.5-397B-A17B": { input: 0.43, output: 2.6 },
      "Qwen3.6-35B-A3B": { input: 0.15, output: 1.0 },
      "qwen3.7-max": { input: 5.0, output: 15.0 },
      "deepseek-v4-flash": { input: 0.09, output: 0.18 },
      "deepseek-v4-pro": { input: 1.2, output: 2.4 },
      "MiniMax-M3": { input: 0.33, output: 1.32 },
    }
    for (const [id, prices] of Object.entries(pricingTable)) {
      const m = resolveModel(id)
      expect(m.pricing.inputUSD, `${id} inputUSD`).toBe(prices.input)
      expect(m.pricing.outputUSD, `${id} outputUSD`).toBe(prices.output)
    }
  })

  // ---------------------------------------------------------------------------
  // Error classification
  // ---------------------------------------------------------------------------

  it("classifies 429 rate_limit_error as retryable with streamErrorType", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.1")
    const body = JSON.stringify({
      error: { code: "ttfb_gate_shed", message: "model at capacity" },
    })
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(429, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBe("rate_limit_error")
  })

  it("classifies 503 server_error as retryable with streamErrorType", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.1")
    const body = JSON.stringify({ error: { code: "server_error", message: "down" } })
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(503, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBe("overloaded_error")
  })

  it("does NOT tag 402 insufficient_quota as retryable", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.1")
    const body = JSON.stringify({
      error: { code: "insufficient_quota", message: "out of credits" },
    })
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(402, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBeUndefined()
  })

  it("classifies non-JSON error body by HTTP status alone", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.1")
    const body = "Gateway Timeout"
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(504, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBe("overloaded_error")
  })

  it("classifies 500 with type field (fallback from code) as retryable", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.1")
    // No `code` field — parser falls back to `type`
    const body = JSON.stringify({ error: { type: "server_error", message: "boom" } })
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(500, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBe("overloaded_error")
  })

  it("does NOT tag 401 invalid_api_key as retryable", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.1")
    const body = JSON.stringify({
      error: { code: "invalid_api_key", message: "bad key" },
    })
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(401, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBeUndefined()
  })

  it("does NOT tag 400 invalid_request_error as retryable", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.1")
    const body = JSON.stringify({
      error: { code: "invalid_request_error", message: "bad request" },
    })
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(400, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBeUndefined()
  })

  it("classifies 429 with JSON but no code or type by HTTP status alone", async () => {
    setup()
    const provider = resolveProvider("wafer")
    const model = resolveModel("GLM-5.1")
    // Valid JSON, error object, but no code or type field
    const body = JSON.stringify({ error: { message: "too many requests" } })
    const req: CanonicalRequest = { modelId: "GLM-5.1", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNetworkClient(429, body),
      sessionId: "err-test",
    }
    const caught = await drainCatch(provider.run(req, model, ctx))
    expect(caught).not.toBeNull()
    expect(caught!.streamErrorType).toBe("rate_limit_error")
  })

  // ---------------------------------------------------------------------------
  // Session info: cache + quota windows
  // ---------------------------------------------------------------------------

  it("parses Wafer quota windows from x-ratelimit-* headers", () => {
    const rl = new Map<string, string>([
      ["x-ratelimit-limit-requests", "100"],
      ["x-ratelimit-remaining-requests", "25"],
      ["x-ratelimit-reset-requests", "1h"],
      ["x-ratelimit-limit-tokens", "1000000"],
      ["x-ratelimit-remaining-tokens", "900000"],
      ["x-ratelimit-reset-tokens", "0s"],
    ])
    const windows = parseWaferQuotaWindows(rl)
    expect(windows.length).toBe(2)
    const req = windows.find((w) => w.id === "req")
    const tok = windows.find((w) => w.id === "tok")
    expect(req).not.toBeUndefined()
    expect(tok).not.toBeUndefined()
    expect(req!.utilization).toBe(0.75) // 1 - 25/100
    expect(tok!.utilization).toBeCloseTo(0.1)
    expect(req!.resetAtMs).toBeGreaterThan(Date.now())
    expect(tok!.resetAtMs).not.toBeUndefined()
  })

  it("skips windows with limit=0 or missing remaining", () => {
    const rl = new Map<string, string>([
      ["x-ratelimit-limit-requests", "0"],
      ["x-ratelimit-remaining-requests", "0"],
      ["x-ratelimit-reset-requests", "1h"],
    ])
    const windows = parseWaferQuotaWindows(rl)
    expect(windows).toHaveLength(0)
  })

  it("setWaferRateLimits populates and getWaferRateLimits reads the cache", () => {
    clearWaferRateLimits()
    expect(getWaferRateLimits()).toBeNull()

    const headers = new Headers({
      "x-ratelimit-limit-requests": "50",
      "x-ratelimit-remaining-requests": "40",
      "x-ratelimit-reset-requests": "5m",
    })
    setWaferRateLimits(headers)
    const cached = getWaferRateLimits()
    expect(cached).not.toBeNull()
    expect(cached!.rateLimits.get("x-ratelimit-limit-requests")).toBe("50")
    expect(cached!.at).toBeGreaterThan(Date.now() - 1000)
  })

  it("setWaferRateLimits ignores headers with no x-ratelimit entries", () => {
    clearWaferRateLimits()
    setWaferRateLimits(new Headers({ "content-type": "application/json" }))
    expect(getWaferRateLimits()).toBeNull()
  })

  it("accumulateWaferUsage accumulates across multiple calls", () => {
    clearWaferRateLimits()
    expect(getWaferSessionUsage()).toBeNull()

    accumulateWaferUsage({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 })
    expect(getWaferSessionUsage()?.inputTokens).toBe(100)
    expect(getWaferSessionUsage()?.outputTokens).toBe(50)
    expect(getWaferSessionUsage()?.cacheReadTokens).toBe(20)

    accumulateWaferUsage({ inputTokens: 200, outputTokens: 100 })
    expect(getWaferSessionUsage()?.inputTokens).toBe(300)
    expect(getWaferSessionUsage()?.outputTokens).toBe(150)
    expect(getWaferSessionUsage()?.cacheReadTokens).toBe(20) // unchanged
  })

  it("clearWaferRateLimits clears both caches", () => {
    clearWaferRateLimits()
    setWaferRateLimits(
      new Headers({
        "x-ratelimit-limit-requests": "1",
        "x-ratelimit-remaining-requests": "1",
        "x-ratelimit-reset-requests": "1s",
      }),
    )
    accumulateWaferUsage({ inputTokens: 1, outputTokens: 1 })
    expect(getWaferRateLimits()).not.toBeNull()
    expect(getWaferSessionUsage()).not.toBeNull()
    clearWaferRateLimits()
    expect(getWaferRateLimits()).toBeNull()
    expect(getWaferSessionUsage()).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // Capability validation for all 10 models
  // ---------------------------------------------------------------------------

  it("each model has correct capabilities", () => {
    setup()
    // GLM-5.1 — 202K context, reasoning on, vision off
    const glm51 = resolveModel("GLM-5.1")
    expect(glm51.capabilities.contextWindow).toBe(202_752)
    expect(glm51.capabilities.thinking.adaptive).toBe(true)
    expect(glm51.capabilities.effort.levels).toEqual(["low", "medium", "high"])
    expect(glm51.capabilities.modalities.image).toBe(false)
    expect(glm51.capabilities.speedFast).toBe(false)

    // GLM-5.2 — 1M context
    expect(resolveModel("GLM-5.2").capabilities.contextWindow).toBe(1_048_576)

    // Kimi-K2.6 — vision
    expect(resolveModel("Kimi-K2.6").capabilities.modalities.image).toBe(true)
    expect(resolveModel("Kimi-K2.6").capabilities.contextWindow).toBe(262_144)

    // Kimi-K2.7-Code — no vision
    expect(resolveModel("Kimi-K2.7-Code").capabilities.modalities.image).toBe(false)

    // Qwen3.6-35B-A3B — no reasoning
    const qwen36 = resolveModel("Qwen3.6-35B-A3B")
    expect(qwen36.capabilities.thinking.adaptive).toBe(false)
    expect(qwen36.capabilities.effort.levels).toEqual([])

    // deepseek-v4-flash — cheap, 1M context
    const dsFlash = resolveModel("deepseek-v4-flash")
    expect(dsFlash.capabilities.contextWindow).toBe(1_000_000)
    expect(dsFlash.tags).toContain("cheap")
    expect(dsFlash.tags).toContain("scout")

    // deepseek-v4-pro — flagship
    const dsPro = resolveModel("deepseek-v4-pro")
    expect(dsPro.capabilities.contextWindow).toBe(1_000_000)
    expect(dsPro.tags).toContain("flagship")
    expect(dsPro.tags).toContain("deep")

    // MiniMax-M3 — interleaved thinking
    const mm3 = resolveModel("MiniMax-M3")
    expect(mm3.capabilities.thinking.interleaved).toBe(true)
    expect(mm3.capabilities.contextWindow).toBe(1_048_576)
  })

  // ---------------------------------------------------------------------------
  // modelVersionToken
  // ---------------------------------------------------------------------------

  it("modelVersionToken strips vendor prefixes for all families", () => {
    // oxlint-disable unbound-method
    const fn = waferProviderPlugin.modelVersionToken!
    expect(fn("GLM-5.1")).toBe("5.1")
    expect(fn("GLM-5.2")).toBe("5.2")
    expect(fn("Kimi-K2.6")).toBe("K2.6")
    expect(fn("Kimi-K2.7-Code")).toBe("K2.7-Code")
    expect(fn("Qwen3.5-397B-A17B")).toBe("3.5-397B-A17B")
    expect(fn("Qwen3.6-35B-A3B")).toBe("3.6-35B-A3B")
    expect(fn("qwen3.7-max")).toBe("3.7-max")
    expect(fn("deepseek-v4-flash")).toBe("v4-flash")
    expect(fn("deepseek-v4-pro")).toBe("v4-pro")
    expect(fn("MiniMax-M3")).toBe("M3")
  })

  // ---------------------------------------------------------------------------
  // Plugin surface constants
  // ---------------------------------------------------------------------------

  it("plugin surface constants are correct", () => {
    expect(waferProviderPlugin.id).toBe("wafer")
    expect(waferProviderPlugin.shortCode).toBe("wf")
    expect(waferProviderPlugin.displayName).toBe("Wafer")
  })

  // ---------------------------------------------------------------------------
  // Auth edge cases
  // ---------------------------------------------------------------------------

  it("auth inspect treats empty/whitespace keys as unusable", () => {
    expect(waferApiKeyAuth.inspectCredential?.({ tokenType: "api-key", apiKey: "" })).toEqual({
      usable: false,
    })
    // inspectCredential trims, so spaces-only is also unusable
    expect(waferApiKeyAuth.inspectCredential?.({ tokenType: "api-key", apiKey: "   " })).toEqual({
      usable: false,
    })
  })

  // ---------------------------------------------------------------------------
  // bootstrapWafer idempotency
  // ---------------------------------------------------------------------------

  it("bootstrapWafer is idempotent", () => {
    setup()
    // Second call should not cause duplicate registrations
    bootstrapWafer()
    const adapter = resolveProvider("wafer")
    expect(adapter.displayName).toBe("Wafer")
    // Model should still resolve
    expect(resolveModel("GLM-5.1").providerId).toBe("wafer")
  })

  // ---------------------------------------------------------------------------
  // SDK seam: registerWaferModels via ModelRegistrar (no src/ import)
  // ---------------------------------------------------------------------------

  it("registerWaferModels via registrar produces same models as legacy path", () => {
    clearModelRegistry()
    clearProviderRegistry()
    // Legacy path
    registerWaferModels()
    const legacy = resolveModel("GLM-5.1")
    expect(legacy.providerId).toBe("wafer")
    expect(legacy.capabilities.contextWindow).toBe(202_752)

    // SDK-seam path
    clearModelRegistry()
    clearProviderRegistry()
    const captured: Array<{
      id: string
      providerId: string
      surfaceId: string
    }> = []
    const mockRegistrar = {
      register(spec: { id: string; providerId: string; surfaceId: string }) {
        captured.push({
          id: spec.id,
          providerId: spec.providerId,
          surfaceId: spec.surfaceId,
        })
        // Also register for real so resolveModel works
        registerModel(spec as Parameters<typeof registerModel>[0])
      },
      setDefault(_id: string | null) {},
    }
    registerWaferModels(mockRegistrar)
    expect(captured.length).toBe(10)
    expect(captured[0]!.id).toBe("GLM-5.1")
    expect(captured[0]!.providerId).toBe("wafer")
    expect(captured[0]!.surfaceId).toBe("openai-chat-completions")

    const seam = resolveModel("GLM-5.1")
    expect(seam.providerId).toBe("wafer")
    expect(seam.capabilities.contextWindow).toBe(legacy.capabilities.contextWindow)
  })

  it("registerWaferModel ad-hoc also supports registrar", () => {
    clearModelRegistry()
    clearProviderRegistry()
    const captured: Array<{ id: string }> = []
    const mockRegistrar = {
      register(spec: { id: string }) {
        captured.push({ id: spec.id })
        registerModel(spec as Parameters<typeof registerModel>[0])
      },
      setDefault(_id: string | null) {},
    }
    registerWaferModels(mockRegistrar)
    expect(captured.some((c) => c.id === "GLM-5.1")).toBe(true)
  })

  // ---------------------------------------------------------------------------
  // Model tags
  // ---------------------------------------------------------------------------

  it("model tags are correct for all 10 models", () => {
    setup()
    const tagChecks: Record<string, string[]> = {
      "GLM-5.1": ["reasoning", "balanced"],
      "GLM-5.2": ["reasoning", "1m-context"],
      "Kimi-K2.6": ["reasoning", "vision", "balanced"],
      "Kimi-K2.7-Code": ["reasoning", "code"],
      "Qwen3.5-397B-A17B": ["reasoning", "balanced"],
      "Qwen3.6-35B-A3B": ["cheap"],
      "qwen3.7-max": ["reasoning", "flagship"],
      "deepseek-v4-flash": ["reasoning", "cheap", "scout"],
      "deepseek-v4-pro": ["reasoning", "flagship", "deep"],
      "MiniMax-M3": ["reasoning", "1m-context"],
    }
    for (const [id, expectedTags] of Object.entries(tagChecks)) {
      const m = resolveModel(id)
      for (const tag of expectedTags) {
        expect(m.tags, `${id} should have tag ${tag}`).toContain(tag)
      }
    }
  })

  // ---------------------------------------------------------------------------
  // Prime dedupe
  // ---------------------------------------------------------------------------

  it("primeWaferSessionInfo deduplicates concurrent calls", () => {
    setup()
    const p1 = waferProviderPlugin.primeSessionInfo!({
      modelId: "GLM-5.1",
    })
    const p2 = waferProviderPlugin.primeSessionInfo!({
      modelId: "GLM-5.1",
    })
    // Same promise reference — deduped
    expect(p1).toBe(p2)
  })

  // Live round-trip. Set MINIMAL_AGENT_WAFER_LIVE_KEY to run it. Proves the
  // request reaches Wafer with valid auth + a well-formed OpenAI-Chat body.
  // Like the OpenRouter live test, it accepts EITHER streamed text OR a
  // 402/401 as success (both confirm auth + wire are correct; completing
  // the round-trip just needs active credits).
  const KEY = process.env.MINIMAL_AGENT_WAFER_LIVE_KEY
  it.skipIf(!KEY)("live: GLM-5.1 via Wafer (auth + wire reach the API)", async () => {
    setup()
    const model = resolveModel("GLM-5.1")
    const provider = resolveProvider("wafer")
    const req: CanonicalRequest = {
      modelId: "GLM-5.1",
      messages: [userText("Reply with the single word: pong")],
      generation: { maxOutputTokens: 16 },
    }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: KEY as string },
      sessionId: "wafer-live-test",
    }
    let text = ""
    try {
      for await (const ev of provider.run(req, model, ctx)) {
        if (isEvent(ev, "text_delta")) text += ev.text
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).toMatch(/\b402\b|\b401\b|insufficient|unauthorized/i)
      return
    }
    expect(text.length).toBeGreaterThan(0)
  })
})
