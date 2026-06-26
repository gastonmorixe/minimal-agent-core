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
import { NetworkResponse } from "../../src/network/index.ts"
import { type AnthropicStreamEvent, translateAnthropicStream } from "../llm-anthropic/index.ts"
import {
  buildOpenAIChatBody,
  type OpenAIChatChunk,
  translateOpenAIChatStream,
} from "../llm-openai/index.ts"

import { bootstrapOpencode, opencodeProviderPlugin } from "./adapter.ts"
import {
  buildOpencodeApiKeyCredential,
  OPENCODE_API_KEY_AUTH,
  opencodeApiKeyAuth,
  readOpencodeApiKey,
} from "./auth.ts"

function setup() {
  clearModelRegistry()
  clearProviderRegistry()
  bootstrapOpencode()
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

function anthropicPong(): string {
  return readFileSync(
    join(import.meta.dir, "../llm-anthropic/__fixtures__/conversation-opus48.res-body.sse"),
    "utf-8",
  )
}

describe("llm-opencode (dual-surface provider: OpenAI Chat + Anthropic Messages)", () => {
  it("exposes API-key auth and no OAuth login strategy", () => {
    expect(opencodeProviderPlugin.apiKeyAuth).toBe(opencodeApiKeyAuth)
    expect(opencodeProviderPlugin.oauthLogin).toBeUndefined()
  })

  it("declares the OpenCode API-key credential codec", () => {
    expect(opencodeApiKeyAuth.serviceId).toBe(OPENCODE_API_KEY_AUTH.serviceId)
    expect(opencodeApiKeyAuth.displayName).toBe("OpenCode Go API Key")

    const write = buildOpencodeApiKeyCredential("og-test-key")
    expect(write).toEqual({
      serviceId: "opencode-api-key",
      displayName: "OpenCode Go API Key",
      secrets: { tokenType: "api-key", apiKey: "og-test-key" },
    })
    expect(readOpencodeApiKey(write.secrets)).toBe("og-test-key")
    expect(readOpencodeApiKey({ tokenType: "api-key" })).toBeNull()
    expect(opencodeApiKeyAuth.inspectCredential?.(write.secrets)).toEqual({ usable: true })
    expect(opencodeApiKeyAuth.inspectCredential?.({ tokenType: "api-key" })).toEqual({
      usable: false,
    })
  })

  it("registers models on both surfaces", () => {
    setup()

    const chatModel = resolveModel("deepseek-v4-flash")
    expect(chatModel.providerId).toBe("opencode")
    expect(chatModel.surfaceId).toBe("openai-chat-completions")
    expect(chatModel.vendorIds?.firstParty).toBe("deepseek-v4-flash")

    const msgModel = resolveModel("qwen3.7-max")
    expect(msgModel.providerId).toBe("opencode")
    expect(msgModel.surfaceId).toBe("anthropic-messages")
    expect(msgModel.vendorIds?.firstParty).toBe("qwen3.7-max")

    const adapter = resolveProvider("opencode")
    expect(adapter.surfaces).toContain("openai-chat-completions")
    expect(adapter.surfaces).toContain("anthropic-messages")
    expect(adapter.displayName).toBe("OpenCode Go")
  })

  it("registers all known model IDs", () => {
    setup()
    const ids = [
      "deepseek-v4-pro",
      "deepseek-v4-flash",
      "glm-5.2",
      "glm-5.1",
      "glm-5",
      "kimi-k2.7-code",
      "kimi-k2.6",
      "mimo-v2.5",
      "mimo-v2.5-pro",
      "minimax-m3",
      "minimax-m2.7",
      "minimax-m2.5",
      "qwen3.7-max",
      "qwen3.7-plus",
      "qwen3.6-plus",
    ]
    for (const id of ids) {
      const m = resolveModel(id)
      expect(m.providerId).toBe("opencode")
    }
  })

  it("registers ad-hoc slugs on demand", () => {
    setup()
    opencodeProviderPlugin.registerAdHocModel?.("deepseek-v4-ultra")
    const m = resolveModel("deepseek-v4-ultra")
    expect(m.providerId).toBe("opencode")
    expect(m.surfaceId).toBe("openai-chat-completions")
    expect(m.displayName).toBe("deepseek-v4-ultra")
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

  it("round-trips a Messages stream through the REUSED Anthropic translator", async () => {
    const events: CanonicalEvent[] = []
    for await (const ev of translateAnthropicStream(
      parseSse<AnthropicStreamEvent>(sseStream(anthropicPong())),
    )) {
      events.push(ev)
    }
    let text = ""
    for (const ev of events) if (isEvent(ev, "text_delta")) text += ev.text
    expect(text).toMatch(/I'm Opus/)
  })

  it("validates a plain Chat request via the REUSED OpenAI validator", () => {
    setup()
    const adapter = resolveProvider("opencode")
    const req: CanonicalRequest = { modelId: "deepseek-v4-flash", messages: [userText("hi")] }
    expect(adapter.validate(req, resolveModel("deepseek-v4-flash")).ok).toBe(true)
  })

  it("validates a plain Messages request via the REUSED Anthropic validator", () => {
    setup()
    const adapter = resolveProvider("opencode")
    const req: CanonicalRequest = { modelId: "qwen3.7-max", messages: [userText("hi")] }
    expect(adapter.validate(req, resolveModel("qwen3.7-max")).ok).toBe(true)
  })

  it("acceptDegrade strips images for text-only model (end-to-end via run)", async () => {
    setup()
    const req: CanonicalRequest = {
      modelId: "deepseek-v4-pro",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", source: { kind: "url", url: "https://x/img.png" } },
          ],
        },
      ],
    }

    // A minimal OpenAI Chat pong SSE mock so the adapter doesn't hit the network.
    const pongSse = [
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4-pro",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4-pro",
        choices: [{ index: 0, delta: { content: "pong" }, finish_reason: null }],
      })}`,
      "",
      `data: ${JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion.chunk",
        created: 1,
        model: "deepseek-v4-pro",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}`,
      "",
      "data: [DONE]",
      "",
    ].join("\n")

    const encoder = new TextEncoder()
    const mockNetwork = {
      request: async () =>
        new NetworkResponse({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          transport: { id: "fake", protocol: "h2" },
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(pongSse))
              controller.close()
            },
          }),
        }),
    } as unknown as import("@minimal-agent/plugin-api/net/types").NetworkClient

    // Import run() and RunContext from core
    const { run } = await import("../../src/llm/run.ts")
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "test-key" },
      sessionId: "test",
      networkClient: mockNetwork,
    }

    // Should NOT throw — the degrade strips images before sending.
    let text = ""
    for await (const ev of run(req, { context: ctx, acceptDegrade: true })) {
      if (isEvent(ev, "text_delta")) text += ev.text
    }
    expect(text).toBe("pong")
  })

  it("rejects missing API key on run", async () => {
    setup()
    const adapter = resolveProvider("opencode")
    const model = resolveModel("deepseek-v4-flash")
    const req: CanonicalRequest = { modelId: "deepseek-v4-flash", messages: [userText("hi")] }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "" },
      sessionId: "test",
    }
    await expect(async () => {
      for await (const _ of adapter.run(req, model, ctx)) {
        // should throw before yielding
      }
    }).toThrow("missing api-key")
  })

  it("emits tool_result blocks as role:tool messages (not silently dropped)", () => {
    setup()
    const model = resolveModel("deepseek-v4-flash")
    const req: CanonicalRequest = {
      modelId: "deepseek-v4-flash",
      messages: [
        { role: "user", content: [{ type: "text", text: "which model are you?" }] },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "call_abc123",
              name: "ModelInfo",
              input: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolUseId: "call_abc123",
              content: [
                {
                  type: "text",
                  text: '{"id":"deepseek-v4-flash","displayName":"DeepSeek V4 Flash"}',
                },
              ],
            },
          ],
        },
        { role: "user", content: [{ type: "text", text: "continue" }] },
      ],
    }
    const body = buildOpenAIChatBody(req, model)
    const toolMessages = body.messages.filter((m) => m.role === "tool")
    expect(toolMessages).toHaveLength(1)
    expect(toolMessages[0]!.tool_call_id).toBe("call_abc123")
    expect(toolMessages[0]!.content).toContain("deepseek-v4-flash")
    // Verify the message ordering: user → assistant (with tool_calls) → tool → user
    const roles = body.messages.map((m) => m.role)
    const toolIdx = roles.indexOf("tool")
    expect(toolIdx).toBeGreaterThan(roles.indexOf("assistant"))
  })

  const KEY = process.env.MINIMAL_AGENT_OPENCODE_LIVE_KEY
  it.skipIf(!KEY)(
    "live: deepseek-v4-flash via OpenCode Go (auth + wire reach the API)",
    async () => {
      setup()
      const model = resolveModel("deepseek-v4-flash")
      const provider = resolveProvider("opencode")
      const req: CanonicalRequest = {
        modelId: "deepseek-v4-flash",
        messages: [userText("Reply with the single word: pong")],
        generation: { maxOutputTokens: 512 },
      }
      const ctx: RunContext = {
        auth: { kind: "api-key", key: KEY as string },
        sessionId: "opencode-live-test",
      }
      let text = ""
      try {
        for await (const ev of provider.run(req, model, ctx)) {
          if (isEvent(ev, "text_delta")) text += ev.text
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        expect(msg).toMatch(
          /\b401\b|\b402\b|\b403\b|insufficient credits|user not found|unauthorized/i,
        )
        return
      }
      expect(text.length).toBeGreaterThan(0)
    },
  )
})
