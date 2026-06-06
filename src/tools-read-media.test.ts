import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import type { ModalitySupport } from "./llm/capabilities.ts"
import { anthropicMediaLimits } from "./media/anthropic.ts"
import type { ToolMediaContext } from "./tools.ts"
import { executeTool } from "./tools.ts"

const dir = mkdtempSync(join(tmpdir(), "read-media-"))
afterAll(() => {
  try {
    require("node:fs").rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
})

const IMG: ModalitySupport = { image: true, audio: false, pdf: true, video: false }
const NO_IMG: ModalitySupport = { image: false, audio: false, pdf: false, video: false }

function mediaCtx(modalities: ModalitySupport): ToolMediaContext {
  return {
    modalities,
    limits: anthropicMediaLimits({ contextWindow: 200_000 }),
    modelId: "test-model",
  }
}

/** Real PNG header with width/height in IHDR + padding to a given byte size. */
function png(w: number, h: number, pad = 0): Uint8Array {
  const b = new Uint8Array(24 + pad)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = w
  b[23] = h
  return b
}

function writeFile(name: string, bytes: Uint8Array): string {
  const p = join(dir, name)
  writeFileSync(p, bytes)
  return p
}

describe("Read — media-aware (image embedding)", () => {
  it("returns an image block + caption when the model accepts images", async () => {
    const p = writeFile("shot.png", png(16, 16))
    const r = await executeTool("Read", { file_path: p }, { media: mediaCtx(IMG) })
    expect(r.is_error).toBeFalsy()
    expect(r.blocks).toHaveLength(1)
    expect(r.blocks![0]).toMatchObject({
      type: "image",
      source: { kind: "base64", mediaType: "image/png" },
    })
    expect(r.content).toContain("shown to the model")
    // No cat -n line numbering for the image path.
    expect(r.content).not.toMatch(/^1\t/)
  })

  it("returns an informational message (no block, not is_error) when the model lacks vision", async () => {
    const p = writeFile("noimg.png", png(16, 16))
    const r = await executeTool("Read", { file_path: p }, { media: mediaCtx(NO_IMG) })
    expect(r.blocks).toBeUndefined()
    expect(r.is_error).toBeFalsy()
    expect(r.content).toContain("doesn't accept image")
  })

  it("reads a text file as text even with a media context present", async () => {
    const p = writeFile("code.ts", new TextEncoder().encode("const x = 1\nconst y = 2\n"))
    const r = await executeTool("Read", { file_path: p }, { media: mediaCtx(IMG) })
    expect(r.blocks).toBeUndefined()
    expect(r.content).toContain("1\tconst x = 1")
  })

  it("treats a .png whose bytes are text as text (content-addressed, no mojibake path)", async () => {
    const p = writeFile("fake.png", new TextEncoder().encode("pixels\n"))
    const r = await executeTool("Read", { file_path: p }, { media: mediaCtx(IMG) })
    expect(r.blocks).toBeUndefined()
    expect(r.content).toContain("pixels")
  })

  it("rejects a PDF with an actionable message", async () => {
    const p = writeFile("doc.pdf", new TextEncoder().encode("%PDF-1.7\n%binary\n"))
    const r = await executeTool("Read", { file_path: p }, { media: mediaCtx(IMG) })
    expect(r.blocks).toBeUndefined()
    expect(r.content).toContain("binary document")
  })

  it("without a media context, an image file falls back to the legacy text read", async () => {
    // No `media` opt: the host is text-only. The image is decoded as UTF-8
    // (legacy behavior) — proves the media branch is strictly opt-in.
    const p = writeFile("legacy.png", png(16, 16))
    const r = await executeTool("Read", { file_path: p })
    expect(r.blocks).toBeUndefined()
    expect(r.content).toMatch(/^1\t/)
  })
})
