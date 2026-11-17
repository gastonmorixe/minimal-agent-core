/**
 * Media encoding of the Anthropic request builder: image `file_id` sources and
 * canonical `file` blocks mapped to `document` blocks.
 *
 * @module llm/anthropic-request.media.test
 */

import { describe, expect, it } from "bun:test"

import { buildAnthropicRequestBody } from "./anthropic-request.ts"
import type { CanonicalBlock } from "./canonical-messages.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import type { ModelView } from "../types/host-capabilities.ts"

const model = {
  id: "claude-test",
  capabilities: {
    maxOutputTokens: 64_000,
    thinking: { adaptive: false, extended: false, visible: false },
    effort: { levels: [], default: undefined },
    acceptsTemperature: true,
    acceptsTopP: true,
    acceptsTopK: true,
    speedFast: false,
  },
} as unknown as ModelView

/** Encode one user block and return the wire content array. */
function encode(block: CanonicalBlock): unknown {
  const req: CanonicalRequest = {
    modelId: "claude-test",
    messages: [{ role: "user", content: [block] }],
  }
  return buildAnthropicRequestBody(req, model).messages[0]?.content
}

describe("anthropic request media: image sources", () => {
  it("encodes an image file_id as a file source", () => {
    expect(encode({ type: "image", source: { kind: "file_id", fileId: "file_01A" } })).toEqual([
      { type: "image", source: { type: "file", file_id: "file_01A" } },
    ])
  })

  it("keeps base64 and url image sources", () => {
    expect(
      encode({ type: "image", source: { kind: "base64", mediaType: "image/png", data: "QQ==" } }),
    ).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "QQ==" } }])
    expect(encode({ type: "image", source: { kind: "url", url: "https://x/a.png" } })).toEqual([
      { type: "image", source: { type: "url", url: "https://x/a.png" } },
    ])
  })

  it("encodes a file_id image inside a tool_result", () => {
    const out = encode({
      type: "tool_result",
      toolUseId: "t1",
      content: [{ type: "image", source: { kind: "file_id", fileId: "file_01B" } }],
    }) as Array<{ content: unknown }>
    expect(out[0]?.content).toEqual([
      { type: "image", source: { type: "file", file_id: "file_01B" } },
    ])
  })
})

describe("anthropic request media: document blocks", () => {
  it("encodes a base64 PDF as a base64 document", () => {
    expect(
      encode({
        type: "file",
        source: { kind: "base64", mediaType: "application/pdf", data: "JVBERi0=" },
        cache: { kind: "ephemeral" },
      }),
    ).toEqual([
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" },
        cache_control: { type: "ephemeral" },
      },
    ])
  })

  it("decodes base64 text/* to a plain-text source (UTF-8)", () => {
    const data = Buffer.from("héllo 世界", "utf8").toString("base64")
    expect(encode({ type: "file", source: { kind: "base64", mediaType: "text/plain", data } })).toEqual([
      { type: "document", source: { type: "text", media_type: "text/plain", data: "héllo 世界" } },
    ])
  })

  it("encodes url and file_id documents", () => {
    expect(encode({ type: "file", source: { kind: "url", url: "https://x/a.pdf" } })).toEqual([
      { type: "document", source: { type: "url", url: "https://x/a.pdf" } },
    ])
    expect(encode({ type: "file", source: { kind: "file_id", fileId: "file_01C" } })).toEqual([
      { type: "document", source: { type: "file", file_id: "file_01C" } },
    ])
  })

  it("sends a placeholder for an inline document with an unsupported media type", () => {
    expect(
      encode({ type: "file", source: { kind: "base64", mediaType: "application/zip", data: "UEs=" } }),
    ).toEqual([
      {
        type: "text",
        text: "[file attachment not sent: claude-test does not accept application/zip]",
      },
    ])
  })

  it("sends a placeholder for a file_id whose id is not an Anthropic file_ id", () => {
    expect(encode({ type: "image", source: { kind: "file_id", fileId: "file-abc123" } })).toEqual([
      {
        type: "text",
        text: "[image attachment not sent: claude-test does not accept file_id reference]",
      },
    ])
    expect(encode({ type: "file", source: { kind: "file_id", fileId: "assistant-x9" } })).toEqual([
      {
        type: "text",
        text: "[file attachment not sent: claude-test does not accept file_id reference]",
      },
    ])
  })

  it("sends a placeholder for a text/plain document with bad base64 instead of throwing", () => {
    const out = encode({
      type: "file",
      source: { kind: "base64", mediaType: "text/plain", data: "!!not*base64" },
    }) as Array<{ type: string }>
    expect(out).toHaveLength(1)
    expect(out[0]?.type).toBe("text")
  })

  it("sends placeholders for audio and video blocks and keeps the cache hint", () => {
    expect(
      encode({
        type: "audio",
        source: { kind: "base64", format: "mp3", mediaType: "audio/mpeg", data: "AA==" },
        cache: { kind: "ephemeral" },
      }),
    ).toEqual([
      {
        type: "text",
        text: "[audio attachment not sent: claude-test does not accept audio/mpeg]",
        cache_control: { type: "ephemeral" },
      },
    ])
    expect(
      encode({ type: "video", source: { kind: "base64", mediaType: "video/mp4", data: "AA==" } }),
    ).toEqual([
      { type: "text", text: "[video attachment not sent: claude-test does not accept video/mp4]" },
    ])
  })

  it("sends text-like documents (csv, json, md, code) as text/plain", () => {
    const b64 = Buffer.from('{"a":1}').toString("base64")
    for (const mediaType of ["application/json", "text/csv", "text/markdown", "application/xml"]) {
      expect(encode({ type: "file", source: { kind: "base64", mediaType, data: b64 } })).toEqual([
        { type: "document", source: { type: "text", media_type: "text/plain", data: '{"a":1}' } },
      ])
    }
  })
})
