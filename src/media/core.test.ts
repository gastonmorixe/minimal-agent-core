import { describe, expect, it } from "bun:test"

import type { ModalitySupport } from "../llm/capabilities.ts"

import { mediaId, mediaIdFromSha, randomMediaId, sha256Hex } from "./id.ts"
import { checkMedia, checkMediaSet, kindModality, type MediaLimits } from "./limits.ts"
import { imageDimensions, mimeToKind, sniffMime } from "./probe.ts"
import {
  formatMediaToken,
  parseMediaTokens,
  replaceMediaTokens,
  stripMediaTokens,
} from "./token.ts"
import { formatBytes, formatDuration, type MediaItem, mediaDescriptor } from "./types.ts"

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const ALL_MODALITIES: ModalitySupport = { image: true, audio: true, pdf: true, video: true }
const IMG_ONLY: ModalitySupport = { image: true, audio: false, pdf: false, video: false }

const TEST_LIMITS: MediaLimits = {
  acceptedMimeTypes: new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  maxBytesPerItem: 5 * 1024 * 1024,
  maxRequestBytes: 32 * 1024 * 1024,
  maxItemsPerRequest: 100,
  maxDimension: 8000,
}

function pngHeader(width: number, height: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8) // IHDR
  b[16] = (width >>> 24) & 0xff
  b[17] = (width >>> 16) & 0xff
  b[18] = (width >>> 8) & 0xff
  b[19] = width & 0xff
  b[20] = (height >>> 24) & 0xff
  b[21] = (height >>> 16) & 0xff
  b[22] = (height >>> 8) & 0xff
  b[23] = height & 0xff
  return b
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

describe("formatBytes", () => {
  it("uses 1024-based units", () => {
    expect(formatBytes(512)).toBe("512B")
    expect(formatBytes(472262)).toBe("461KB")
    expect(formatBytes(1_572_864)).toBe("1.5MB")
  })
})

describe("formatDuration", () => {
  it("zero-pads seconds inside a minute", () => {
    expect(formatDuration(8)).toBe("8s")
    expect(formatDuration(124)).toBe("2m04s")
    expect(formatDuration(3720)).toBe("1h02m")
  })
})

describe("mediaDescriptor", () => {
  it("describes an image with dims + size", () => {
    expect(
      mediaDescriptor({
        kind: "image",
        mimeType: "image/jpeg",
        sizeBytes: 472262,
        dimensions: { width: 1466, height: 1954 },
        durationSec: null,
      }),
    ).toBe("1466x1954 461KB")
  })
  it("labels a document by subtype", () => {
    expect(
      mediaDescriptor({
        kind: "document",
        mimeType: "application/pdf",
        sizeBytes: 1_258_291,
        dimensions: null,
        durationSec: null,
      }),
    ).toBe("PDF 1.2MB")
  })
})

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

