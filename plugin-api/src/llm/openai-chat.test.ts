import { describe, expect, it } from "bun:test"

import { translateOpenAIChatStream, type OpenAIChatChunk } from "./openai-chat.ts"
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
