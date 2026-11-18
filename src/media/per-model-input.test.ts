/**
 * Per-model input formats: sniffing, extension typing, and the model gate on
 * the tool, submit and paste paths.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { defaultCapabilities, type ModalitySupport } from "../llm/capabilities.ts"
import { buildModelInfoSnapshot } from "../llm/model-info.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  type ModelEntry,
  registerModel,
  registerProvider,
} from "../llm/model-registry.ts"
import type { ProviderAdapter } from "../llm/provider.ts"

import { defaultMediaLimits } from "./default-limits.ts"
import { buildUserContent } from "./ingest.ts"
import { checkMedia, type MediaLimits } from "./limits.ts"
import { mediaPasteInterceptor } from "./paste-intercept.ts"
import { isTypedMediaPath, mimeFromExtension, mimeToKind, sniffMime } from "./probe.ts"
import { createMediaRegistry } from "./registry.ts"
import { resolveMediaTurn } from "./resolve.ts"
import { formatMediaToken } from "./token.ts"
import { resolveModelMediaContext } from "./tool-context.ts"

const bytes = (...parts: Array<string | number[]>): Uint8Array => {
  const out: number[] = []
  for (const p of parts) out.push(...(typeof p === "string" ? [...Buffer.from(p, "latin1")] : p))
  while (out.length < 32) out.push(0)
  return Uint8Array.from(out)
}

const ALL: ModalitySupport = { image: true, audio: true, pdf: true, video: true }

afterEach(() => {
  clearModelRegistry()
  clearProviderRegistry()
})

function register(id: string, caps: Partial<ModelEntry["capabilities"]>, limits?: MediaLimits) {
  registerModel({
    id,
    providerId: "fmtprov",
    surfaceId: "fmt-surface",
    displayName: id,
    capabilities: { ...defaultCapabilities(), ...caps },
    pricing: {
      inputUSD: 0,
      outputUSD: 0,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  })
  registerProvider({
    id: "fmtprov",
    displayName: "Fmt",
    surfaces: ["fmt-surface"],
    validate: () => ({ ok: true, errors: [] }),
    run: async function* () {},
    ...(limits ? { mediaLimits: () => limits } : {}),
  } as unknown as ProviderAdapter)
}

describe("sniffMime: audio and video", () => {
  it("detects mp3, wav, ogg, flac by magic bytes", () => {
    expect(sniffMime(bytes("ID3", [3, 0]))).toBe("audio/mpeg")
    expect(sniffMime(bytes([0xff, 0xfb, 0x90]))).toBe("audio/mpeg")
    expect(sniffMime(bytes("RIFF", [0, 0, 0, 0], "WAVE"))).toBe("audio/wav")
    expect(sniffMime(bytes("OggS"))).toBe("audio/ogg")
    expect(sniffMime(bytes("fLaC"))).toBe("audio/flac")
  })

  it("detects m4a, mp4, mov in the ISO-BMFF family", () => {
    expect(sniffMime(bytes([0, 0, 0, 0x20], "ftypM4A "))).toBe("audio/mp4")
    expect(sniffMime(bytes([0, 0, 0, 0x20], "ftypisom"))).toBe("video/mp4")
    expect(sniffMime(bytes([0, 0, 0, 0x14], "ftypqt  "))).toBe("video/quicktime")
  })

  it("detects webm by its EBML DocType", () => {
    expect(sniffMime(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84], "webm"))).toBe(
      "video/webm",
    )
  })

  it("keeps the kinds right", () => {
    expect(mimeToKind("audio/mp4")).toBe("audio")
    expect(mimeToKind("video/quicktime")).toBe("video")
  })
})

describe("mimeFromExtension", () => {
  it("types office files only when they are zip archives", () => {
    expect(mimeFromExtension("/a/b.docx", bytes("PK", [3, 4]))).toContain("wordprocessingml")
    expect(mimeFromExtension("/a/b.XLSX", bytes("PK", [3, 4]))).toContain("spreadsheetml")
    expect(mimeFromExtension("/a/b.pptx", bytes("PK", [3, 4]))).toContain("presentationml")
    expect(mimeFromExtension("/a/b.docx", bytes("not a zip"))).toBeNull()
  })

  it("types text and code files, but not binary bytes", () => {
    const txt = Uint8Array.from(Buffer.from("a,b\n1,2\n"))
    expect(mimeFromExtension("/a/data.csv", txt)).toBe("text/csv")
    expect(mimeFromExtension("/a/data.json", txt)).toBe("application/json")
    expect(mimeFromExtension("/a/README.md", txt)).toBe("text/markdown")
    expect(mimeFromExtension("/a/notes.txt", txt)).toBe("text/plain")
    expect(mimeFromExtension("/a/main.ts", txt)).toBe("text/plain")
    expect(mimeFromExtension("/a/main.ts", Uint8Array.from([0x61, 0, 0x62]))).toBeNull()
    expect(mimeFromExtension("/a/noext", txt)).toBeNull()
  })

  it("reports typed paths", () => {
    expect(isTypedMediaPath("/a/song.flac")).toBe(true)
    expect(isTypedMediaPath("/a/x.py")).toBe(true)
    expect(isTypedMediaPath("/a/x.zip")).toBe(false)
  })

  it("the registry types a text file by its extension", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-fmt-"))
    try {
      const p = join(dir, "data.csv")
      writeFileSync(p, "a,b\n1,2\n")
      const item = await createMediaRegistry().registerPath(p)
      expect(item.mimeType).toBe("text/csv")
      expect(item.kind).toBe("document")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("checkMedia per model", () => {
  const limits = (types: string[]): MediaLimits => ({
    ...defaultMediaLimits(),
    acceptedMimeTypes: new Set(types),
  })
  const csv = { kind: "document" as const, mimeType: "text/csv", sizeBytes: 10, dimensions: null }

  it("does not gate a document on the pdf flag", () => {
    const noPdf = { ...ALL, pdf: false }
    expect(checkMedia(csv, limits(["text/csv"]), noPdf, "m").ok).toBe(true)
  })

  it("rejects a format the model does not list, with model and format facts", () => {
    const v = checkMedia(csv, limits(["application/pdf"]), ALL, "model-x")
    expect(v).toMatchObject({
      ok: false,
      code: "unsupported-type",
      facts: { modelId: "model-x", mimeType: "text/csv", reason: "unsupported-type" },
    })
  })

  it("still gates audio on its modality flag", () => {
    const wav = { kind: "audio" as const, mimeType: "audio/wav", sizeBytes: 10, dimensions: null }
    expect(checkMedia(wav, limits(["audio/wav"]), { ...ALL, audio: false }).ok).toBe(false)
    expect(checkMedia(wav, limits(["audio/wav"]), ALL).ok).toBe(true)
  })
})

describe("model media context", () => {
  it("uses the model's inputMimeTypes over the provider default", () => {
    register("m-audio", { modalities: ALL, inputMimeTypes: ["audio/wav", "video/mp4"] })
    const ctx = resolveModelMediaContext("m-audio")
    expect([...(ctx?.limits.acceptedMimeTypes ?? [])]).toEqual(["audio/wav", "video/mp4"])
  })

  it("derives the list from the provider limits and the flags", () => {
    register("m-img", { modalities: { ...ALL, pdf: false, audio: false, video: false } })
    const ctx = resolveModelMediaContext("m-img")
    expect([...(ctx?.limits.acceptedMimeTypes ?? [])].every((m) => m.startsWith("image/"))).toBe(
      true,
    )
    const s = buildModelInfoSnapshot("m-img")
    expect(s.acceptedInput.images).toEqual(["jpeg", "png", "gif", "webp"])
    expect(s.acceptedInput.documents).toBeUndefined()
  })

  it("model info lists audio and video from the resolved list", () => {
    register("m-av", { modalities: ALL, inputMimeTypes: ["audio/mpeg", "video/quicktime"] })
    const s = buildModelInfoSnapshot("m-av")
    expect(s.acceptedInput.audio).toEqual(["mp3"])
    expect(s.acceptedInput.video).toEqual(["mov"])
  })
})

describe("submit path gates on the active model", () => {
  it("rejects a csv for a pdf-only model and accepts it for a text model", async () => {
    const reg = createMediaRegistry()
    const item = await reg.registerBytes(Buffer.from("a,b\n"), "clipboard", "text/csv")
    const prompt = `${formatMediaToken(item)} sum it`
    register("pdf-only", { modalities: ALL, inputMimeTypes: ["application/pdf"] })
    const r1 = await buildUserContent(prompt, reg, { modelId: "pdf-only" })
    expect(r1.rejected[0]?.rejection.code).toBe("unsupported-type")
    expect(r1.rejected[0]?.rejection.facts).toMatchObject({ modelId: "pdf-only" })
    clearModelRegistry()
    register("text-docs", { modalities: { ...ALL, pdf: false }, inputMimeTypes: ["text/csv"] })
    const r2 = await buildUserContent(prompt, reg, { modelId: "text-docs" })
    expect(r2.rejected).toHaveLength(0)
    expect(r2.hadMedia).toBe(true)
  })

  it("resolve emits a canonical video block", async () => {
    const reg = createMediaRegistry()
    const item = await reg.registerBytes(bytes([0, 0, 0, 0x20], "ftypisom"), "clipboard")
    const res = await resolveMediaTurn({
      text: formatMediaToken(item),
      registry: reg,
      limits: { ...defaultMediaLimits(), acceptedMimeTypes: new Set(["video/mp4"]) },
      modalities: ALL,
    })
    expect(res.content[0]).toMatchObject({
      type: "video",
      source: { kind: "base64", mediaType: "video/mp4" },
    })
  })
})

describe("paste gates on the active model", () => {
  it("rejects a dropped wav for an image-only model, accepts it with no model", () => {
    const dir = mkdtempSync(join(tmpdir(), "ma-paste-"))
    try {
      const p = join(dir, "a.wav")
      writeFileSync(p, bytes("RIFF", [0, 0, 0, 0], "WAVE"))
      register("img-only", { modalities: { ...ALL, audio: false } })
      const warns: string[] = []
      const diag = { warn: (code: string) => warns.push(code) } as never
      expect(mediaPasteInterceptor(p, createMediaRegistry(), diag, undefined, "img-only")).toBe(
        null,
      )
      expect(warns).toEqual(["media.rejected"])
      expect(mediaPasteInterceptor(p, createMediaRegistry(), diag)).toMatch(/Audio/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
