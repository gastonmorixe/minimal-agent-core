import { describe, expect, it } from "bun:test"

import { buildOpenAIChatBody, translateOpenAIChatStream, type OpenAIChatChunk } from "./openai-chat.ts"
import type { CanonicalRequest, OutputFormat } from "./canonical-request.ts"
import type { ModelView } from "../types/host-capabilities.ts"
import type { CanonicalEvent } from "./canonical-events.ts"

async function* fromChunks(chunks: OpenAIChatChunk[]): AsyncIterable<OpenAIChatChunk> {
  for (const c of chunks) yield c
}

async function collect(stream: AsyncIterable<CanonicalEvent>): Promise<CanonicalEvent[]> {
  const out: CanonicalEvent[] = []
  for await (const ev of stream) out.push(ev)
  return out
}

function types(evs: CanonicalEvent[]): string[] {
  return evs.map((e) => e.type)
}

/** The exact keepalive frame an MLX/oMLX server emits during prefill. */
function keepalive(): OpenAIChatChunk {
  return {
    id: "chatcmpl-keepalive",
    object: "chat.completion.chunk",
    created: 0,
    model: "keepalive",
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  }
}

function textChunk(id: string, content: string): OpenAIChatChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: 1,
    model: "test-model",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  }
}

function stopChunk(id: string): OpenAIChatChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: 2,
    model: "test-model",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
  }
}

describe("translateOpenAIChatStream reasoning → text boundary", () => {
  /**
   * DeepSeek / OpenCode Go emit the first visible token in the SAME chunk that
   * clears reasoning (`content:"Pre", reasoning_content:null`). Emitting
   * text_delta BEFORE thinking_stop makes the REPL's onThinkingStop insert
   * blank-line separators mid-word (orphaned "Pre" / "Plug" / "All" rows).
   * Mirror Ollama: close thinking before any content starts.
   */
  function reasoningChunk(id: string, reasoning: string): OpenAIChatChunk {
    return {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-pro",
      choices: [
        {
          index: 0,
          delta: { content: null, reasoning_content: reasoning },
          finish_reason: null,
        },
      ],
    }
  }

  function contentAfterReasoning(id: string, content: string): OpenAIChatChunk {
    return {
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-pro",
      choices: [
        {
          index: 0,
          delta: { content, reasoning_content: null },
          finish_reason: null,
        },
      ],
    }
  }

  it("emits thinking_stop before text_start when content arrives with reasoning_content:null", async () => {
    const evs = await collect(
      translateOpenAIChatStream(
        fromChunks([
          reasoningChunk("r1", "plan."),
          contentAfterReasoning("r1", "Pre"),
          contentAfterReasoning("r1", "-existing"),
          stopChunk("r1"),
        ]),
      ),
    )
    const t = types(evs)
    const stopIdx = t.indexOf("thinking_stop")
    const textStartIdx = t.indexOf("text_start")
    const firstTextIdx = t.indexOf("text_delta")
    expect(stopIdx).toBeGreaterThanOrEqual(0)
    expect(textStartIdx).toBeGreaterThan(stopIdx)
    expect(firstTextIdx).toBeGreaterThan(stopIdx)
    expect(evs.filter((e) => e.type === "thinking_stop")).toHaveLength(1)
    const text = evs
      .filter((e): e is CanonicalEvent & { type: "text_delta" } => e.type === "text_delta")
      .map((e) => e.text)
      .join("")
    expect(text).toBe("Pre-existing")
  })

  it("closes open thinking when content arrives without a reasoning_content field", async () => {
    const contentOnly: OpenAIChatChunk = {
      id: "r1",
      object: "chat.completion.chunk",
      created: 1,
      model: "deepseek-v4-pro",
      choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }],
    }
    const evs = await collect(
      translateOpenAIChatStream(fromChunks([reasoningChunk("r1", "think"), contentOnly, stopChunk("r1")])),
    )
    const t = types(evs)
    expect(t.indexOf("thinking_stop")).toBeLessThan(t.indexOf("text_start"))
  })
})

describe("translateOpenAIChatStream keepalive handling", () => {
  it("emits a ping for a prefill keepalive chunk (empty-delta choice) so the watchdog sees activity", async () => {
    // message_start is minted from the FIRST chunk regardless, so drive the
    // keepalive as a later frame to isolate its own translation.
    const evs = await collect(
      translateOpenAIChatStream(
        fromChunks([textChunk("c1", "Hi"), keepalive(), keepalive(), stopChunk("c1")]),
      ),
    )

    const pings = evs.filter((e) => e.type === "ping")
    expect(pings.length).toBe(2)

    // The keepalives must not corrupt the content stream: exactly one text
    // delta with the real content, no phantom text blocks from the empty
    // `content:""` deltas.
    const textDeltas = evs.filter((e) => e.type === "text_delta") as Array<{ text: string }>
    expect(textDeltas.map((t) => t.text)).toEqual(["Hi"])
  })

  it("emits a ping for a choice-less keepalive/usage chunk", async () => {
    const noChoice: OpenAIChatChunk = {
      id: "chatcmpl-ka",
      object: "chat.completion.chunk",
      created: 0,
      model: "keepalive",
      // no `choices` array at all
    }
    const evs = await collect(
      translateOpenAIChatStream(fromChunks([textChunk("c1", "yo"), noChoice, stopChunk("c1")])),
    )
    expect(evs.filter((e) => e.type === "ping").length).toBe(1)
  })

  it("does not emit a ping when a chunk produces real content", async () => {
    const evs = await collect(
      translateOpenAIChatStream(fromChunks([textChunk("c1", "hello"), stopChunk("c1")])),
    )
    expect(evs.filter((e) => e.type === "ping").length).toBe(0)
  })

  it("still terminates with message_delta + message_stop after keepalives", async () => {
    const evs = await collect(
      translateOpenAIChatStream(fromChunks([keepalive(), keepalive(), stopChunk("c1")])),
    )
    const t = types(evs)
    expect(t[0]).toBe("message_start")
    expect(t[t.length - 2]).toBe("message_delta")
    expect(t[t.length - 1]).toBe("message_stop")
    // Two keepalives before any content → two pings.
    expect(evs.filter((e) => e.type === "ping").length).toBe(2)
  })
})

