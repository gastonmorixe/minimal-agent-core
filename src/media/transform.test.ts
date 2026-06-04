import { describe, expect, it } from "bun:test"

import { base64EncodedSize } from "./limits.ts"
import { canTransformImages, fitImageToBudget, VISION_LONG_EDGE_PX } from "./transform.ts"

/**
 * These tests exercise the real `Bun.Image` backend when present (it ships in
 * Bun 1.3.14+, which is what this repo runs on). On a runtime without it the
 * engine is a no-op that returns `null`, so the suite asserts that contract
 * instead of failing.
 */

/** A valid 1×1 PNG seed (base64) that Bun.Image decodes cleanly. */
const ONE_PX_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

/** A real, decodable PNG of `w×h` pixels, built by upscaling the seed via Bun.Image. */
async function solidPng(w: number, h: number): Promise<Uint8Array> {
  const Image = (globalThis as { Bun?: { Image?: new (b: Uint8Array) => any } }).Bun?.Image
  if (!Image) throw new Error("no Bun.Image")
  const seed = Uint8Array.from(Buffer.from(ONE_PX_PNG_B64, "base64"))
  return await new Image(seed).resize(w, h, { fit: "fill" }).png().bytes()
}

describe("transform — fitImageToBudget", () => {
  const HAVE_BACKEND = canTransformImages()

  it("reports backend availability as a boolean", () => {
    expect(typeof HAVE_BACKEND).toBe("boolean")
  })

  it("returns null for non-image / undecodable bytes", async () => {
    const r = await fitImageToBudget(Uint8Array.from([1, 2, 3, 4]), {
      maxEncodedBytes: 5 * 1024 * 1024,
    })
    expect(r).toBeNull()
  })

  if (HAVE_BACKEND) {
    it("shrinks a large image so its base64 size fits the budget", async () => {
      // A 3000×2000 PNG is multi-MB; cap the ENCODED size at 1 MB.
      const big = await solidPng(3000, 2000)
      const budget = 1 * 1024 * 1024
      const r = await fitImageToBudget(big, { maxEncodedBytes: budget })
      expect(r).not.toBeNull()
      expect(base64EncodedSize(r!.bytes.length)).toBeLessThanOrEqual(budget)
      expect(r!.mimeType).toBe("image/jpeg")
      // Long edge never exceeds the vision ceiling.
      expect(Math.max(r!.width, r!.height)).toBeLessThanOrEqual(VISION_LONG_EDGE_PX)
      expect(r!.strategy).toContain("jpeg q")
    })

    it("caps the long edge at the vision ceiling even when bytes already fit", async () => {
      const big = await solidPng(4000, 1000)
      const r = await fitImageToBudget(big, { maxEncodedBytes: 32 * 1024 * 1024 })
      expect(r).not.toBeNull()
      expect(Math.max(r!.width, r!.height)).toBeLessThanOrEqual(VISION_LONG_EDGE_PX)
    })

    it("honors a custom maxLongEdge", async () => {
      const big = await solidPng(2000, 2000)
      const r = await fitImageToBudget(big, { maxEncodedBytes: 32 * 1024 * 1024, maxLongEdge: 512 })
      expect(r).not.toBeNull()
      expect(Math.max(r!.width, r!.height)).toBeLessThanOrEqual(512)
    })
  }
})
