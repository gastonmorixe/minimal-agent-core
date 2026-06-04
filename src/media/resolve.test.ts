import { describe, expect, it } from "bun:test"

import type { ModalitySupport } from "../llm/capabilities.ts"

import { anthropicMediaLimits } from "./anthropic.ts"
import { createMediaRegistry } from "./registry.ts"
import { resolveMediaTurn } from "./resolve.ts"
import { formatMediaToken } from "./token.ts"

const IMG_ONLY: ModalitySupport = { image: true, audio: false, pdf: false, video: false }
const LIMITS = anthropicMediaLimits({ contextWindow: 1_000_000 })

// 24-byte PNG declaring WxH (matches probe.ts pngDimensions).
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = w
  b[23] = h
  return b
}

describe("resolveMediaTurn", () => {
  it("builds an image-then-text turn from a prompt token", async () => {
    const reg = createMediaRegistry()
    const item = await reg.registerBytes(png(4, 2), "clipboard", "image/png")
    const text = `what is ${formatMediaToken(item)} ?`

    const res = await resolveMediaTurn({
      text,
      registry: reg,
      limits: LIMITS,
      modalities: IMG_ONLY,
    })

    expect(res.attached).toHaveLength(1)
    expect(res.rejected).toHaveLength(0)
    expect(res.content[0]!.type).toBe("image")
    expect(res.content[1]).toEqual({ type: "text", text: "what is ?" })
    // The image source is inline base64 of the original bytes.
    const block = res.content[0] as { source: { kind: string; data: string } }
    expect(block.source.kind).toBe("base64")
    expect(Buffer.from(block.source.data, "base64")).toEqual(Buffer.from(png(4, 2)))
    expect(item.state).toBe("ready")
  })

  it("dedupes repeated tokens to one block", async () => {
    const reg = createMediaRegistry()
    const item = await reg.registerBytes(png(2, 2), "clipboard", "image/png")
    const tok = formatMediaToken(item)
    const res = await resolveMediaTurn({
      text: `${tok} vs ${tok}`,
      registry: reg,
      limits: LIMITS,
      modalities: IMG_ONLY,
    })
    expect(res.content.filter((b) => b.type === "image")).toHaveLength(1)
  })

  it("rejects an unsupported modality and warns (no block)", async () => {
    const reg = createMediaRegistry()
    // Force a fake audio item by registering bytes with an audio mime hint.
    const item = await reg.registerBytes(Uint8Array.from([1, 2, 3]), "clipboard", "audio/wav")
    const res = await resolveMediaTurn({
      text: `listen ${formatMediaToken(item)}`,
      registry: reg,
      limits: { ...LIMITS, acceptedMimeTypes: new Set(["audio/wav"]) },
      modalities: IMG_ONLY,
    })
    expect(res.attached).toHaveLength(0)
    expect(res.rejected[0]?.rejection.code).toBe("unsupported-modality")
    // A rejected attachment leaves an inline marker (not a silent strip) so the
    // turn still references it. The marker carries the rejection reason.
    expect(res.content).toHaveLength(1)
    expect(res.content[0]).toMatchObject({ type: "text" })
    expect((res.content[0] as { text: string }).text).toContain("listen")
    expect((res.content[0] as { text: string }).text).toContain("[audio not sent:")
  })

  it("reports a missing (stale) token id and leaves a reference marker", async () => {
    const reg = createMediaRegistry()
    const res = await resolveMediaTurn({
      text: "ghost [Image #deadbeef 1x1 1B]",
      registry: reg,
      limits: LIMITS,
      modalities: IMG_ONLY,
    })
    expect(res.missing).toEqual(["deadbeef"])
    expect(res.content).toEqual([
      { type: "text", text: "ghost [attachment #deadbeef unavailable]" },
    ])
  })

  it("produces a media-only turn when the prompt is just a token", async () => {
    const reg = createMediaRegistry()
    const item = await reg.registerBytes(png(8, 8), "drop", "image/png")
    const res = await resolveMediaTurn({
      text: formatMediaToken(item),
      registry: reg,
      limits: LIMITS,
      modalities: IMG_ONLY,
    })
    expect(res.content).toHaveLength(1)
    expect(res.content[0]!.type).toBe("image")
  })
})
