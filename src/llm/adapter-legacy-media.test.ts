import { describe, expect, it } from "bun:test"

import { canonicalMessageToLegacy } from "./adapter-legacy.ts"
import type { CanonicalMessage } from "./canonical-messages.ts"

describe("canonical media block -> legacy wire", () => {
  it("encodes a base64 image to the captured wire shape", () => {
    const msg: CanonicalMessage = {
      role: "user",
      content: [
        { type: "image", source: { kind: "base64", mediaType: "image/jpeg", data: "QUJD" } },
        { type: "text", text: "what is this?" },
      ],
    }
    const legacy = canonicalMessageToLegacy(msg)
    expect(legacy.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
      { type: "text", text: "what is this?" },
    ])
  })

  it("maps file_id -> source.type 'file' (not 'file_id')", () => {
    const msg: CanonicalMessage = {
      role: "user",
      content: [{ type: "image", source: { kind: "file_id", fileId: "file_01ABC" } }],
    }
    const [block] = canonicalMessageToLegacy(msg).content as Array<{
      type: string
      source: unknown
    }>
    expect(block).toEqual({ type: "image", source: { type: "file", file_id: "file_01ABC" } })
  })

  it("encodes a url image", () => {
    const msg: CanonicalMessage = {
      role: "user",
      content: [{ type: "image", source: { kind: "url", url: "https://x/cat.jpg" } }],
    }
    expect(canonicalMessageToLegacy(msg).content).toEqual([
      { type: "image", source: { type: "url", url: "https://x/cat.jpg" } },
    ])
  })

  it("encodes a FileBlock to a document block", () => {
    const msg: CanonicalMessage = {
      role: "user",
      content: [
        { type: "file", source: { kind: "base64", mediaType: "application/pdf", data: "JVBE" } },
      ],
    }
    expect(canonicalMessageToLegacy(msg).content).toEqual([
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBE" } },
    ])
  })

  it("passes a cache hint through as cache_control", () => {
    const msg: CanonicalMessage = {
      role: "user",
      content: [
        {
          type: "image",
          source: { kind: "base64", mediaType: "image/png", data: "AAAA" },
          cache: { kind: "ephemeral", ttl: "1h" },
        },
      ],
    }
    const [block] = canonicalMessageToLegacy(msg).content as Array<{ cache_control?: unknown }>
    expect(block?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  })

  it("drops an audio block (Anthropic has no audio input)", () => {
    const msg: CanonicalMessage = {
      role: "user",
      content: [
        { type: "audio", source: { kind: "base64", format: "wav", data: "AAAA" } },
        { type: "text", text: "transcribe" },
      ],
    }
    // audio is filtered; only the text survives.
    expect(canonicalMessageToLegacy(msg).content).toEqual([{ type: "text", text: "transcribe" }])
  })
})
