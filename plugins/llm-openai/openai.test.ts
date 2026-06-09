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
import { buildOpenAIChatBody } from "./chat/request-body.ts"
import { type OpenAIChatChunk, translateOpenAIChatStream } from "./chat/response-stream.ts"
import { registerOpenAIModels } from "./models.ts"
import { buildOpenAIResponsesBody } from "./responses/request-body.ts"
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
    expect(chat.surfaceId).toBe("openai-chat-completions")
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
    expect(adapter.surfaces).toContain("openai-chat-completions")
    expect(adapter.surfaces).toContain("openai-responses")
    expect(findModel("gpt-4o")?.surfaceId).toBe("openai-chat-completions")
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

describe("translateOpenAIResponsesStream — error events are retryable & tagged", () => {
  async function replayRaw(raw: string): Promise<CanonicalEvent[]> {
    return collect(translateOpenAIResponsesStream(parseSse<OpenAIResponsesEvent>(sseStream(raw))))
  }

  it("a `rate_limit_exceeded` error event surfaces a retryable stream_error tagged rate_limit_error", async () => {
    const raw =
      'data: {"type":"error","error":{"code":"rate_limit_exceeded","message":"Rate limit reached"}}\n\n'
    const events = await replayRaw(raw)
    const err = firstOf(events, "stream_error")
    expect(err).toBeDefined()
    // The fix: NOT retryable:false anymore — it retries on the slow curve.
    expect(err?.retryable).toBe(true)
    expect(err?.category).toBe("rate_limit")
    expect(err?.upstreamType).toBe("rate_limit_error")
  })

  it("a `response.failed` with a server_error surfaces a retryable overloaded stream_error", async () => {
    const raw =
      'data: {"type":"response.failed","response":{"id":"r1","status":"failed","error":{"code":"server_error","message":"upstream"}}}\n\n'
    const events = await replayRaw(raw)
    const err = firstOf(events, "stream_error")
    expect(err?.retryable).toBe(true)
    expect(err?.category).toBe("overloaded")
    expect(err?.upstreamType).toBe("overloaded_error")
  })

  it("an `insufficient_quota` error event surfaces a TERMINAL (non-retryable) stream_error", async () => {
    // Regression for 2026-05-30 session 50efb996: out-of-credit account got
    // `insufficient_quota` on every request (HTTP 200 SSE error frame) and the
    // agent retried it 36 times over an hour. Billing exhaustion is terminal:
    // retryable:false, no upstream retry tag, so it propagates and stops.
    const raw =
      'data: {"type":"error","error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}\n\n'
    const events = await replayRaw(raw)
    const err = firstOf(events, "stream_error")
    expect(err).toBeDefined()
    expect(err?.retryable).toBe(false)
    expect(err?.category).toBe("billing")
    expect(err?.upstreamType).toBeUndefined()
  })

  it("a `response.failed` with insufficient_quota is also terminal", async () => {
    const raw =
      'data: {"type":"response.failed","response":{"id":"r1","status":"failed","error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}}\n\n'
    const events = await replayRaw(raw)
    const err = firstOf(events, "stream_error")
    expect(err?.retryable).toBe(false)
    expect(err?.category).toBe("billing")
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
      {
        role: "user",
        content: [{ type: "audio", source: { kind: "base64", format: "wav", data: "AA" } }],
      },
    ],
  })

  it("gpt-4o accepts audio input (text+image+audio modality)", () => {
    bootstrap()
    expect(resolveProvider("openai").validate(audioReq("gpt-4o"), resolveModel("gpt-4o")).ok).toBe(
      true,
    )
  })

  it("gpt-4o-mini rejects audio input (no audio modality)", () => {
    bootstrap()
    const res = resolveProvider("openai").validate(
      audioReq("gpt-4o-mini"),
      resolveModel("gpt-4o-mini"),
    )
    expect(res.ok).toBe(false)
    expect(res.errors.some((e) => e.capability === "modalities")).toBe(true)
  })
})

