import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import type { ToolAttachment } from "../../plugin-api/src/types/plugin.ts"
import type { ToolOutcome } from "../../plugin-api/src/types/tool-outcome.ts"
import { EMPTY_SYNTHETIC_TEXT } from "../agent/synthetic-text.ts"
import type { ModalitySupport } from "../llm/capabilities.ts"
import { fixtureSidebandOrNone, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"
import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import { defaultMediaLimits } from "./default-limits.ts"
import type { ReadFileMediaContext } from "./read-file.ts"
import {
  addToolAttachments,
  attachmentExtension,
  MAX_ATTACHMENT_IMAGES,
  processToolAttachments,
  type ToolAttachmentInput,
  withAttachments,
} from "./tool-attachment.ts"

const TEXT = textFixturesPresent() ? fixtureSyntheticTextResolver() : undefined
const SB = fixtureSidebandOrNone()
const withText = it.skipIf(!textFixturesPresent())
const withTags = it.skipIf(!sidebandFixturePresent())

const ROOT = join(import.meta.dirname, "..", "..", "tmp", `tool-attachment-${process.pid}`)
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

let seq = 0
/** A new blob dir for each test (not made yet: the helper makes it). */
const freshDir = (): string => join(ROOT, `case-${++seq}`, "sid.blobs")

const IMG: ModalitySupport = { image: true, audio: false, pdf: true, video: false }
const NO_IMG: ModalitySupport = { image: false, audio: false, pdf: false, video: false }
const media = (modalities: ModalitySupport): ReadFileMediaContext => ({
  modalities,
  limits: defaultMediaLimits(),
  modelId: "test-model",
})

/** A minimal PNG header with width and height in the IHDR. */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = w
  b[23] = h
  return b
}

const pdf = (): Uint8Array => new TextEncoder().encode("%PDF-1.7\n%binary\n")

function input(
  attachments: ToolAttachment[],
  over: Partial<ToolAttachmentInput> = {},
): ToolAttachmentInput {
  return {
    attachments,
    toolName: "ChromeCDP",
    toolUseId: "toolu_1",
    blobDir: freshDir(),
    media: media(IMG),
    ...(TEXT ? { text: TEXT } : {}),
    sb: SB,
    ...over,
  }
}

describe("attachmentExtension", () => {
  it("maps the sniffed types and falls back to bin", () => {
    expect(attachmentExtension("image/png")).toBe("png")
    expect(attachmentExtension("image/jpeg")).toBe("jpg")
    expect(attachmentExtension("application/pdf")).toBe("pdf")
    expect(attachmentExtension("application/octet-stream")).toBe("bin")
  })
})

