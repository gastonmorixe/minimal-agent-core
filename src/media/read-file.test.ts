import { describe, expect, it } from "bun:test"

import type { ModalitySupport } from "../llm/capabilities.ts"

import { anthropicMediaLimits } from "./anthropic.ts"
import { decideReadFile, type ImageFitter } from "./read-file.ts"
import type { MediaLimits } from "./limits.ts"
import type { FitResult } from "./transform.ts"

const IMG: ModalitySupport = { image: true, audio: false, pdf: true, video: false }
const NO_IMG: ModalitySupport = { image: false, audio: false, pdf: false, video: false }

/** A minimal but well-formed PNG header with width/height in the IHDR. */
function png(w: number, h: number, pad = 0): Uint8Array {
  const b = new Uint8Array(24 + pad)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = w
  b[23] = h
  return b
}

function pdf(): Uint8Array {
  return new TextEncoder().encode("%PDF-1.7\n%âãÏÓ\n")
}

const limits = (over?: Partial<MediaLimits>): MediaLimits => ({
  ...anthropicMediaLimits({ contextWindow: 200_000 }),
  ...over,
})

describe("decideReadFile", () => {
  it("defers unknown/text bytes to the caller's text read", async () => {
    const d = await decideReadFile(new TextEncoder().encode("just some source code\n"), {
      modalities: IMG,
      limits: limits(),
    })
    expect(d.kind).toBe("text")
  })

  it("treats a .png whose bytes are actually text as text (content-addressed)", async () => {
    // The on-disk file would be named *.png but holds plain text. Magic-byte
    // sniff must keep it on the text path (regression: tools.test.ts heals a
    // U+202F .png containing "pixels\n" and expects the text back).
    const d = await decideReadFile(new TextEncoder().encode("pixels\n"), {
      modalities: IMG,
      limits: limits(),
    })
    expect(d.kind).toBe("text")
  })

  it("embeds a small in-budget PNG as an image block", async () => {
    const d = await decideReadFile(png(8, 8), { modalities: IMG, limits: limits() })
    expect(d.kind).toBe("image")
    if (d.kind !== "image") throw new Error("expected image")
    expect(d.block.type).toBe("image")
    expect(d.block.source).toMatchObject({ kind: "base64", mediaType: "image/png" })
    expect(d.fitted).toBeNull()
    expect(d.dimensions).toEqual({ width: 8, height: 8 })
    expect(d.summary).toContain("shown to the model")
  })

  it("rejects an image when the model lacks the image modality", async () => {
    const d = await decideReadFile(png(8, 8), { modalities: NO_IMG, limits: limits() })
    expect(d.kind).toBe("rejected")
    if (d.kind !== "rejected") throw new Error("expected rejected")
    expect(d.code).toBe("unsupported-modality")
    expect(d.message).toContain("doesn't accept image")
  })

  it("shrinks an oversize image under the per-item cap (via injected fitter)", async () => {
    const fitted = png(2, 2)
    const stub: ImageFitter = async () =>
      ({
        bytes: fitted,
        mimeType: "image/jpeg",
        width: 2,
        height: 2,
        strategy: "8×8→2×2 jpeg q75",
      }) satisfies FitResult
    // Tiny per-item cap so the original is rejected as too-large and the
    // fitter is invoked.
    const d = await decideReadFile(png(8, 8, 4000), {
      modalities: IMG,
      limits: limits({ maxBytesPerItem: 16 }),
      fit: stub,
    })
    expect(d.kind).toBe("image")
    if (d.kind !== "image") throw new Error("expected image")
    expect(d.fitted).toBe("8×8→2×2 jpeg q75")
    expect(d.mimeType).toBe("image/jpeg")
    expect(d.summary).toContain("resized to fit")
  })

  it("rejects an oversize image the fitter can't shrink", async () => {
    const stub: ImageFitter = async () => null
    const d = await decideReadFile(png(8, 8, 4000), {
      modalities: IMG,
      limits: limits({ maxBytesPerItem: 16 }),
      fit: stub,
    })
    expect(d.kind).toBe("rejected")
    if (d.kind !== "rejected") throw new Error("expected rejected")
    expect(d.code).toBe("too-large")
    expect(d.message).toContain("too large to embed")
  })

  it("rejects a PDF with an actionable message (documents aren't tool-output-embeddable)", async () => {
    const d = await decideReadFile(pdf(), { modalities: IMG, limits: limits() })
    expect(d.kind).toBe("rejected")
    if (d.kind !== "rejected") throw new Error("expected rejected")
    expect(d.code).toBe("unsupported-type")
    expect(d.message).toContain("binary document")
  })

  it("does not attempt the real fitter when an in-budget image is given", async () => {
    let called = false
    const stub: ImageFitter = async () => {
      called = true
      return null
    }
    await decideReadFile(png(4, 4), { modalities: IMG, limits: limits(), fit: stub })
    expect(called).toBe(false)
  })
})
