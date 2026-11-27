import { describe, expect, it } from "bun:test"

import type { CanonicalMessage, ImageBlock, TextBlock } from "./canonical-messages.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import { buildOpenAIChatBody } from "./openai-chat.ts"
import { hoistToolResultMedia, TOOL_RESULT_MEDIA_TEXT } from "./tool-result-media.ts"
import type { ModelView } from "../types/host-capabilities.ts"

/** Fixed 24 byte PNG header (16x16), the same bytes as the plugin request goldens. */
function pngBase64(): string {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = 16
  b[23] = 16
  return Buffer.from(b).toString("base64")
}

const PNG = pngBase64()

function image(data = PNG): ImageBlock {
  return { type: "image", source: { kind: "base64", mediaType: "image/png", data } }
}

function text(t: string): TextBlock {
  return { type: "text", text: t }
}

const { marker, label } = TOOL_RESULT_MEDIA_TEXT

describe("hoistToolResultMedia", () => {
  it("returns the same array when no tool result has media", () => {
    const messages: CanonicalMessage[] = [
      { role: "user", content: [text("hi"), image()] },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: [text("ok")] }] },
    ]
    expect(hoistToolResultMedia(messages)).toBe(messages)
  })

  it("moves one image after the tool result, with a marker and a label", () => {
    const img = image()
    const input: CanonicalMessage[] = [
      {
        role: "user",
        content: [{ type: "tool_result", toolUseId: "t1", content: [text("shot"), img] }],
      },
    ]
    const before = JSON.stringify(input)
    const out = hoistToolResultMedia(input)
    expect(out).not.toBe(input)
    expect(JSON.stringify(input)).toBe(before)
    expect(out).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1", content: [text("shot"), text(marker(1))] },
          text(label("t1")),
          img,
        ],
      },
    ])
  })

  it("numbers images across two tool results and keeps the order", () => {
    const a = image("QQ==")
    const b = image("Qg==")
    const c = image("Qw==")
    const out = hoistToolResultMedia([
      {
        role: "user",
        content: [
          { type: "tool_result", toolUseId: "t1", content: [a, text("one")] },
          { type: "tool_result", toolUseId: "t2", content: [text("plain")] },
          { type: "tool_result", toolUseId: "t3", content: [b, c] },
        ],
      },
    ])
    expect(out[0]?.content).toEqual([
      { type: "tool_result", toolUseId: "t1", content: [text(marker(1)), text("one")] },
      { type: "tool_result", toolUseId: "t2", content: [text("plain")] },
      { type: "tool_result", toolUseId: "t3", content: [text(marker(2)), text(marker(3))] },
      text(label("t1")),
      a,
      text(label("t3")),
      b,
      c,
    ])
  })

  it("puts the moved media before the other blocks of the message", () => {
    const img = image()
    const out = hoistToolResultMedia([
      {
        role: "user",
        content: [
          text("sibling before"),
          { type: "tool_result", toolUseId: "t1", content: [img] },
          text("sibling after"),
        ],
      },
    ])
    expect(out[0]?.content).toEqual([
      { type: "tool_result", toolUseId: "t1", content: [text(marker(1))] },
      text(label("t1")),
      img,
      text("sibling before"),
      text("sibling after"),
    ])
  })

  it("keeps the id, isError and the other keys of the tool result", () => {
    const out = hoistToolResultMedia([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "t9",
            isError: true,
            cache: { kind: "ephemeral" },
            content: [image()],
          },
        ],
      },
    ])
    const tr = out[0]?.content[0]
    expect(tr).toEqual({
      type: "tool_result",
      toolUseId: "t9",
      isError: true,
      cache: { kind: "ephemeral" },
      content: [text(marker(1))],
    })
  })

  it("keeps the unchanged messages as the same objects", () => {
    const first: CanonicalMessage = { role: "user", content: [text("a")] }
    const last: CanonicalMessage = { role: "assistant", content: [text("b")] }
    const out = hoistToolResultMedia([
      first,
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: [image()] }] },
      last,
    ])
    expect(out).toHaveLength(3)
    expect(out[0]).toBe(first)
    expect(out[2]).toBe(last)
  })

  it("moves the media of a role tool message to a user message after it", () => {
    const img = image()
    const out = hoistToolResultMedia([
      { role: "tool", toolCallId: "c1", content: [text("result"), img] },
    ])
    expect(out).toEqual([
      { role: "tool", toolCallId: "c1", content: [text("result"), text(marker(1))] },
      { role: "user", content: [text(label("c1")), img] },
    ])
  })

  it("writes a marker and a label with no leading bracket", () => {
    expect(marker(1)).toBe("image 1 is attached after the tool results")
    expect(label("t1")).toBe("Images from tool result t1:")
  })
})

const MODEL = {
  id: "compat-model",
  providerId: "compat",
  surfaceId: "chat",
  displayName: "Compat",
  capabilities: {
    maxOutputTokens: 4096,
    acceptsTemperature: true,
    acceptsTopP: true,
    acceptsSeed: true,
    acceptsStopSequences: true,
    effort: { levels: [] },
  },
  pricing: {},
} as unknown as ModelView

describe("buildOpenAIChatBody tool result media", () => {
  it("sends a tool result image as image_url in a user message after all tool messages", () => {
    const req = {
      modelId: "compat-model",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "shot", input: {} },
            { type: "tool_use", id: "t2", name: "read", input: {} },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolUseId: "t1", content: [text("page shot"), image()] },
            { type: "tool_result", toolUseId: "t2", content: [text("file body")] },
          ],
        },
      ],
    } as CanonicalRequest
    const body = buildOpenAIChatBody(req, MODEL)
    expect(body.messages.slice(1)).toEqual([
      { role: "tool", tool_call_id: "t1", content: `page shot\n${marker(1)}` },
      { role: "tool", tool_call_id: "t2", content: "file body" },
      {
        role: "user",
        content: [
          { type: "text", text: label("t1") },
          { type: "image_url", image_url: { url: `data:image/png;base64,${PNG}` } },
        ],
      },
    ])
  })
})
