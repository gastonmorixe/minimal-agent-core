import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { createMediaRegistry } from "./registry.ts"

// A 24-byte PNG header declaring 4x2 pixels (see probe.ts pngDimensions).
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = width
  b[23] = height
  return b
}

const dirs: string[] = []
async function tmpFile(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "media-test-"))
  dirs.push(dir)
  const p = join(dir, name)
  await writeFile(p, bytes)
  return p
}

afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

describe("MediaRegistry.registerPath", () => {
  it("probes mime, kind, dimensions, and content id", async () => {
    const reg = createMediaRegistry()
    const p = await tmpFile("shot.bin", png(4, 2)) // wrong extension on purpose
    const item = await reg.registerPath(p)
    expect(item.mimeType).toBe("image/png") // sniffed, not from ".bin"
    expect(item.kind).toBe("image")
    expect(item.dimensions).toEqual({ width: 4, height: 2 })
    expect(item.id).toMatch(/^[0-9a-f]{8}$/)
    expect(item.path).toBe(p)
    expect(item.sizeBytes).toBe(24)
    expect(reg.get(item.id)).toBe(item)
  })

  it("lazily reads the same bytes back", async () => {
    const reg = createMediaRegistry()
    const p = await tmpFile("a.png", png(8, 8))
    const item = await reg.registerPath(p)
    const bytes = await item.bytes()
    expect(bytes.length).toBe(24)
    expect(bytes[19]).toBe(8)
  })

  it("dedupes identical content to one entry", async () => {
    const reg = createMediaRegistry()
    const p1 = await tmpFile("one.png", png(2, 2))
    const p2 = await tmpFile("two.png", png(2, 2)) // same bytes, different path
    const a = await reg.registerPath(p1)
    const b = await reg.registerPath(p2)
    expect(b.id).toBe(a.id)
    expect(reg.list()).toHaveLength(1)
  })
})

describe("MediaRegistry.registerBytes", () => {
  it("registers a clipboard buffer and honors a mime hint", async () => {
    const reg = createMediaRegistry()
    const item = await reg.registerBytes(Uint8Array.from([1, 2, 3, 4]), "clipboard", "image/png")
    expect(item.origin).toBe("clipboard")
    expect(item.mimeType).toBe("image/png") // sniff is octet-stream -> hint wins
    expect(item.path).toBeNull()
    expect(await item.bytes()).toEqual(Uint8Array.from([1, 2, 3, 4]))
  })
})

describe("MediaRegistry lifecycle", () => {
  it("release and clear drop entries", async () => {
    const reg = createMediaRegistry()
    const a = await reg.registerBytes(png(1, 1), "tool")
    reg.release(a.id)
    expect(reg.get(a.id)).toBeUndefined()
    await reg.registerBytes(png(3, 3), "tool")
    reg.clear()
    expect(reg.list()).toHaveLength(0)
  })
})
