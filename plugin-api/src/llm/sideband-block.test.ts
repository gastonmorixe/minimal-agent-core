import { describe, expect, it } from "bun:test"

import { buildAnthropicRequestBody } from "./anthropic-request.ts"
import { type CanonicalBlock, type CanonicalMessage, wireBlock } from "./canonical-messages.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import { buildOpenAIChatBody } from "./openai-chat.ts"
import type { ModelView } from "../types/host-capabilities.ts"
import type { PersistedToolOutcome } from "../types/tool-outcome-record.ts"

const model = {
  id: "m",
  providerId: "p",
  surfaceId: "s",
  displayName: "M",
  capabilities: {
    maxOutputTokens: 64_000,
    thinking: { adaptive: false, extended: false, visible: false },
    effort: { levels: [], default: undefined },
    acceptsTemperature: true,
    acceptsTopP: true,
    acceptsTopK: true,
    speedFast: false,
  },
  pricing: {},
} as unknown as ModelView

function request(messages: CanonicalMessage[]): CanonicalRequest {
  return { modelId: "m", messages } as CanonicalRequest
}

const tagged: CanonicalMessage[] = [
  { role: "user", content: [{ type: "text", text: "hi", sideband: { kind: "note" } }] },
  { role: "assistant", content: [{ type: "text", text: "yo", sideband: { kind: "note" } }] },
]
const plain: CanonicalMessage[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
  { role: "assistant", content: [{ type: "text", text: "yo" }] },
]

describe("sideband block metadata never reaches a core encoder", () => {
  it("anthropic encoder drops the field", () => {
    const body = JSON.stringify(buildAnthropicRequestBody(request(tagged), model))
    expect(body).not.toContain("sideband")
    expect(body).toBe(JSON.stringify(buildAnthropicRequestBody(request(plain), model)))
  })

  it("openai chat encoder drops the field", () => {
    const body = JSON.stringify(buildOpenAIChatBody(request(tagged), model))
    expect(body).not.toContain("sideband")
    expect(body).toBe(JSON.stringify(buildOpenAIChatBody(request(plain), model)))
  })

  it("a tool_result block with sideband: both encoders drop the field (spec v6.1 D1 item 5)", () => {
    const turn = (sideband?: { kind: string }): CanonicalMessage[] => [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Probe", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "t1",
            content: [{ type: "text", text: "probe ok" }],
            ...(sideband ? { sideband } : {}),
          },
        ],
      },
    ]
    for (const encode of [buildAnthropicRequestBody, buildOpenAIChatBody]) {
      const body = JSON.stringify(encode(request(turn({ kind: "probe-mark" })), model))
      expect(body).toContain("probe ok")
      expect(body).not.toContain("sideband")
      expect(body).not.toContain("probe-mark")
      expect(body).toBe(JSON.stringify(encode(request(turn()), model)))
    }
  })

  it("a tool_result block with outcome and sideband: both encoders drop the fields (spec v6.1 D8, T6)", () => {
    const outcome: PersistedToolOutcome = {
      v: 1,
      bodyEnd: 4,
      annotations: [{ kind: "probe-kind", start: 6, end: 15 }],
      data: { secret: "probe-data" },
    }
    const turn = (meta?: {
      outcome?: PersistedToolOutcome
      sideband?: { kind: string }
    }): CanonicalMessage[] => [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Probe", input: {} }] },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "t1",
            content: [{ type: "text", text: "body\n\nprobe-tag" }],
            ...meta,
          },
        ],
      },
    ]
    for (const encode of [buildAnthropicRequestBody, buildOpenAIChatBody]) {
      const plainBody = JSON.stringify(encode(request(turn()), model))
      for (const meta of [{ outcome }, { outcome, sideband: { kind: "probe-mark" } }]) {
        const body = JSON.stringify(encode(request(turn(meta)), model))
        expect(body).toContain("probe-tag")
        for (const leak of ["outcome", "bodyEnd", "probe-kind", "probe-data", "sideband"]) {
          expect(body).not.toContain(leak)
        }
        expect(body).toBe(plainBody)
      }
    }
  })
})