describe("multimodal request encoding", () => {
  function bootstrap() {
    clearModelRegistry()
    clearProviderRegistry()
    bootstrapOpenAI()
  }

  it("Chat: base64 image → image_url data URL; url image → plain url", () => {
    bootstrap()
    const base64: CanonicalRequest = {
      modelId: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AAAA" } },
          ],
        },
      ],
    }
    const j1 = JSON.stringify(buildOpenAIChatBody(base64, resolveModel("gpt-4o")))
    expect(j1).toContain('"type":"image_url"')
    expect(j1).toContain("data:image/png;base64,AAAA")

    const url: CanonicalRequest = {
      modelId: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { kind: "url", url: "https://x/y.png" } }],
        },
      ],
    }
    expect(JSON.stringify(buildOpenAIChatBody(url, resolveModel("gpt-4o")))).toContain(
      '"url":"https://x/y.png"',
    )
  })

  it("Responses: url image → input_image; file_id → input_file", () => {
    bootstrap()
    const req: CanonicalRequest = {
      modelId: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { kind: "url", url: "https://x/y.png" } },
            { type: "file", source: { kind: "file_id", fileId: "file_123" } },
          ],
        },
      ],
    }
    const j = JSON.stringify(buildOpenAIResponsesBody(req, resolveModel("gpt-5.5")))
    expect(j).toContain('"type":"input_image"')
    expect(j).toContain("https://x/y.png")
    expect(j).toContain('"type":"input_file"')
    expect(j).toContain('"file_id":"file_123"')
  })

  it("Responses: base64 image → input_image data URL; file_id image → input_image file_id", () => {
    bootstrap()
    const b64: CanonicalRequest = {
      modelId: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { kind: "base64", mediaType: "image/jpeg", data: "QUJD" } },
          ],
        },
      ],
    }
    const jb = JSON.stringify(buildOpenAIResponsesBody(b64, resolveModel("gpt-5.5")))
    expect(jb).toContain('"type":"input_image"')
    expect(jb).toContain("data:image/jpeg;base64,QUJD")

    const fid: CanonicalRequest = {
      modelId: "gpt-5.5",
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { kind: "file_id", fileId: "file_img_9" } }],
        },
      ],
    }
    const jf = JSON.stringify(buildOpenAIResponsesBody(fid, resolveModel("gpt-5.5")))
    // image-by-file-id is input_image (NOT input_file, which is for documents)
    expect(jf).toContain('"type":"input_image"')
    expect(jf).toContain('"file_id":"file_img_9"')
    expect(jf).not.toContain('"type":"input_file"')
  })
})

describe("translateOpenAIResponsesStream — truncated stream (no terminal event)", () => {
  async function replayRaw(raw: string): Promise<CanonicalEvent[]> {
    return collect(translateOpenAIResponsesStream(parseSse<OpenAIResponsesEvent>(sseStream(raw))))
  }

  // Regression: session 50efb996 (2026-05-30, gpt-5.5, turn 036). The server
  // sent created → in_progress → output_item.added(reasoning) → keepalive, then
  // closed the connection with NO response.completed / failed / incomplete.
  // The old translator fell through to a stopReason=null end_turn, the agent
  // loop saw zero tool_use blocks, and the turn silently ended mid-task.
  it("a stream that closes without a terminal event yields a RETRYABLE stream_error", async () => {
    const raw = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_x","model":"gpt-5.5"}}\n\n',
      'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_x","model":"gpt-5.5"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"rs_1","type":"reasoning","summary":[]}}\n\n',
      'event: keepalive\ndata: {"type":"keepalive","sequence_number":3}\n\n',
    ].join("")
    const events = await replayRaw(raw)
    const err = firstOf(events, "stream_error")
    expect(err).toBeDefined()
    expect(err?.retryable).toBe(true)
    // Must NOT emit a clean end_turn message_delta : that's what made the loop
    // exit silently. The truncation guard returns before the message_delta.
    expect(finalDelta(events)).toBeUndefined()
    expect(events.some((e) => isEvent(e, "message_stop"))).toBe(false)
  })

  it("a normal completed stream still ends cleanly (no spurious truncation error)", async () => {
    const raw = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_x","model":"gpt-5.5"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_x","status":"completed"}}\n\n',
    ].join("")
    const events = await replayRaw(raw)
    expect(firstOf(events, "stream_error")).toBeUndefined()
    expect(finalDelta(events)?.stopReason).toBe("end_turn")
  })

  // The cosmetic stopReason latch: a completed stream that carried a
  // function_call must report stopReason="tool_use", even though each call's
  // output_item.done already cleared its functionBlocks entry by completion.
  it("a completed stream with a function_call reports stopReason=tool_use", async () => {
    const raw = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_x","model":"gpt-5.5"}}\n\n',
      'event: response.output_item.added\ndata: {"type":"response.output_item.added","output_index":0,"item":{"id":"fc_1","call_id":"call_1","type":"function_call","name":"Bash"}}\n\n',
      'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","output_index":0,"item_id":"fc_1","delta":"{\\"command\\":\\"ls\\"}"}\n\n',
      'event: response.output_item.done\ndata: {"type":"response.output_item.done","output_index":0,"item":{"id":"fc_1","call_id":"call_1","type":"function_call","name":"Bash","arguments":"{\\"command\\":\\"ls\\"}"}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_x","status":"completed"}}\n\n',
    ].join("")
    const events = await replayRaw(raw)
    expect(firstOf(events, "tool_use_stop")).toBeDefined()
    expect(finalDelta(events)?.stopReason).toBe("tool_use")
  })
})
