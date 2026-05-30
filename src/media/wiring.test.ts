import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import { ingestUserText, materializeInlineImagePaths } from "./ingest.ts"
import { mediaPasteInterceptor } from "./paste-intercept.ts"
import { createMediaRegistry } from "./registry.ts"
import { parseMediaTokens } from "./token.ts"

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = w
  b[23] = h
  return b
}

const dirs: string[] = []
async function tmpFile(name: string, bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "media-wire-"))
  dirs.push(dir)
  const p = join(dir, name)
  await writeFile(p, bytes)
  return p
}
afterAll(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
})

describe("materializeInlineImagePaths", () => {
  it("replaces a bare on-disk image path with its token", async () => {
    const reg = createMediaRegistry()
    const p = await tmpFile("shot.png", png(4, 2))
    const out = await materializeInlineImagePaths(`look at ${p} please`, reg)
    const refs = parseMediaTokens(out)
    expect(refs).toHaveLength(1)
    expect(refs[0]!.kind).toBe("image")
    expect(reg.get(refs[0]!.id)?.path).toBe(p)
  })

  it("leaves non-existent paths untouched", async () => {
    const reg = createMediaRegistry()
    const text = "see /nope/missing.png here"
    expect(await materializeInlineImagePaths(text, reg)).toBe(text)
  })

  it("does NOT auto-attach document paths inline", async () => {
    const reg = createMediaRegistry()
    const p = await tmpFile("notes.txt", new Uint8Array([1, 2, 3]))
    const text = `read ${p}`
    expect(await materializeInlineImagePaths(text, reg)).toBe(text)
  })
})

describe("ingestUserText", () => {
  it("turns a typed image path into an image block + text", async () => {
    const reg = createMediaRegistry()
    const p = await tmpFile("a.png", png(8, 8))
    const r = await ingestUserText(`describe ${p}`, reg)
    expect(r.hadMedia).toBe(true)
    expect(r.content[0]).toMatchObject({ type: "image", source: { type: "base64" } })
    expect(r.content[1]).toMatchObject({ type: "text" })
  })

  it("passes a plain prompt straight through", async () => {
    const reg = createMediaRegistry()
    const r = await ingestUserText("just a normal message", reg)
    expect(r.content).toEqual([{ type: "text", text: "just a normal message" }])
    expect(r.hadMedia).toBe(false)
  })
})

describe("mediaPasteInterceptor (drag-drop)", () => {
  it("converts a dropped image path to a token", async () => {
    const reg = createMediaRegistry()
    const p = await tmpFile("dropped.png", png(2, 2))
    const out = mediaPasteInterceptor(p, reg)
    expect(out).not.toBeNull()
    expect(parseMediaTokens(out!)).toHaveLength(1)
  })

  it("returns null for ordinary pasted prose", () => {
    const reg = createMediaRegistry()
    expect(mediaPasteInterceptor("just some pasted text", reg)).toBeNull()
  })

  it("returns null for a non-existent dropped path", () => {
    const reg = createMediaRegistry()
    expect(mediaPasteInterceptor("/nope/ghost.png", reg)).toBeNull()
  })
})