describe("JSON-encoded blocks drop the metadata keys (spec v6.1 D9, S1/S2)", () => {
  const outcome: PersistedToolOutcome = {
    v: 1,
    bodyEnd: 2,
    annotations: [{ kind: "probe-kind", start: 3, end: 4 }],
    data: { secret: "probe-data" },
  }
  const toolResult = (meta: Record<string, unknown> = {}): CanonicalBlock =>
    ({
      type: "tool_result",
      toolUseId: "t1",
      content: [{ type: "text", text: "ok\nz" }],
      isError: false,
      ...meta,
    }) as CanonicalBlock
  const image = (meta: Record<string, unknown> = {}): CanonicalBlock =>
    ({
      type: "image",
      source: { kind: "url", url: "https://example.test/a.png" },
      ...meta,
    }) as CanonicalBlock

  describe("anthropic: mid-conversation system message", () => {
    const systemTurn = (block: CanonicalBlock): CanonicalMessage[] => [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "system", content: [{ type: "text", text: "note" }, block] },
    ]
    const encode = (block: CanonicalBlock) =>
      JSON.stringify(buildAnthropicRequestBody(request(systemTurn(block)), model))

    it("a tool_result with sideband gives the bytes of the block without it", () => {
      const body = encode(toolResult({ sideband: { kind: "probe-mark" } }))
      expect(body).not.toContain("sideband")
      expect(body).toBe(encode(toolResult()))
    })

    it("a tool_result with outcome gives the bytes of the block without it", () => {
      const body = encode(toolResult({ outcome }))
      for (const leak of ["outcome", "probe-kind", "probe-data"]) expect(body).not.toContain(leak)
      expect(body).toBe(encode(toolResult()))
    })

    it("a block with no metadata gives the same bytes as JSON.stringify (no change)", () => {
      const block = toolResult()
      expect(encode(block)).toContain(JSON.stringify(JSON.stringify(block)).slice(1, -1))
    })
  })

  describe("openai chat: role tool message", () => {
    const toolTurn = (block: CanonicalBlock): CanonicalMessage[] => [
      { role: "user", content: [{ type: "text", text: "go" }] },
      { role: "tool", toolCallId: "t1", content: [{ type: "text", text: "note" }, block] },
    ]
    const encode = (block: CanonicalBlock) =>
      JSON.stringify(buildOpenAIChatBody(request(toolTurn(block)), model))

    it("a block with sideband gives the bytes of the block without it", () => {
      const body = encode(image({ sideband: { kind: "probe-mark" } }))
      expect(body).not.toContain("sideband")
      expect(body).toBe(encode(image()))
    })

    it("a block with outcome gives the bytes of the block without it", () => {
      const body = encode(image({ outcome }))
      for (const leak of ["outcome", "probe-kind", "probe-data"]) expect(body).not.toContain(leak)
      expect(body).toBe(encode(image()))
    })

    it("a block with no metadata gives the same bytes as JSON.stringify (no change)", () => {
      const block = image()
      expect(encode(block)).toContain(JSON.stringify(JSON.stringify(block)).slice(1, -1))
    })
  })

  describe("wireBlock", () => {
    it("keeps the key order and the bytes of a block with no metadata", () => {
      for (const block of [toolResult(), image(), { type: "text", text: "t" } as CanonicalBlock]) {
        expect(JSON.stringify(wireBlock(block))).toBe(JSON.stringify(block))
      }
    })

    it("tool_result: only the allow-listed keys, also in nested content", () => {
      const block = toolResult({
        outcome,
        sideband: { kind: "k" },
        extra: "x",
        cache: { type: "ephemeral" },
        content: [{ type: "text", text: "ok\nz", sideband: { kind: "inner" } }],
      })
      expect(JSON.stringify(wireBlock(block))).toBe(
        JSON.stringify({
          type: "tool_result",
          toolUseId: "t1",
          content: [{ type: "text", text: "ok\nz" }],
          isError: false,
          cache: { type: "ephemeral" },
        }),
      )
    })

    it("other blocks: each key except sideband and outcome", () => {
      const block = { type: "text", text: "t", sideband: { kind: "k" }, cache: { type: "ephemeral" } }
      expect(JSON.stringify(wireBlock(block as unknown as CanonicalBlock))).toBe(
        JSON.stringify({ type: "text", text: "t", cache: { type: "ephemeral" } }),
      )
    })

    it("an own __proto__ key stays a data key and sets no prototype", () => {
      const block = JSON.parse(
        '{"type":"image","source":{"kind":"url","url":"u"},"__proto__":{"polluted":true}}',
      ) as CanonicalBlock
      const copy = wireBlock(block)
      expect(Object.getPrototypeOf(copy)).toBe(Object.prototype)
      expect(JSON.stringify(copy)).toBe(JSON.stringify(block))
      expect((copy as unknown as { polluted?: unknown }).polluted).toBeUndefined()
    })
  })
})