describe("sniffMime", () => {
  it("detects formats by magic bytes", () => {
    expect(sniffMime(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg")
    expect(sniffMime(pngHeader(1, 1))).toBe("image/png")
    expect(sniffMime(Uint8Array.from([...Buffer.from("GIF89a")]))).toBe("image/gif")
    const webp = new Uint8Array(16)
    webp.set([...Buffer.from("RIFF")], 0)
    webp.set([...Buffer.from("WEBP")], 8)
    expect(sniffMime(webp)).toBe("image/webp")
    expect(sniffMime(Uint8Array.from([...Buffer.from("%PDF-1.7")]))).toBe("application/pdf")
    expect(sniffMime(Uint8Array.from([1, 2, 3, 4]))).toBe("application/octet-stream")
  })
})

describe("mimeToKind", () => {
  it("maps mime prefixes to kinds", () => {
    expect(mimeToKind("image/png")).toBe("image")
    expect(mimeToKind("audio/wav")).toBe("audio")
    expect(mimeToKind("video/mp4")).toBe("video")
    expect(mimeToKind("application/pdf")).toBe("document")
  })
})

describe("imageDimensions", () => {
  it("reads PNG dimensions", () => {
    expect(imageDimensions(pngHeader(1466, 1954))).toEqual({ width: 1466, height: 1954 })
  })
  it("reads GIF dimensions (LE)", () => {
    const b = new Uint8Array(10)
    b.set([...Buffer.from("GIF89a")], 0)
    b[6] = 64 // width LE
    b[8] = 48 // height LE
    expect(imageDimensions(b)).toEqual({ width: 64, height: 48 })
  })
  it("reads JPEG SOF0 dimensions (BE)", () => {
    const b = new Uint8Array(20)
    b.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0)
    b[7] = 0x00
    b[8] = 0x64 // height 100
    b[9] = 0x00
    b[10] = 0xc8 // width 200
    expect(imageDimensions(b)).toEqual({ width: 200, height: 100 })
  })
  it("reads WebP (lossy VP8 ) dimensions (LE 14-bit)", () => {
    const b = new Uint8Array(30)
    b.set([...Buffer.from("RIFF")], 0)
    b.set([...Buffer.from("WEBP")], 8)
    b.set([...Buffer.from("VP8 ")], 12)
    b[23] = 0x9d
    b[24] = 0x01
    b[25] = 0x2a
    b[26] = 0x40
    b[27] = 0x01 // width 320
    b[28] = 0xf0
    b[29] = 0x00 // height 240
    expect(imageDimensions(b)).toEqual({ width: 320, height: 240 })
  })
  it("returns null for unknown formats", () => {
    expect(imageDimensions(Uint8Array.from([1, 2, 3]))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// limits
// ---------------------------------------------------------------------------

describe("checkMedia", () => {
  const base = { kind: "image" as const, mimeType: "image/jpeg", sizeBytes: 1000, dimensions: null }

  it("accepts a valid image", () => {
    expect(checkMedia(base, TEST_LIMITS, ALL_MODALITIES).ok).toBe(true)
  })
  it("rejects an unsupported modality", () => {
    const v = checkMedia({ ...base, kind: "audio", mimeType: "audio/wav" }, TEST_LIMITS, IMG_ONLY)
    expect(v).toMatchObject({ ok: false, code: "unsupported-modality" })
  })
  it("rejects an unsupported mime", () => {
    const v = checkMedia({ ...base, mimeType: "image/heic" }, TEST_LIMITS, ALL_MODALITIES)
    expect(v).toMatchObject({ ok: false, code: "unsupported-type" })
  })
  it("rejects an oversize item", () => {
    const v = checkMedia({ ...base, sizeBytes: 9 * 1024 * 1024 }, TEST_LIMITS, ALL_MODALITIES)
    expect(v).toMatchObject({ ok: false, code: "too-large" })
  })
  it("rejects a raw size under the cap whose base64 encoding exceeds it", () => {
    // Regression: a 4.2 MB macOS screenshot is < 5 MB raw but ~5.6 MB once
    // base64-encoded, which is what the API actually weighs. A raw-only check
    // passed it and the server returned a 400. The encoded check must reject.
    const v = checkMedia({ ...base, sizeBytes: 4.2 * 1024 * 1024 }, TEST_LIMITS, ALL_MODALITIES)
    expect(v).toMatchObject({ ok: false, code: "too-large" })
  })
  it("accepts a raw size that stays under the cap after encoding", () => {
    // 3.5 MB raw → ~4.67 MB encoded, still under 5 MB.
    const v = checkMedia({ ...base, sizeBytes: 3.5 * 1024 * 1024 }, TEST_LIMITS, ALL_MODALITIES)
    expect(v.ok).toBe(true)
  })
  it("rejects oversize dimensions", () => {
    const v = checkMedia(
      { ...base, dimensions: { width: 9000, height: 100 } },
      TEST_LIMITS,
      ALL_MODALITIES,
    )
    expect(v).toMatchObject({ ok: false, code: "dimensions" })
  })
})

describe("kindModality", () => {
  it("maps document to the pdf flag", () => {
    expect(kindModality("document")).toBe("pdf")
    expect(kindModality("image")).toBe("image")
  })
})

describe("checkMediaSet", () => {
  it("rejects the items that overflow the request byte budget", () => {
    const big = { sizeBytes: 20 * 1024 * 1024 }
    const verdicts = checkMediaSet([big, big, big], TEST_LIMITS)
    // Encoded: 20MB → ~26.7MB. First fits under 32MB; running total ~53.3MB on
    // the 2nd and ~80MB on the 3rd both overflow the request budget.
    expect(verdicts[0]!.ok).toBe(true)
    expect(verdicts[1]).toMatchObject({ ok: false, code: "request-too-large" })
    expect(verdicts[2]).toMatchObject({ ok: false, code: "request-too-large" })
  })
  it("rejects beyond the item count cap", () => {
    const tiny = { sizeBytes: 1 }
    const limits = { ...TEST_LIMITS, maxItemsPerRequest: 2 }
    const verdicts = checkMediaSet([tiny, tiny, tiny], limits)
    expect(verdicts[2]).toMatchObject({ ok: false, code: "too-many" })
  })
})

// ---------------------------------------------------------------------------
// id
// ---------------------------------------------------------------------------

describe("media id", () => {
  it("is content-addressed and deterministic (dedupes)", () => {
    const a = mediaId(Uint8Array.from([1, 2, 3, 4]))
    const b = mediaId(Uint8Array.from([1, 2, 3, 4]))
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{8}$/)
  })
  it("differs for different content", () => {
    expect(mediaId(Uint8Array.from([1]))).not.toBe(mediaId(Uint8Array.from([2])))
  })
  it("derives from a sha prefix", () => {
    const sha = sha256Hex(Uint8Array.from([9]))
    expect(mediaIdFromSha(sha)).toBe(sha.slice(0, 8))
  })
  it("random ids are well-formed", () => {
    expect(randomMediaId()).toMatch(/^[0-9a-f]{8}$/)
  })
})

// ---------------------------------------------------------------------------
// token grammar
// ---------------------------------------------------------------------------

function fakeItem(over: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "a1b2c3d4",
    kind: "image",
    mimeType: "image/jpeg",
    origin: "drop",
    path: "/tmp/x.jpg",
    sizeBytes: 472262,
    sha256: "a1b2c3d4ef",
    dimensions: { width: 1466, height: 1954 },
    durationSec: null,
    state: "registered",
    bytes: async () => new Uint8Array(),
    prepared: {},
    createdAt: 0,
    ...over,
  }
}

describe("media token", () => {
  it("formats the canonical token", () => {
    expect(formatMediaToken(fakeItem())).toBe("[Image #a1b2c3d4 1466x1954 461KB]")
  })
  it("parses kind + id and ignores the cosmetic middle", () => {
    const refs = parseMediaTokens(
      "look at [Image #a1b2c3d4 1466x1954 461KB] and [File #deadbeef PDF 1.2MB]",
    )
    expect(refs).toHaveLength(2)
    expect(refs[0]).toMatchObject({ kind: "image", id: "a1b2c3d4" })
    expect(refs[1]).toMatchObject({ kind: "document", id: "deadbeef" })
  })
  it("round-trips format -> parse", () => {
    const tok = formatMediaToken(fakeItem({ id: "0badf00d" }))
    const refs = parseMediaTokens(`x ${tok} y`)
    expect(refs[0]!.id).toBe("0badf00d")
  })
  it("strips tokens and collapses whitespace", () => {
    expect(stripMediaTokens("describe [Image #a1b2c3d4 1466x1954 461KB] please")).toBe(
      "describe please",
    )
  })
  it("ignores malformed ids", () => {
    expect(parseMediaTokens("[Image #xyz] [Image #a1b2c3]")).toHaveLength(0)
  })
  it("replaceMediaTokens drops some tokens and substitutes others", () => {
    const out = replaceMediaTokens(
      "a [Image #a1b2c3d4 1x1] b [File #deadbeef PDF] c",
      (_kind, id) => (id === "deadbeef" ? `[file not sent: too large]` : ""),
    )
    // The image token is dropped (whitespace collapsed); the file token becomes
    // a marker in place.
    expect(out).toBe("a b [file not sent: too large] c")
  })
  it("replaceMediaTokens leaves a non-empty replacement verbatim", () => {
    const out = replaceMediaTokens("x [Image #a1b2c3d4 1x1]", () => "[image not sent: oops]")
    expect(out).toBe("x [image not sent: oops]")
  })
})
