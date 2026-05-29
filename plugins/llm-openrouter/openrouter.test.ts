/**
 * OpenRouter provider tests.
 *
 * Offline: registry + reuse of llm-openai's translator/validator. The live
 * test is gated on `OPENROUTER_KEY` (skipped unless the env var is set);
 * restart the session with it exported to exercise the real round-trip.
 */

import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import {
  type CanonicalEvent,
  type CanonicalRequest,
  clearModelRegistry,
  clearProviderRegistry,
  isEvent,
  resolveModel,
  resolveProvider,
  type RunContext,
  userText,
} from "../../src/llm/index.ts"
import { parseSse } from "../../src/llm/streaming/sse-parser.ts"
import { type OpenAIChatChunk, translateOpenAIChatStream } from "../llm-openai/index.ts"
import { bootstrapOpenRouter } from "./adapter.ts"

function setup() {
  clearModelRegistry()
  clearProviderRegistry()
  bootstrapOpenRouter()
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

describe("llm-openrouter (OpenAI-compatible gateway, reuses llm-openai's wire layer)", () => {
  it("registers slugs on the shared openai-chat-completions surface", () => {
    setup()
    const m = resolveModel("openai/gpt-4o-mini")
    expect(m.providerId).toBe("openrouter")
    expect(m.surfaceId).toBe("openai-chat-completions")
    expect(m.vendorIds?.firstParty).toBe("openai/gpt-4o-mini")

    const adapter = resolveProvider("openrouter")
    expect(adapter.surfaces).toContain("openai-chat-completions")
    expect(adapter.displayName).toBe("OpenRouter")
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
    const adapter = resolveProvider("openrouter")
    const req: CanonicalRequest = { modelId: "openai/gpt-4o-mini", messages: [userText("hi")] }
    expect(adapter.validate(req, resolveModel("openai/gpt-4o-mini")).ok).toBe(true)
  })

  // Live round-trip. Set OPENROUTER_KEY to run it. Proves the request
  // reaches OpenRouter with valid auth + a well-formed OpenAI-Chat body.
  // Like the Opus-4.8 `--fast` e2e, it accepts EITHER streamed text OR a
  // 402 "insufficient credits" response as success (both confirm auth +
  // wire are correct; completing the round-trip just needs account
  // credits). A 401 (bad auth) or any other error still fails.
  const KEY = process.env.OPENROUTER_KEY
  it.skipIf(!KEY)("live: gpt-4o-mini via OpenRouter (auth + wire reach the API)", async () => {
    setup()
    const model = resolveModel("openai/gpt-4o-mini")
    const provider = resolveProvider("openrouter")
    const req: CanonicalRequest = {
      modelId: "openai/gpt-4o-mini",
      messages: [userText("Reply with the single word: pong")],
      generation: { maxOutputTokens: 16 },
    }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: KEY as string },
      sessionId: "openrouter-live-test",
    }
    let text = ""
    try {
      for await (const ev of provider.run(req, model, ctx)) {
        if (isEvent(ev, "text_delta")) text += ev.text
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      expect(msg).toMatch(/\b402\b|insufficient credits/i)
      return
    }
    expect(text.length).toBeGreaterThan(0)
  })
})