describe("translateOpenAIChatStream usage (canonical inputTokens excludes cached tokens)", () => {
  /** Golden final usage chunk: 1500 prompt tokens, 200 of them cached. */
  function usageChunk(usage: NonNullable<OpenAIChatChunk["usage"]>): OpenAIChatChunk {
    return { id: "c1", object: "chat.completion.chunk", created: 1, model: "test-model", choices: [], usage }
  }

  async function finalUsage(usage: NonNullable<OpenAIChatChunk["usage"]>) {
    const evs = await collect(
      translateOpenAIChatStream(fromChunks([textChunk("c1", "ok"), stopChunk("c1"), usageChunk(usage)])),
    )
    const delta = evs.find((e) => e.type === "message_delta")
    return delta?.type === "message_delta" ? delta.usage : undefined
  }

  it("maps prompt 1500 with 200 cached to input 1300 + cache read 200, so used is 1500", async () => {
    const usage = await finalUsage({
      prompt_tokens: 1500,
      completion_tokens: 40,
      total_tokens: 1540,
      prompt_tokens_details: { cached_tokens: 200 },
      completion_tokens_details: { reasoning_tokens: 10 },
    })
    expect(usage).toEqual({ inputTokens: 1300, outputTokens: 40, cacheReadTokens: 200, reasoningTokens: 10 })
    const used = (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheCreationTokens ?? 0)
    expect(used).toBe(1500)
  })

  it("keeps all prompt tokens as input when the provider reports no cached tokens", async () => {
    const usage = await finalUsage({ prompt_tokens: 1500, completion_tokens: 40 })
    expect(usage).toEqual({ inputTokens: 1500, outputTokens: 40 })
  })
})

// SPEC-ONESHOT T4b: strict structured output on the shared Chat builder.
function viewWith(structuredOutputs: boolean): ModelView {
  return {
    id: "compat-model",
    providerId: "compat",
    surfaceId: "chat",
    displayName: "Compat",
    capabilities: {
      structuredOutputs,
      maxOutputTokens: 4096,
      acceptsTemperature: true,
      acceptsTopP: true,
      acceptsSeed: true,
      acceptsStopSequences: true,
      effort: { levels: [] },
    },
    pricing: {},
  } as unknown as ModelView
}

function bodyFor(outputFormat: OutputFormat, structuredOutputs = true) {
  const req: CanonicalRequest = {
    modelId: "compat-model",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    outputFormat,
  } as CanonicalRequest
  return buildOpenAIChatBody(req, viewWith(structuredOutputs))
}

describe("buildOpenAIChatBody response_format (strict gate + name)", () => {
  const schema = { type: "object", properties: { a: { type: "string" } } }

  it("sends strict:true when asked AND the model has structuredOutputs", () => {
    const body = bodyFor({ type: "json_schema", schema, strict: true, name: "Reply" })
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "Reply", schema, strict: true },
    })
  })

  it("omits strict when the model lacks structuredOutputs", () => {
    const body = bodyFor({ type: "json_schema", schema, strict: true, name: "Reply" }, false)
    const fmt = body.response_format as { json_schema: Record<string, unknown> }
    expect("strict" in fmt.json_schema).toBe(false)
  })

  it("omits strict when the request does not ask for it", () => {
    for (const strict of [undefined, false]) {
      const body = bodyFor({ type: "json_schema", schema, strict, name: "Reply" })
      const fmt = body.response_format as { json_schema: Record<string, unknown> }
      expect("strict" in fmt.json_schema).toBe(false)
    }
  })

  it("defaults the name to 'output' (not 'response')", () => {
    const body = bodyFor({ type: "json_schema", schema })
    const fmt = body.response_format as { json_schema: { name: string } }
    expect(fmt.json_schema.name).toBe("output")
  })

  it("sanitizes the name: invalid chars to '_', max 64, empty falls back", () => {
    const named = (name: string) =>
      (bodyFor({ type: "json_schema", schema, name }).response_format as {
        json_schema: { name: string }
      }).json_schema.name
    expect(named("my schema.v1!")).toBe("my_schema_v1_")
    expect(named("a".repeat(80))).toBe("a".repeat(64))
    expect(named("")).toBe("output")
    expect(named("ok-Name_9")).toBe("ok-Name_9")
  })

  it("keeps json_object and text unchanged", () => {
    expect(bodyFor({ type: "json_object" }).response_format).toEqual({ type: "json_object" })
    expect(bodyFor({ type: "text" }).response_format).toEqual({ type: "text" })
  })
})
