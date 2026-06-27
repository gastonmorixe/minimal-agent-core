import { describe, expect, it } from "bun:test"

import type { Message as LegacyMessage } from "../client/types.ts"

import { canonicalMessageToLegacy, legacyMessageToCanonical } from "./adapter-legacy.ts"
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

  it("drops an audio block (provider has no audio input)", () => {
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

describe("tool_result image content round-trips (legacy <-> canonical)", () => {
  it("preserves an image block inside a tool_result on legacy -> canonical", () => {
    // This is the bug Phase 4 fixes: a media-aware Read returns an image inside
    // a tool_result; the canonical transport must NOT strip it to text-only.
    const legacy: LegacyMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: [
            { type: "text", text: "[PNG image 12x12 shown below]" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          ],
        },
      ],
    }
    const canonical = legacyMessageToCanonical(legacy)
    const tr = canonical.content[0]
    expect(tr?.type).toBe("tool_result")
    if (tr?.type !== "tool_result") throw new Error("expected tool_result")
    expect(tr.content).toEqual([
      { type: "text", text: "[PNG image 12x12 shown below]" },
      { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AAAA" } },
    ])
  })

  it("encodes a canonical tool_result image back to the legacy wire shape", () => {
    const canonical: CanonicalMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolUseId: "toolu_2",
          content: [
            { type: "text", text: "caption" },
            { type: "image", source: { kind: "base64", mediaType: "image/jpeg", data: "QUJD" } },
          ],
        },
      ],
    }
    const legacy = canonicalMessageToLegacy(canonical)
    const content = legacy.content
    if (typeof content === "string") throw new Error("expected block array")
    const tr = content[0]
    expect(tr?.type).toBe("tool_result")
    if (tr?.type !== "tool_result") throw new Error("expected tool_result")
    expect(tr.content).toEqual([
      { type: "text", text: "caption" },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "QUJD" } },
    ])
  })

  it("a string tool_result still maps to a single text block", () => {
    const legacy: LegacyMessage = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_3", content: "plain output" }],
    }
    const tr = legacyMessageToCanonical(legacy).content[0]
    if (tr?.type !== "tool_result") throw new Error("expected tool_result")
    expect(tr.content).toEqual([{ type: "text", text: "plain output" }])
  })
})
