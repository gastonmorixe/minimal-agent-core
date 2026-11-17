/**
 * Dependency-free media probing: sniff the real mime type from magic bytes
 * (the extension is a fallback only, for formats with no magic: Office, text,
 * code) and read intrinsic image dimensions for JPEG, PNG, GIF and WebP. Pure
 * functions over a byte buffer; no I/O.
 *
 * @module media/probe
 */

import type { MediaKind } from "./types.ts"

// ---------------------------------------------------------------------------
// Mime sniffing
// ---------------------------------------------------------------------------

const ascii = (b: Uint8Array, start: number, str: string): boolean => {
  if (start + str.length > b.length) return false
  for (let i = 0; i < str.length; i++) {
    if (b[start + i] !== str.charCodeAt(i)) return false
  }
  return true
}

/**
 * Best-effort mime from magic bytes. Returns `application/octet-stream` when
 * nothing matches (the caller then rejects it as an unsupported type).
 */
export function sniffMime(b: Uint8Array): string {
  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg"
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return "image/png"
  }
  // GIF: "GIF87a" / "GIF89a"
  if (ascii(b, 0, "GIF87a") || ascii(b, 0, "GIF89a")) return "image/gif"
  // WebP: "RIFF"????"WEBP"
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "image/webp"
  // PDF: "%PDF-"
  if (ascii(b, 0, "%PDF-")) return "application/pdf"
  return sniffAudioVideo(b) ?? "application/octet-stream"
}

/** ISO-BMFF major brands of an audio-only file (m4a / m4b / m4p). */
const AUDIO_BRANDS = new Set(["M4A ", "M4B ", "M4P "])

/**
 * Audio / video mime from magic bytes, or null. Covers mp3 (ID3 tag or an
 * MPEG layer III frame sync), wav, ogg, flac, the ISO-BMFF family (m4a, mp4,
 * mov) and EBML (webm, mkv).
 */
function sniffAudioVideo(b: Uint8Array): string | null {
  // MP3: "ID3" tag, or frame sync 11 bits set + layer III (bits 01).
  if (ascii(b, 0, "ID3")) return "audio/mpeg"
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && (b[1]! & 0x06) === 0x02) {
    return "audio/mpeg"
  }
  // WAV: "RIFF"????"WAVE"
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")) return "audio/wav"
  if (ascii(b, 0, "OggS")) return "audio/ogg"
  if (ascii(b, 0, "fLaC")) return "audio/flac"
  // ISO-BMFF: ????"ftyp" + 4-char major brand.
  if (ascii(b, 4, "ftyp") && b.length >= 12) {
    const brand = String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!)
    if (AUDIO_BRANDS.has(brand)) return "audio/mp4"
    if (brand === "qt  ") return "video/quicktime"
    return "video/mp4"
  }
  // EBML header 1A 45 DF A3; the DocType tells webm from matroska.
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const head = b.subarray(0, Math.min(b.length, 64))
    for (let i = 4; i + 4 <= head.length; i++) {
      if (ascii(head, i, "webm")) return "video/webm"
    }
    return "video/x-matroska"
  }
  return null
}

// ---------------------------------------------------------------------------
// Extension typing (for formats with no reliable magic bytes)
// ---------------------------------------------------------------------------

const OFFICE_MIME: Readonly<Record<string, string>> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}

/** Text formats with their own MIME type. */
const TEXT_MIME: Readonly<Record<string, string>> = {
  txt: "text/plain",
  text: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  jsonl: "application/x-ndjson",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  yaml: "application/yaml",
  yml: "application/yaml",
}

/** Source-code extensions: typed as `text/plain` (every text-capable model reads it). */
const CODE_EXTENSIONS: ReadonlySet<string> = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "lua",
  "toml",
  "ini",
  "scala",
  "dart",
  "r",
  "pl",
  "ex",
  "exs",
  "hs",
  "vue",
  "svelte",
])

/** Media extensions whose type comes from magic bytes; listed so a drop is recognized. */
const MAGIC_EXTENSIONS: ReadonlySet<string> = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "pdf",
  "mp3",
  "wav",
  "ogg",
  "oga",
  "flac",
  "m4a",
  "mp4",
  "m4v",
  "mov",
  "webm",
  "mkv",
])

/** Lowercase extension of a path without the dot, or "" when there is none. */
function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1)
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ""
}

/** True when the first 8 KB hold no NUL byte (a cheap "this is text" check). */
function looksLikeText(b: Uint8Array): boolean {
  const n = Math.min(b.length, 8192)
  for (let i = 0; i < n; i++) if (b[i] === 0) return false
  return true
}