describe("processToolAttachments", () => {
  withText("an accepted image gives one image block and a caption", async () => {
    const inp = input([{ bytes: png(8, 8), label: "shot" }])
    const r = await processToolAttachments(inp)
    expect(r.media).toHaveLength(1)
    expect(r.media[0]?.source).toMatchObject({ kind: "base64", mediaType: "image/png" })
    expect(r.textLines).toHaveLength(1)
    expect(r.textLines[0]).toContain("shown to the model")
  })

  it("writes the file with the extension of the sniffed type", async () => {
    const bytes = png(8, 8)
    const inp = input([{ bytes }, { bytes: pdf() }, { bytes: new Uint8Array([1, 2, 3]) }])
    await processToolAttachments(inp)
    const dir = inp.blobDir as string
    expect(readdirSync(dir).sort()).toEqual(["toolu_1-1.png", "toolu_1-2.pdf", "toolu_1-3.bin"])
    expect([...readFileSync(join(dir, "toolu_1-1.png"))]).toEqual([...bytes])
  })

  withTags("the caption group names the saved path", async () => {
    const inp = input([{ bytes: png(8, 8) }])
    const r = await processToolAttachments(inp)
    expect(r.textLines[0]).toContain(join(inp.blobDir as string, "toolu_1-1.png"))
    expect(r.textLines[0]).toContain("image/png")
  })

  withText("a model with no image modality gets the rejection text, no block", async () => {
    const inp = input([{ bytes: png(8, 8) }], { media: media(NO_IMG) })
    const r = await processToolAttachments(inp)
    expect(r.media).toEqual([])
    expect(r.textLines[0]).toContain("does not accept image")
    expect(existsSync(join(inp.blobDir as string, "toolu_1-1.png"))).toBe(true)
  })

  it("an unknown model (no media context) gets no block and no gate text", async () => {
    const inp = input([{ bytes: png(8, 8) }], { media: undefined })
    const r = await processToolAttachments(inp)
    expect(r.media).toEqual([])
    expect(r.textLines.join("\n")).not.toContain("shown to the model")
    expect(existsSync(join(inp.blobDir as string, "toolu_1-1.png"))).toBe(true)
    // With the codec, the one line is the path tag. Without it, no line.
    expect(r.textLines).toHaveLength(sidebandFixturePresent() ? 1 : 0)
  })

  withText("a PDF is rejected with the Read document text", async () => {
    const r = await processToolAttachments(input([{ bytes: pdf() }]))
    expect(r.media).toEqual([])
    expect(r.textLines[0]).toContain("binary document")
  })

  withText("unknown bytes get the unsupported embedding text with the mime hint", async () => {
    const r = await processToolAttachments(
      input([{ bytes: new Uint8Array([1, 2, 3]), mimeType: "application/x-thing" }]),
    )
    expect(r.media).toEqual([])
    expect(r.textLines[0]).toContain("tool output cannot contain this file")
  })

  it("caps the image blocks, and each extra image still has a file", async () => {
    const shots = Array.from({ length: MAX_ATTACHMENT_IMAGES + 2 }, () => ({ bytes: png(8, 8) }))
    const inp = input(shots)
    const r = await processToolAttachments(inp)
    expect(r.media).toHaveLength(MAX_ATTACHMENT_IMAGES)
    expect(readdirSync(inp.blobDir as string)).toHaveLength(MAX_ATTACHMENT_IMAGES + 2)
  })

  it("with no blob dir writes no file and the tag has no path", async () => {
    const r = await processToolAttachments(input([{ bytes: png(8, 8) }], { blobDir: null }))
    expect(r.media).toHaveLength(1)
    expect(r.textLines.join("\n")).not.toContain("path=")
  })

  it("a write error is reported and the attachment has no path", async () => {
    const base = join(ROOT, `case-${++seq}`)
    mkdirSync(base, { recursive: true })
    // A file where the dir must be: mkdir fails.
    const blocked = join(base, "blocked")
    await Bun.write(blocked, "x")
    const errors: string[] = []
    const r = await processToolAttachments(
      input([{ bytes: png(8, 8) }], {
        blobDir: join(blocked, "sid.blobs"),
        onWriteError: (_e, p) => errors.push(p),
      }),
    )
    expect(errors).toHaveLength(1)
    expect(r.media).toHaveLength(1)
    expect(r.textLines.join("\n")).not.toContain("path=")
  })

  it("ignores an entry whose bytes is not a Uint8Array", async () => {
    const bad = { bytes: "not bytes" } as unknown as ToolAttachment
    const inp = input([bad, { bytes: png(8, 8) }])
    const r = await processToolAttachments(inp)
    expect(r.media).toHaveLength(1)
    expect(readdirSync(inp.blobDir as string)).toEqual(["toolu_1-1.png"])
  })

  it("keeps the file name inside the blob dir for a strange tool use id", async () => {
    const inp = input([{ bytes: png(8, 8) }], { toolUseId: "../x/y" })
    await processToolAttachments(inp)
    expect(readdirSync(inp.blobDir as string)).toEqual(["___x_y-1.png"])
  })
})

const outcome = (text: string): ToolOutcome => ({
  body: { text },
  annotations: [],
  isError: false,
  aborted: false,
})

describe("withAttachments", () => {
  it("adds the lines after the body and the blocks to media, with no change to the input", async () => {
    const o = outcome("body")
    const r = await processToolAttachments(input([{ bytes: png(8, 8) }], { media: media(IMG) }))
    const n = withAttachments(o, { textLines: ["line a", "line b"], media: r.media })
    expect(n.body.text).toBe("body\n\nline a\n\nline b")
    expect(n.media).toHaveLength(1)
    expect(o.body.text).toBe("body")
    expect(o.media).toBeUndefined()
  })

  it("with an empty body, the text is the lines only", () => {
    expect(withAttachments(outcome(""), { textLines: ["x"], media: [] }).body.text).toBe("x")
  })

  it("with no lines and no media, gives the same outcome", () => {
    const o = outcome("b")
    expect(withAttachments(o, { textLines: [], media: [] })).toBe(o)
  })
})

describe("addToolAttachments", () => {
  const ctx = {
    blobStore: null,
    model: "no-such-model",
    tool: { id: "toolu_9", name: "ChromeCDP" },
    text: TEXT ?? EMPTY_SYNTHETIC_TEXT,
    sb: SB,
  }

  it("gives the same outcome for absent or empty attachments", async () => {
    const o = outcome("b")
    expect(await addToolAttachments(o, undefined, ctx)).toBe(o)
    expect(await addToolAttachments(o, [], ctx)).toBe(o)
  })

  it("an unknown model gives no image block", async () => {
    const n = await addToolAttachments(outcome("b"), [{ bytes: png(8, 8) }], ctx)
    expect(n.media).toBeUndefined()
  })
})
