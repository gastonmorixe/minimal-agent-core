/**
 * OpenAI provider tests.
 *
 * Registry + bootstrap + validation, plus end-to-end replay of the live
 * 2026-05-28 SSE fixtures through the Chat and Responses translators. The
 * fixtures carry OpenAI's per-chunk `obfuscation` padding and (for
 * Responses) `event:` lines; the generic SSE parser ignores both.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  type CanonicalEvent,
  type CanonicalRequest,
  clearModelRegistry,
  clearProviderRegistry,
  findModel,
  isEvent,
  resolveModel,
  resolveProvider,
  userText,
} from "../../src/llm/index.ts"
import { parseSse } from "../../src/llm/streaming/sse-parser.ts"

import { bootstrapOpenAI } from "./adapter.ts"
import { type OpenAIChatChunk, translateOpenAIChatStream } from "./chat/response-stream.ts"
import { registerOpenAIModels } from "./models.ts"
import {
  type OpenAIResponsesEvent,
  translateOpenAIResponsesStream,
} from "./responses/response-stream.ts"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixture(name: string): string {
  return readFileSync(join(import.meta.dir, "__fixtures__", name), "utf-8")
}

/** Wrap a raw SSE string as a one-chunk ReadableStream for `parseSse`. */
function sseStream(raw: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(raw)
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}

async function collect(events: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = []
  for await (const ev of events) out.push(ev)
  return out
}

function replayChat(name: string): Promise<CanonicalEvent[]> {
  return collect(translateOpenAIChatStream(parseSse<OpenAIChatChunk>(sseStream(fixture(name)))))
}

function replayResponses(name: string): Promise<CanonicalEvent[]> {
  return collect(
    translateOpenAIResponsesStream(parseSse<OpenAIResponsesEvent>(sseStream(fixture(name)))),
  )
}

/** First event of a given discriminant, narrowed to its concrete type. */
function firstOf<T extends CanonicalEvent["type"]>(
  events: CanonicalEvent[],
  type: T,
): Extract<CanonicalEvent, { type: T }> | undefined {
  return events.find((e): e is Extract<CanonicalEvent, { type: T }> => e.type === type)
}

function joinedText(events: CanonicalEvent[]): string {
  let out = ""
  for (const e of events) if (isEvent(e, "text_delta")) out += e.text
  return out
}

function finalDelta(events: CanonicalEvent[]) {
  return firstOf([...events].reverse(), "message_delta")
}

// ---------------------------------------------------------------------------
// Registry + bootstrap
// ---------------------------------------------------------------------------

describe("registerOpenAIModels", () => {
  it("registers gpt-5.5 on the Responses surface with the live capability + pricing data", () => {
    clearModelRegistry()
    clearProviderRegistry()
    const ids = registerOpenAIModels()

    expect(ids).toContain("gpt-5.5")
    const m = resolveModel("gpt-5.5")
    expect(m.providerId).toBe("openai")
    expect(m.surfaceId).toBe("openai-responses")
    expect(m.capabilities.contextWindow).toBe(1_050_000)
    expect(m.capabilities.maxOutputTokens).toBe(128_000)
    expect(m.capabilities.effort.levels).toEqual(["low", "medium", "high", "xhigh"])
    expect(m.capabilities.thinking.visible).toBe(true)
    // $5 in / $30 out (NOT $5/$25 — that's Anthropic Opus).
    expect(m.pricing.inputUSD).toBe(5)
    expect(m.pricing.outputUSD).toBe(30)
    expect(m.pricing.cacheReadUSD).toBe(0.5)
  })

  it("registers gpt-5.5 a SECOND time on the Chat surface, sending the real model id", () => {
    clearModelRegistry()
    clearProviderRegistry()
    registerOpenAIModels()

    const chat = resolveModel("gpt-5.5-chat")
    expect(chat.surfaceId).toBe("openai-chat")
    // The -chat alias-id maps to the real OpenAI model id on the wire.
    expect(chat.vendorIds?.firstParty).toBe("gpt-5.5")
    // Chat surface can't stream reasoning back.
    expect(chat.capabilities.thinking.visible).toBe(false)
    expect(chat.capabilities.serverSideHistory).toBe(false)
  })
})

