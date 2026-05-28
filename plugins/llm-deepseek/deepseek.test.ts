/**
 * DeepSeek provider tests — focused on the cross-plugin reuse of
 * `plugins/llm-openai`'s wire layer.
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
  userText,
} from "../../src/llm/index.ts"
import { parseSse } from "../../src/llm/streaming/sse-parser.ts"
import { type OpenAIChatChunk, translateOpenAIChatStream } from "../llm-openai/index.ts"
import { bootstrapDeepSeek } from "./adapter.ts"

// Reuse llm-openai's captured Chat Completions fixture: the whole point is
// that DeepSeek runs through the identical translator.
function openaiChatPong(): string {
  return readFileSync(join(import.meta.dir, "../llm-openai/__fixtures__/chat-pong.sse"), "utf-8")
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

function setup() {
  clearModelRegistry()
  clearProviderRegistry()
  bootstrapDeepSeek()
}

describe("llm-deepseek (OpenAI-compatible, reuses llm-openai's wire layer)", () => {
  it("registers deepseek-chat on the shared openai-chat surface", () => {
    setup()
    const model = resolveModel("deepseek-chat")
    expect(model.providerId).toBe("deepseek")
    expect(model.surfaceId).toBe("openai-chat")
    expect(model.vendorIds?.firstParty).toBe("deepseek-chat")

    const adapter = resolveProvider("deepseek")
    expect(adapter.surfaces).toContain("openai-chat")
    expect(adapter.displayName).toBe("DeepSeek")
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
    const adapter = resolveProvider("deepseek")
    const req: CanonicalRequest = { modelId: "deepseek-chat", messages: [userText("hi")] }
    expect(adapter.validate(req, resolveModel("deepseek-chat")).ok).toBe(true)
  })
})
