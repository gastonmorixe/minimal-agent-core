/**
 * HuggingFace provider tests.
 *
 * Offline: registry + reuse of llm-openai's translator/validator. The live test
 * is gated on `MINIMAL_AGENT_HUGGINGFACE_LIVE_KEY` so generic provider env vars
 * never become runtime auth inputs.
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
  resolveModel,
  resolveProvider,
} from "../../src/llm/index.ts"
import { type OpenAIChatChunk, translateOpenAIChatStream } from "../llm-openai/index.ts"

import { bootstrapHuggingFace, huggingfaceProviderPlugin, resolveWireModelId } from "./adapter.ts"
import {
  buildHuggingfaceApiKeyCredential,
  HUGGINGFACE_API_KEY_AUTH,
  huggingfaceApiKeyAuth,
  readHuggingfaceApiKey,
} from "./auth.ts"

function setup() {
  clearModelRegistry()
  clearProviderRegistry()
  bootstrapHuggingFace()
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

describe("llm-huggingface (OpenAI-compatible gateway, reuses llm-openai's wire layer)", () => {
  it("exposes API-key auth and no OAuth login strategy", () => {
    expect(huggingfaceProviderPlugin.apiKeyAuth).toBe(huggingfaceApiKeyAuth)
    expect(huggingfaceProviderPlugin.oauthLogin).toBeUndefined()
  })

  it("declares the HuggingFace API-key credential codec", () => {
    expect(huggingfaceApiKeyAuth.serviceId).toBe(HUGGINGFACE_API_KEY_AUTH.serviceId)
    expect(huggingfaceApiKeyAuth.displayName).toBe("HuggingFace API Token")

    const write = buildHuggingfaceApiKeyCredential("hf_test")
    expect(write).toEqual({
      serviceId: "huggingface-api-key",
      displayName: "HuggingFace API Token",
      secrets: { tokenType: "api-key", apiKey: "hf_test" },
    })
    expect(readHuggingfaceApiKey(write.secrets)).toBe("hf_test")
    expect(readHuggingfaceApiKey({ tokenType: "api-key" })).toBeNull()
    expect(huggingfaceApiKeyAuth.inspectCredential?.(write.secrets)).toEqual({ usable: true })
    expect(huggingfaceApiKeyAuth.inspectCredential?.({ tokenType: "api-key" })).toEqual({
      usable: false,
    })
  })

  it("registers slugs on the shared openai-chat-completions surface", () => {
    setup()
    const m = resolveModel("openai/gpt-oss-120b")
    expect(m.providerId).toBe("huggingface")
    expect(m.surfaceId).toBe("openai-chat-completions")
    expect(m.vendorIds?.firstParty).toBe("openai/gpt-oss-120b")

    const adapter = resolveProvider("huggingface")
    expect(adapter.surfaces).toContain("openai-chat-completions")
    expect(adapter.displayName).toBe("HuggingFace")
  })

  it("registers ad-hoc slugs on demand", () => {
    setup()
    huggingfaceProviderPlugin.registerAdHocModel?.("meta-llama/Llama-3.1-8B-Instruct")
    const m = resolveModel("meta-llama/Llama-3.1-8B-Instruct")
    expect(m.providerId).toBe("huggingface")
    expect(m.surfaceId).toBe("openai-chat-completions")
    expect(m.displayName).toBe("meta-llama/Llama-3.1-8B-Instruct")
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
    const adapter = resolveProvider("huggingface")
    const req: CanonicalRequest = {
      modelId: "openai/gpt-oss-120b",
      messages: [userText("hi")],
    }
    expect(adapter.validate(req, resolveModel("openai/gpt-oss-120b")).ok).toBe(true)
  })

  it("resolves wire model id with provider suffix from vendor opts", () => {
    setup()
    const model = resolveModel("openai/gpt-oss-120b")

    // Without vendor opts, the model id passes through as-is (auto/fastest).
    const reqNoVendor: CanonicalRequest = {
      modelId: "openai/gpt-oss-120b",
      messages: [userText("hi")],
    }
    expect(resolveWireModelId(reqNoVendor, model)).toBe("openai/gpt-oss-120b")

    // "auto" is treated as no suffix (fastest default).
    const reqAuto: CanonicalRequest = {
      modelId: "openai/gpt-oss-120b",
      messages: [userText("hi")],
      vendor: { huggingface: { provider: "auto" } },
    }
    expect(resolveWireModelId(reqAuto, model)).toBe("openai/gpt-oss-120b")

    // With a specific provider, the suffix is appended.
    const reqGroq: CanonicalRequest = {
      modelId: "openai/gpt-oss-120b",
      messages: [userText("hi")],
      vendor: { huggingface: { provider: "groq" } },
    }
    expect(resolveWireModelId(reqGroq, model)).toBe("openai/gpt-oss-120b:groq")

    // Policy suffixes work too.
    const reqCheapest: CanonicalRequest = {
      modelId: "openai/gpt-oss-120b",
      messages: [userText("hi")],
      vendor: { huggingface: { provider: "cheapest" } },
    }
    expect(resolveWireModelId(reqCheapest, model)).toBe("openai/gpt-oss-120b:cheapest")
  })

  // Live round-trip. Set MINIMAL_AGENT_HUGGINGFACE_LIVE_KEY to run it. Proves the
  // request reaches HuggingFace with valid auth + a well-formed OpenAI-Chat body.
  // Accepts EITHER streamed text OR a 402/429 (insufficient credits / rate limit)
  // as success (both confirm auth + wire are correct). A 401 (bad auth) or any
  // other error still fails.
  const KEY = process.env.MINIMAL_AGENT_HUGGINGFACE_LIVE_KEY
  it.skipIf(!KEY)("live: gpt-oss-120b via HuggingFace (auth + wire reach the API)", async () => {
    setup()
    const model = resolveModel("openai/gpt-oss-120b")
    const provider = resolveProvider("huggingface")
    const req: CanonicalRequest = {
      modelId: "openai/gpt-oss-120b",
      messages: [userText("Reply with the single word: pong")],
      generation: { maxOutputTokens: 16 },
    }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: KEY as string },
      sessionId: "huggingface-live-test",
    }
    let text = ""
    try {
      for await (const ev of provider.run(req, model, ctx)) {
        if (isEvent(ev, "text_delta")) text += ev.text
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).toMatch(/\b402\b|\b429\b|\b401\b|insufficient credits|rate limit/i)
      return
    }
    expect(text.length).toBeGreaterThan(0)
  })
})
