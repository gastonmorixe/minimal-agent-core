import { describe, expect, it } from "bun:test"

import { clipboardImageToken } from "./clipboard-token.ts"
import { createMediaRegistry } from "./registry.ts"
import { parseMediaTokens } from "./token.ts"

function png(w: number, h: number, extra = 0): Uint8Array {
  const b = new Uint8Array(24 + extra)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = w
  b[23] = h
  return b
}

function spyDiagnostics() {
  const warns: Array<{ source: string; data: unknown }> = []
  const diagnostics = {
    warn: (source: string, _msg: string, data?: unknown) => warns.push({ source, data }),
  } as never
  return { diagnostics, warns }
}

describe("clipboardImageToken", () => {
  it("registers the clipboard image and returns one [Image #id …] token", async () => {
    const reg = createMediaRegistry()
    const { diagnostics, warns } = spyDiagnostics()
    const token = await clipboardImageToken(reg, diagnostics, undefined, undefined, async () => ({
      bytes: png(4, 2),
    }))
    expect(token).not.toBeNull()
    const refs = parseMediaTokens(token!)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.kind).toBe("image")
    expect(reg.list()).toHaveLength(1)
    expect(reg.list()[0]!.origin).toBe("clipboard")
    expect(warns).toEqual([])
  })

  it("returns null and registers nothing when the clipboard has no image", async () => {
    const reg = createMediaRegistry()
    expect(
      await clipboardImageToken(reg, undefined, undefined, undefined, async () => ({
        bytes: null,
      })),
    ).toBe(null)
    expect(reg.list()).toHaveLength(0)
  })

  it("returns null for an empty byte array", async () => {
    const reg = createMediaRegistry()
    expect(
      await clipboardImageToken(reg, undefined, undefined, undefined, async () => ({
        bytes: new Uint8Array(),
      })),
    ).toBeNull()
    expect(reg.list()).toHaveLength(0)
  })

  it("never rejects: a throwing reader gives null and a clipboard_failed warning", async () => {
    const reg = createMediaRegistry()
    const { diagnostics, warns } = spyDiagnostics()
    const token = await clipboardImageToken(reg, diagnostics, undefined, undefined, async () => {
      throw new Error("pasteboard busy")
    })
    expect(token).toBeNull()
    expect(warns).toEqual([
      { source: "media.clipboard_failed", data: { reason: "pasteboard busy" } },
    ])
  })

  it("warns with the reader's error when the read failed", async () => {
    const reg = createMediaRegistry()
    const { diagnostics, warns } = spyDiagnostics()
    const token = await clipboardImageToken(reg, diagnostics, undefined, undefined, async () => ({
      bytes: null,
      error: "decode failed",
    }))
    expect(token).toBeNull()
    expect(reg.list()).toHaveLength(0)
    expect(warns).toEqual([{ source: "media.clipboard_failed", data: { reason: "decode failed" } }])
  })

  it("stays silent when the clipboard simply has no image", async () => {
    const { diagnostics, warns } = spyDiagnostics()
    await clipboardImageToken(
      createMediaRegistry(),
      diagnostics,
      undefined,
      undefined,
      async () => ({
        bytes: null,
      }),
    )
    expect(warns).toEqual([])
  })

  it("dedupes the same image pasted twice (same content id)", async () => {
    const reg = createMediaRegistry()
    const read = async () => ({ bytes: png(3, 3) })
    const a = await clipboardImageToken(reg, undefined, undefined, undefined, read)
    const b = await clipboardImageToken(reg, undefined, undefined, undefined, read)
    expect(a).toBe(b)
    expect(reg.list()).toHaveLength(1)
  })

  it("warns and returns null for an image over the size floor", async () => {
    const reg = createMediaRegistry()
    const { diagnostics, warns } = spyDiagnostics()
    const token = await clipboardImageToken(reg, diagnostics, undefined, undefined, async () => ({
      bytes: png(2, 2, 6 * 1024 * 1024),
    }))
    expect(token).toBeNull()
    expect(warns.map((w) => w.source)).toEqual(["media.rejected"])
  })
})
