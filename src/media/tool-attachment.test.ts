import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, describe, expect, it } from "bun:test"

import type { ToolAttachment } from "../../plugin-api/src/types/plugin.ts"
import type { ToolOutcome } from "../../plugin-api/src/types/tool-outcome.ts"
import { EMPTY_SYNTHETIC_TEXT } from "../agent/synthetic-text.ts"
import type { ModalitySupport } from "../llm/capabilities.ts"
import { attachmentFileName, BlobStore, DEFAULT_BLOB_STORE_CONFIG } from "../session/blob-store.ts"
import type { SidebandApi, SidebandKind } from "../sideband/types.ts"
import { SIBLING_REPO_ROOT } from "../test-utils/sibling-repo.ts"
import {
  fixtureSideband,
  fixtureSidebandOrNone,
  sidebandFixturePresent,
} from "../test-utils/sideband-fixture.ts"
import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import { defaultMediaLimits } from "./default-limits.ts"
import type { ReadFileMediaContext } from "./read-file.ts"
import {
  addToolAttachments,
  attachmentExtension,
  MAX_ATTACHMENT_BYTES,
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

/** The blob dir of the store of an input. */
const dirOf = (inp: ToolAttachmentInput): string => (inp.store as BlobStore).dir

function input(
  attachments: ToolAttachment[],
  over: Partial<ToolAttachmentInput> = {},
): ToolAttachmentInput {
  return {
    attachments,
    toolName: "ChromeCDP",
    toolUseId: "toolu_1",
    store: new BlobStore({ sid: "sid", dir: freshDir() }),
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
    const dir = dirOf(inp)
    expect(readdirSync(dir).sort()).toEqual(["toolu_1-1.png", "toolu_1-2.pdf", "toolu_1-3.bin"])
    expect([...readFileSync(join(dir, "toolu_1-1.png"))]).toEqual([...bytes])
  })

  withTags("the caption group names the saved path", async () => {
    const inp = input([{ bytes: png(8, 8) }])
    const r = await processToolAttachments(inp)
    expect(r.textLines[0]).toContain(join(dirOf(inp), "toolu_1-1.png"))
    expect(r.textLines[0]).toContain("image/png")
  })

  withText("a model with no image modality gets the rejection text, no block", async () => {
    const inp = input([{ bytes: png(8, 8) }], { media: media(NO_IMG) })
    const r = await processToolAttachments(inp)
    expect(r.media).toEqual([])
    expect(r.textLines[0]).toContain("does not accept image")
    expect(existsSync(join(dirOf(inp), "toolu_1-1.png"))).toBe(true)
  })

  it("an unknown model (no media context) gets no block and no gate text", async () => {
    const inp = input([{ bytes: png(8, 8) }], { media: undefined })
    const r = await processToolAttachments(inp)
    expect(r.media).toEqual([])
    expect(r.textLines.join("\n")).not.toContain("shown to the model")
    expect(existsSync(join(dirOf(inp), "toolu_1-1.png"))).toBe(true)
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
    expect(readdirSync(dirOf(inp))).toHaveLength(MAX_ATTACHMENT_IMAGES + 2)
  })

  it("with no blob dir writes no file and the tag has no path", async () => {
    const r = await processToolAttachments(input([{ bytes: png(8, 8) }], { store: null }))
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
        store: new BlobStore({ sid: "sid", dir: join(blocked, "sid.blobs") }),
        onWriteError: (file) => errors.push(file),
      }),
    )
    expect(errors).toHaveLength(1)
    expect(r.media).toHaveLength(1)
    expect(r.textLines.join("\n")).not.toContain("path=")
  })

  it("ignores an entry whose bytes is not a Uint8Array, and numbers by array position", async () => {
    const bad = { bytes: "not bytes" } as unknown as ToolAttachment
    const inp = input([bad, { bytes: png(8, 8) }])
    const r = await processToolAttachments(inp)
    expect(r.media).toHaveLength(1)
    // The plugin placeholder of the 2nd entry says 2: the file name agrees.
    expect(readdirSync(dirOf(inp))).toEqual(["toolu_1-2.png"])
  })

  it("keeps the file name inside the blob dir for a strange tool use id", async () => {
    const inp = input([{ bytes: png(8, 8) }], { toolUseId: "../x/y" })
    await processToolAttachments(inp)
    const names = readdirSync(dirOf(inp))
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^___x_y_[0-9a-f]{8}-1\.png$/)
  })

  it("two ids with the same cut stem get different file names", () => {
    expect(attachmentFileName("a.b", 1, "png")).not.toBe(attachmentFileName("a_b", 1, "png"))
    expect(attachmentFileName("a_b", 1, "png")).toBe("a_b-1.png")
    expect(attachmentFileName("a.b", 1, "png")).toMatch(/^a_b_[0-9a-f]{8}-1\.png$/)
  })

  it("keeps the LAST images in the slots: earlier images get a pointer only", async () => {
    // Different widths, so each block is known by its bytes.
    const shots = [1, 2, 3, 4, 5].map((w) => ({ bytes: png(w, 8) }))
    const r = await processToolAttachments(input(shots))
    expect(r.media).toHaveLength(MAX_ATTACHMENT_IMAGES)
    const sent = r.media.map((b) => (b.source.kind === "base64" ? b.source.data : ""))
    const want = shots
      .slice(-MAX_ATTACHMENT_IMAGES)
      .map((s) => Buffer.from(s.bytes).toString("base64"))
    expect(sent).toEqual(want)
  })

  it("the order rule and the byte cap: an image over the cap does not take a slot", async () => {
    // 5 images, the LAST one is over the cap: slots go to images 2, 3, 4.
    const big = new Uint8Array(64)
    big.set(png(9, 9))
    const shots = [1, 2, 3, 4].map((w) => ({ bytes: png(w, 8) }))
    const inp = input([...shots, { bytes: big }], { maxBytes: 32 })
    const r = await processToolAttachments(inp)
    const sent = r.media.map((b) => (b.source.kind === "base64" ? b.source.data : ""))
    const want = shots.slice(1).map((s) => Buffer.from(s.bytes).toString("base64"))
    expect(sent).toEqual(want)
    // The big one has no file.
    expect(readdirSync(dirOf(inp)).sort()).toEqual([
      "toolu_1-1.png",
      "toolu_1-2.png",
      "toolu_1-3.png",
      "toolu_1-4.png",
    ])
  })

  it("an attachment over the byte cap: no file, no block, no path", async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1)
    big.set(png(8, 8))
    const inp = input([{ bytes: big }], { maxBytes: 2 * 1024 * 1024 })
    const r = await processToolAttachments(inp)
    expect(r.media).toEqual([])
    expect(existsSync(dirOf(inp))).toBe(false)
    expect(r.textLines.join("\n")).not.toContain("path=")
    if (TEXT) expect(r.textLines[0]).toContain("The read limit is 2 MB")
  })

  it("the default byte cap is 32 MiB, 1/8 of the default session cap", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(32 * 1024 * 1024)
    expect(MAX_ATTACHMENT_BYTES * 8).toBe(DEFAULT_BLOB_STORE_CONFIG.maxBytesPerSession)
  })

  withTags("the tag and the gate text name one MIME type: the sniffed type wins", async () => {
    const r = await processToolAttachments(
      input([{ bytes: png(8, 8), mimeType: "image/jpeg" }], { media: media(NO_IMG) }),
    )
    const text = r.textLines.join("\n")
    expect(text).toContain('mime="image/png"')
    expect(text).not.toContain("image/jpeg")
  })

  withTags("with no known magic, the hint is the one MIME type", async () => {
    const r = await processToolAttachments(
      input([{ bytes: new Uint8Array([1, 2, 3]), mimeType: "application/x-thing" }]),
    )
    const text = r.textLines.join("\n")
    expect(text).toContain('mime="application/x-thing"')
    expect(text).not.toContain("octet-stream")
  })

  withTags(
    "the label works with the manifest of today, with or without the label attr",
    async () => {
      const r = await processToolAttachments(input([{ bytes: png(8, 8), label: "shot" }]))
      const text = r.textLines.join("\n")
      const nodes = SB.find(text, { kinds: ["binary-result"] })
      expect(nodes).toHaveLength(1)
      // A codec drops an attr that the kind does not declare.
      expect(nodes[0]?.attrs.label === "shot").toBe(siblingKindDeclaresLabel())
    },
  )

  withTags("a kind that declares label gets the label, escaped", async () => {
    const sb = labelSideband()
    const r = await processToolAttachments(
      input([{ bytes: png(8, 8), label: 'a "b" <c>' }], { sb }),
    )
    const text = r.textLines.join("\n")
    expect(text).toContain('label="a &quot;b&quot; &lt;c>"')
    const nodes = sb.find(text, { kinds: ["binary-result"] })
    expect(nodes[0]?.attrs.label).toBe('a "b" <c>')
  })
})

