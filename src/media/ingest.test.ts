import { describe, expect, it } from "bun:test"

import { buildUserContent } from "./ingest.ts"
import { createMediaRegistry } from "./registry.ts"
import { formatMediaToken } from "./token.ts"

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = w
  b[23] = h
  return b
}

describe("buildUserContent", () => {
  it("passes plain text straight through (no media)", async () => {
    const reg = createMediaRegistry()
    const r = await buildUserContent("hello there", reg)
    expect(r.content).toEqual([{ type: "text", text: "hello there" }])
    expect(r.hadMedia).toBe(false)
  })

  it("attaches a referenced image as a legacy image block, image-then-text", async () => {
    const reg = createMediaRegistry()
    const item = await reg.registerBytes(png(4, 2), "drop", "image/png")
    const r = await buildUserContent(`${formatMediaToken(item)} describe`, reg)
    expect(r.hadMedia).toBe(true)
    expect(r.content[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    })
    expect(r.content[1]).toEqual({ type: "text", text: "describe" })
  })

  it("rejects audio when the modality is unsupported and reports it", async () => {
    const reg = createMediaRegistry()
    const item = await reg.registerBytes(Uint8Array.from([1, 2, 3]), "clipboard", "audio/wav")
    const r = await buildUserContent(`hear ${formatMediaToken(item)}`, reg, {
      limits: {
        acceptedMimeTypes: new Set(["audio/wav"]),
        maxBytesPerItem: 1024,
        maxRequestBytes: 1024,
        maxItemsPerRequest: 10,
        maxDimension: null,
      },
    })
    expect(r.hadMedia).toBe(false)
    expect(r.rejected[0]?.rejection.code).toBe("unsupported-modality")
    // The rejected attachment leaves an inline marker so the turn keeps a
    // reference to it rather than silently dropping the subject.
    expect(r.content).toHaveLength(1)
    expect((r.content[0] as { text: string }).text).toContain("hear")
    expect((r.content[0] as { text: string }).text).toContain("[audio not sent:")
  })
})