/**
 * The MIME type of a file that magic bytes cannot identify, from its
 * extension: Office (docx / xlsx / pptx, which are zip archives), text
 * formats (csv, json, md, txt, ...) and source code (`text/plain`). A text
 * type needs bytes with no NUL in the first 8 KB, so a renamed binary stays
 * untyped.
 *
 * @param path - The file path (only the extension is read).
 * @param bytes - The file bytes, for the text check. Omitted: no check.
 * @returns The MIME type, or null when the extension is not typed.
 */
export function mimeFromExtension(path: string, bytes?: Uint8Array): string | null {
  const ext = extensionOf(path)
  if (!ext) return null
  const office = OFFICE_MIME[ext]
  if (office) return bytes === undefined || ascii(bytes, 0, "PK") ? office : null
  const text = TEXT_MIME[ext] ?? (CODE_EXTENSIONS.has(ext) ? "text/plain" : undefined)
  if (!text) return null
  return bytes === undefined || looksLikeText(bytes) ? text : null
}

/**
 * True when the media registry can type a file with this path: its
 * extension is a magic-byte media format or one {@link mimeFromExtension}
 * knows. Used to decide if a dropped path is an attachment.
 */
export function isTypedMediaPath(path: string): boolean {
  const ext = extensionOf(path)
  return ext !== "" && (MAGIC_EXTENSIONS.has(ext) || mimeFromExtension(path) !== null)
}

/**
 * True when a file with this path is an image, audio or video file by its
 * extension (not a document). Used to auto-attach bare paths typed in prose.
 */
export function isAudioVisualPath(path: string): boolean {
  const ext = extensionOf(path)
  return MAGIC_EXTENSIONS.has(ext) && ext !== "pdf"
}

/** Map a mime to its coarse {@link MediaKind}. Unknown mimes fall back to `document`. */
export function mimeToKind(mime: string): MediaKind {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  return "document"
}

// ---------------------------------------------------------------------------
// Image dimensions
// ---------------------------------------------------------------------------

export interface Dimensions {
  width: number
  height: number
}

const u16be = (b: Uint8Array, o: number): number => (b[o]! << 8) | b[o + 1]!
const u16le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8)
const u24le = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16)
const u32be = (b: Uint8Array, o: number): number =>
  (b[o]! * 0x1000000 + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!) >>> 0

function pngDimensions(b: Uint8Array): Dimensions | null {
  // IHDR width/height are the first chunk: width at byte 16, height at 20 (BE).
  if (b.length < 24) return null
  return { width: u32be(b, 16), height: u32be(b, 20) }
}

function gifDimensions(b: Uint8Array): Dimensions | null {
  // Logical screen descriptor: width LE at 6, height LE at 8.
  if (b.length < 10) return null
  return { width: u16le(b, 6), height: u16le(b, 8) }
}

function jpegDimensions(b: Uint8Array): Dimensions | null {
  // Walk the marker segments looking for a Start-Of-Frame (SOFn) marker.
  let o = 2 // skip SOI (FF D8)
  while (o + 9 < b.length) {
    if (b[o] !== 0xff) {
      o++
      continue
    }
    const marker = b[o + 1]!
    // SOF0..SOF15 carry the dimensions, except DHT(C4), JPG(C8), DAC(CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, o + 5), width: u16be(b, o + 7) }
    }
    // Standalone markers (RSTn, SOI, EOI, TEM) have no length payload.
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      o += 2
      continue
    }
    const segLen = u16be(b, o + 2)
    if (segLen < 2) return null
    o += 2 + segLen
  }
  return null
}

function webpDimensions(b: Uint8Array): Dimensions | null {
  if (b.length < 30 || !ascii(b, 12, "VP8")) return null
  const fourcc = String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!)
  if (fourcc === "VP8 ") {
    // Lossy: 14-bit width/height LE at offset 26/28.
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff }
  }
  if (fourcc === "VP8L") {
    // Lossless: signature 0x2F at 20, then 14-bit (width-1), 14-bit (height-1).
    if (b[20] !== 0x2f) return null
    const bits = b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (fourcc === "VP8X") {
    // Extended: 24-bit (canvas width-1) at 24, (height-1) at 27, LE.
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 }
  }
  return null
}

/**
 * Intrinsic pixel dimensions, or `null` when the format is unknown / the buffer
 * is too short. Picks the reader by sniffed mime so a mislabeled file still
 * works.
 */
export function imageDimensions(b: Uint8Array, mime = sniffMime(b)): Dimensions | null {
  switch (mime) {
    case "image/png":
      return pngDimensions(b)
    case "image/gif":
      return gifDimensions(b)
    case "image/jpeg":
      return jpegDimensions(b)
    case "image/webp":
      return webpDimensions(b)
    default:
      return null
  }
}