interface CoreToolsManifest {
  id: string
  sideband: (Omit<SidebandKind, "owner"> & { kind: string })[]
}

function coreToolsManifest(): CoreToolsManifest {
  const path = join(SIBLING_REPO_ROOT, "ma-core-tools-plugin", "manifest.json")
  return JSON.parse(readFileSync(path, "utf8")) as CoreToolsManifest
}

/** True when the sibling `binary-result` kind declares `label`. */
function siblingKindDeclaresLabel(): boolean {
  const k = coreToolsManifest().sideband.find((x) => x.kind === "binary-result")
  return k !== undefined && "label" in k.attrs
}

/** The fixture sideband with `label` added to the `binary-result` kind. */
function labelSideband(): SidebandApi {
  const m = coreToolsManifest()
  const k = m.sideband.find((x) => x.kind === "binary-result")
  if (!k) throw new Error("no binary-result kind")
  const kind = { ...k, attrs: { ...k.attrs, label: { type: "string" } }, owner: "" }
  return fixtureSideband({ siblingKinds: false, extraKinds: [[kind as SidebandKind, m.id]] })
}

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
  const ctx = { blobStore: null, model: "no-such-model" }
  const call = {
    tool: { id: "toolu_9", name: "ChromeCDP" },
    input: {},
    text: TEXT ?? EMPTY_SYNTHETIC_TEXT,
    sb: SB,
  }

  it("gives the same outcome for absent or empty attachments", async () => {
    const o = outcome("b")
    expect(await addToolAttachments(o, undefined, ctx, call)).toBe(o)
    expect(await addToolAttachments(o, [], ctx, call)).toBe(o)
  })

  it("an unknown model gives no image block", async () => {
    const n = await addToolAttachments(outcome("b"), [{ bytes: png(8, 8) }], ctx, call)
    expect(n.media).toBeUndefined()
  })

  it("a store that is off writes no file", async () => {
    const dir = freshDir()
    const store = new BlobStore({ sid: "sid", dir, config: { enabled: false } })
    await addToolAttachments(
      outcome("b"),
      [{ bytes: png(8, 8) }],
      { ...ctx, blobStore: store },
      call,
    )
    expect(existsSync(dir)).toBe(false)
  })

  it("a store with a small session cap lowers the byte cap", async () => {
    const dir = freshDir()
    const store = new BlobStore({ sid: "sid", dir, config: { maxBytesPerSession: 16 } })
    await addToolAttachments(
      outcome("b"),
      [{ bytes: png(8, 8) }],
      { ...ctx, blobStore: store },
      call,
    )
    expect(existsSync(dir)).toBe(false)
  })

  withTags("scrubs a data URI in the plugin body, also with an attachment", async () => {
    const svg = `data:image/svg+xml;base64,${"A".repeat(600)}`
    const o = outcome(`see ![x](${svg}) here`)
    const n = await addToolAttachments(o, [{ bytes: png(8, 8) }], ctx, call)
    expect(n.body.text).not.toContain(";base64,")
    expect(n.body.text).toContain("redacted-asset")
    expect(n.body.text).toContain("binary-result")
    expect(n.rawForBlob).toContain(svg)
  })

  withTags("binary: true in the input keeps the data URI", async () => {
    const svg = `data:image/svg+xml;base64,${"A".repeat(600)}`
    const opt = { ...call, input: { binary: true } }
    const n = await addToolAttachments(outcome(svg), [{ bytes: png(8, 8) }], ctx, opt)
    expect(n.body.text).toContain(svg)
  })
})