describe("bootstrapOpenAI", () => {
  it("registers the adapter with both surfaces and the model catalog", () => {
    clearModelRegistry()
    clearProviderRegistry()
    bootstrapOpenAI()

    const adapter = resolveProvider("openai")
    expect(adapter.surfaces).toContain("openai-chat")
    expect(adapter.surfaces).toContain("openai-responses")
    expect(findModel("gpt-4o")?.surfaceId).toBe("openai-chat")
    expect(findModel("o3")?.surfaceId).toBe("openai-responses")
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateOpenAIRequest", () => {
  function setup() {
    clearModelRegistry()
    clearProviderRegistry()
    bootstrapOpenAI()
  }

  it("accepts a plain Responses request on gpt-5.5", () => {
    setup()
    const adapter = resolveProvider("openai")
    const model = resolveModel("gpt-5.5")
    const req: CanonicalRequest = {
      modelId: "gpt-5.5",
      messages: [userText("hi")],
      effort: "xhigh",
    }
    expect(adapter.validate(req, model).ok).toBe(true)
  })

  it("rejects previousResponseId on the Chat surface (no server-side history)", () => {
    setup()
    const adapter = resolveProvider("openai")
    const model = resolveModel("gpt-5.5-chat")
    const req: CanonicalRequest = {
      modelId: "gpt-5.5-chat",
      messages: [userText("hi")],
      previousResponseId: "resp_123",
    }
    const res = adapter.validate(req, model)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.capability === "serverSideHistory")).toBe(true)
  })

  it("rejects an unsupported effort level", () => {
    setup()
    const adapter = resolveProvider("openai")
    const model = resolveModel("gpt-4o")
    const req: CanonicalRequest = { modelId: "gpt-4o", messages: [userText("hi")], effort: "high" }
    const res = adapter.validate(req, model)
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.capability === "effort")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Chat Completions fixture replays
// ---------------------------------------------------------------------------

describe("translateOpenAIChatStream (fixtures)", () => {
  it("chat-pong: streams text 'pong' + final usage", async () => {
    const events = await replayChat("chat-pong.sse")
    expect(joinedText(events)).toBe("pong")
    expect(events.some((e) => isEvent(e, "message_start"))).toBe(true)
    const delta = finalDelta(events)
    expect(delta?.stopReason).toBe("end_turn")
    expect(delta?.usage.inputTokens).toBe(14)
    expect(delta?.usage.outputTokens).toBe(1)
  })

  it("chat-tool-use: emits tool_use_start + assembled input + tool_use stop reason", async () => {
    const events = await replayChat("chat-tool-use.sse")
    const start = firstOf(events, "tool_use_start")
    expect(start?.name).toBe("get_weather")

    const stop = firstOf(events, "tool_use_stop")
    expect(JSON.stringify(stop?.input)).toContain("New York City")

    expect(finalDelta(events)?.stopReason).toBe("tool_use")
  })

  it("chat-vision: produces assistant text describing the image", async () => {
    const events = await replayChat("chat-vision.sse")
    expect(joinedText(events).length).toBeGreaterThan(0)
  })

  it("chat-structured-output: streams the JSON object as text", async () => {
    const events = await replayChat("chat-structured-output.sse")
    expect(joinedText(events).length).toBeGreaterThan(0)
    expect(() => JSON.parse(joinedText(events))).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Responses API fixture replays
// ---------------------------------------------------------------------------

describe("translateOpenAIResponsesStream (fixtures)", () => {
  it("responses-pong: streams text 'pong' + final usage", async () => {
    const events = await replayResponses("responses-pong.sse")
    expect(joinedText(events)).toBe("pong")
    const delta = finalDelta(events)
    expect(delta?.usage.inputTokens).toBe(13)
    expect(delta?.usage.outputTokens).toBe(5)
  })

  it("responses-reasoning-high: surfaces the answer + reasoning-token count", async () => {
    const events = await replayResponses("responses-reasoning-high.sse")
    expect(joinedText(events)).toBe("391")
    expect(finalDelta(events)?.usage.reasoningTokens).toBe(20)
  })

  it("responses-reasoning: low-effort variant still yields the answer", async () => {
    const events = await replayResponses("responses-reasoning.sse")
    expect(joinedText(events).length).toBeGreaterThan(0)
  })

  it("responses-tool-use: emits tool_use_start + assembled input", async () => {
    const events = await replayResponses("responses-tool-use.sse")
    const start = firstOf(events, "tool_use_start")
    expect(start?.name.length ?? 0).toBeGreaterThan(0)
    expect(firstOf(events, "tool_use_stop")).toBeDefined()
  })

  it("responses-vision: produces assistant text", async () => {
    const events = await replayResponses("responses-vision.sse")
    expect(joinedText(events).length).toBeGreaterThan(0)
  })

  it("responses-structured: streams a parseable JSON object as text", async () => {
    const events = await replayResponses("responses-structured.sse")
    expect(() => JSON.parse(joinedText(events))).not.toThrow()
  })
})

describe("validateOpenAIRequest — modality gating", () => {
  function bootstrap() {
    clearModelRegistry()
    clearProviderRegistry()
    bootstrapOpenAI()
  }
  const audioReq = (id: string): CanonicalRequest => ({
    modelId: id,
    messages: [
      { role: "user", content: [{ type: "audio", source: { kind: "base64", format: "wav", data: "AA" } }] },
    ],
  })

  it("gpt-4o accepts audio input (text+image+audio modality)", () => {
    bootstrap()
    expect(resolveProvider("openai").validate(audioReq("gpt-4o"), resolveModel("gpt-4o")).ok).toBe(true)
  })

  it("gpt-4o-mini rejects audio input (no audio modality)", () => {
    bootstrap()
    const res = resolveProvider("openai").validate(audioReq("gpt-4o-mini"), resolveModel("gpt-4o-mini"))
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.capability === "modalities")).toBe(true)
  })
})
