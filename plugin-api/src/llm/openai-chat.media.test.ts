import { describe, expect, it } from "bun:test"

import type { CanonicalBlock } from "./canonical-messages.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import { buildOpenAIChatBody, chatAudioFormat, type OpenAIChatEncodeOptions } from "./openai-chat.ts"
import type { ModelView } from "../types/host-capabilities.ts"

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

function partsFor(block: CanonicalBlock, opts?: OpenAIChatEncodeOptions): unknown {
  const req = {
    modelId: "compat-model",
    messages: [{ role: "user", content: [{ type: "text", text: "see" }, block] }],
  } as CanonicalRequest
  const body = buildOpenAIChatBody(req, MODEL, undefined, opts)
  return (body.messages[0]?.content as unknown[])[1]
}

describe("buildOpenAIChatBody media parts", () => {
  it("sends a base64 PDF as a file part with a data URL and a filename", () => {
    const part = partsFor({
      type: "file",
      source: { kind: "base64", mediaType: "application/pdf", data: "JVBE", filename: "a.pdf" },
    })
    expect(part).toEqual({
      type: "file",
      file: { file_data: "data:application/pdf;base64,JVBE", filename: "a.pdf" },
    })
  })

  it("keeps a file_id file source", () => {
    expect(partsFor({ type: "file", source: { kind: "file_id", fileId: "file-1" } })).toEqual({
      type: "file",
      file: { file_id: "file-1" },
    })
  })

  it("replaces a non-PDF document with a placeholder", () => {
    const part = partsFor({
      type: "file",
      source: { kind: "base64", mediaType: "text/csv", data: "YSxi" },
    })
    expect(part).toEqual({
      type: "text",
      text: "[file attachment not sent: compat-model does not accept text/csv]",
    })
  })

  it("sends a url PDF only when fileUrl is on", () => {
    const block: CanonicalBlock = {
      type: "file",
      source: { kind: "url", url: "https://x/a.pdf", mediaType: "application/pdf" },
    }
    expect((partsFor(block) as { type: string }).type).toBe("text")
    expect(partsFor(block, { fileUrl: true })).toEqual({
      type: "file",
      file: { file_data: "https://x/a.pdf", filename: "document.pdf" },
    })
  })

  it("maps the audio MIME type to the input_audio format", () => {
    const part = partsFor({
      type: "audio",
      source: { kind: "base64", format: "mpeg", mediaType: "audio/mpeg", data: "SUQz" },
    })
    expect(part).toEqual({ type: "input_audio", input_audio: { data: "SUQz", format: "mp3" } })
    expect(chatAudioFormat({ format: "x", mediaType: "audio/x-wav" })).toBe("wav")
    expect(chatAudioFormat({ format: "wav" })).toBe("wav")
  })

  it("replaces a url audio source with a placeholder", () => {
    const part = partsFor({ type: "audio", source: { kind: "url", url: "https://x/a.mp3" } })
    expect((part as { type: string }).type).toBe("text")
  })

  it("sends video as video_url only when the gateway enables it", () => {
    const block: CanonicalBlock = {
      type: "video",
      source: { kind: "base64", mediaType: "video/mp4", data: "AAAA" },
    }
    expect(partsFor(block)).toEqual({
      type: "text",
      text: "[video attachment not sent: compat-model does not accept video/mp4]",
    })
    expect(partsFor(block, { video: true })).toEqual({
      type: "video_url",
      video_url: { url: "data:video/mp4;base64,AAAA" },
    })
  })

  it("replaces an image file_id with a placeholder", () => {
    const part = partsFor({ type: "image", source: { kind: "file_id", fileId: "file-2" } })
    expect(part).toEqual({
      type: "text",
      text: "[image attachment not sent: compat-model does not accept file_id reference]",
    })
  })
})
