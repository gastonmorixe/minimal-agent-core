/**
 * Universal binary-output guard for tool results.
 *
 * Models cannot usefully consume raw binary as UTF-8 text (PDF / images /
 * archives become mojibake that pollutes context). This module is the single
 * choke point that:
 *
 *   1. Detects binary-looking bodies (magic bytes + NUL / replacement-char
 *      heuristics on already-decoded strings).
 *   2. Formats a stable `<ma::agent::binary-result …/>` summary the model
 *      can act on (path, mime, size) instead of the body.
 *   3. Honors an explicit `binary: true` opt-in on the tool input (injected
 *      into schemas of tools that declare `mayReturnBinary`).
 *
 * Multimodal safety: this NEVER touches `ToolExecResult.blocks` (image
 * content blocks from Read) and never runs on user-message document/image
 * uploads. It only rewrites string `content` that would otherwise go to the
 * model as text.
 *
 * @module tools/binary-guard
 */

import { sniffMime } from "../media/probe.ts"
import { formatBytes as formatBlobBytes } from "../session/blob-store.ts"

/** Max sample scanned for binary heuristics (keeps the check O(1) on huge bodies). */
const SAMPLE_BYTES = 8_192

/**
 * Fraction of NULs / replacement chars / C0 controls (excluding tab/lf/cr)
 * in the sample above which we treat the body as binary. Tuned to catch
 * UTF-8-decoded PDF/PNG while leaving source/logs alone.
 */
const CONTROL_RATIO_THRESHOLD = 0.02

/** Minimum sample size before the control-ratio heuristic is trusted. */
const MIN_RATIO_SAMPLE = 64

/**
 * Opt-in flag name injected into tool schemas when a tool declares
 * `mayReturnBinary: true`. Keep in sync with {@link injectBinaryOptInArg}.
 */
export const BINARY_OPT_IN_ARG = "binary"

/** JSON Schema fragment for the auto-injected `binary` argument. */
export const BINARY_OPT_IN_SCHEMA = {
  type: "boolean",
  default: false,
  description:
    "Opt-in to receive binary tool output. Default false: binary bodies are withheld and replaced with a <ma::agent::binary-result …/> summary (mime, size, on-disk path). Set true only when you intentionally need the bytes (returned as base64 when small enough; otherwise still path-only). Never dumps raw binary as text.",
} as const

/**
 * True when the tool call explicitly opted into binary delivery.
 * Only `true` (boolean) counts — strings / 1 / "true" do not.
 */
export function isBinaryOptIn(input: Record<string, unknown> | undefined): boolean {
  return input?.[BINARY_OPT_IN_ARG] === true
}

/**
 * Inject the `binary` opt-in property into a tool's `input_schema` when the
 * tool declared `mayReturnBinary`. Idempotent: if `properties.binary` already
 * exists, the schema is returned unchanged (plugin-authored description wins).
 *
 * Does not mutate the input; returns a shallow-cloned schema with a cloned
 * `properties` object when injection happens.
 */
export function injectBinaryOptInArg(schema: Record<string, unknown>): Record<string, unknown> {
  const propsRaw = schema.properties
  if (propsRaw != null && (typeof propsRaw !== "object" || Array.isArray(propsRaw))) {
    // Malformed schema — leave it alone; the provider will reject it later.
    return schema
  }
  const props = (propsRaw ?? {}) as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(props, BINARY_OPT_IN_ARG)) {
    return schema
  }
  return {
    ...schema,
    type: schema.type ?? "object",
    properties: {
      ...props,
      [BINARY_OPT_IN_ARG]: { ...BINARY_OPT_IN_SCHEMA },
    },
  }
}

/**
 * Classify raw bytes as binary / text using magic-byte sniff + NUL scan.
 * Preferred entry point when the producer still holds a `Uint8Array`.
 */
export function classifyBinaryBytes(bytes: Uint8Array): {
  binary: boolean
  mime: string
} {
  if (bytes.length === 0) return { binary: false, mime: "text/plain" }

  const mime = sniffMime(bytes)
  if (mime !== "application/octet-stream") {
    // Known image / PDF → always binary for tool-result text purposes.
    // (Images may still ride as media blocks via Read; this flag only means
    // "do not put these bytes in the text content field".)
    return { binary: true, mime }
  }

  // Unrecognized: look for NULs in the head sample (classic is-binary check).
  const sample = bytes.subarray(0, Math.min(bytes.length, SAMPLE_BYTES))
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return { binary: true, mime: "application/octet-stream" }
  }

  // High density of C0 controls (excluding tab/lf/cr) → binary-ish.
  let controls = 0
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i]!
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) controls++
  }
  if (sample.length >= MIN_RATIO_SAMPLE && controls / sample.length >= CONTROL_RATIO_THRESHOLD) {
    return { binary: true, mime: "application/octet-stream" }
  }

  return { binary: false, mime: "text/plain" }
}

/**
 * Classify an already-decoded UTF-8 string. Used as the core safety net on
 * tool results that only expose `content: string` (plugin tools, Bash, …).
 *
 * Detects:
 *   - PDF / common image magic that survives UTF-8 decode
 *   - embedded NULs
 *   - high ratio of U+FFFD replacement chars (typical of binary forced through UTF-8)
 *   - high ratio of C0 controls
 */
export function classifyBinaryText(text: string): {
  binary: boolean
  mime: string
} {
  if (text.length === 0) return { binary: false, mime: "text/plain" }

  // Fast magic checks on the decoded string (ASCII-compatible headers).
  if (text.startsWith("%PDF-")) return { binary: true, mime: "application/pdf" }
  if (text.startsWith("GIF87a") || text.startsWith("GIF89a")) {
    return { binary: true, mime: "image/gif" }
  }
  // PNG: 0x89 'P' 'N' 'G' — after UTF-8 decode the lead byte often becomes U+FFFD
  // or stays as a high char; also accept the Latin-1 form.
  if (
    text.length >= 4 &&
    (text.startsWith("\u00c2\u00afPNG") || // mis-decoded
      text.startsWith("\uFFFDPNG") ||
      text.startsWith("\x89PNG") ||
      (text.charCodeAt(0) === 0x89 && text.startsWith("PNG", 1)))
  ) {
    return { binary: true, mime: "image/png" }
  }
  // JPEG SOI
  if (text.length >= 3 && text.charCodeAt(0) === 0xff && text.charCodeAt(1) === 0xd8) {
    return { binary: true, mime: "image/jpeg" }
  }
  // ZIP / Office / jar
  if (text.startsWith("PK\u0003\u0004") || text.startsWith("PK\x03\x04")) {
    return { binary: true, mime: "application/zip" }
  }
  // WebP
  if (text.startsWith("RIFF") && text.length >= 12 && text.slice(8, 12) === "WEBP") {
    return { binary: true, mime: "image/webp" }
  }

  // Prefer byte-level sniff when the string is pure Latin-1-ish (code units < 256).
  // Re-encoding as latin1 recovers original bytes for the common "binary forced
  // through a TextDecoder" case without U+FFFD.
  if (isLatin1(text)) {
    const bytes = latin1ToBytes(text)
    return classifyBinaryBytes(bytes)
  }

  const sample = text.slice(0, SAMPLE_BYTES)
  let nuls = 0
  let replacements = 0
  let controls = 0
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i)
    if (c === 0) nuls++
    else if (c === 0xfffd) replacements++
    else if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) controls++
  }
  if (nuls > 0) return { binary: true, mime: "application/octet-stream" }
  if (sample.length >= MIN_RATIO_SAMPLE) {
    const bad = (replacements + controls) / sample.length
    if (bad >= CONTROL_RATIO_THRESHOLD) {
      return { binary: true, mime: "application/octet-stream" }
    }
  }

  return { binary: false, mime: "text/plain" }
}

function isLatin1(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) return false
  }
  return true
}

function latin1ToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/**
 * Arguments for {@link formatBinaryResultMessage}.
 */
export interface BinaryResultMessageOpts {
  mime: string
  sizeBytes: number
  /** Absolute path where the full bytes were saved, when available. */
  path?: string
  /** Short sha256 (or full) of the body, when available. */
  sha256?: string
  /** Tool name for the annotation. */
  tool?: string
  /**
   * True when the caller already set `binary: true` but we still cannot
   * inline the body (e.g. too large for base64 under the output cap).
   */
  optedInButWithheld?: boolean
}

/**
 * Build the model-facing replacement for a withheld binary body.
 *
 * Shape (stable, greppable):
 *
 * ```
 * <ma::agent::binary-result mime="application/pdf" size="4.97MB" path="…" sha256="…" tool="Fetch" />
 *
 * Binary body withheld from model context …
 * ```
 */
export function formatBinaryResultMessage(opts: BinaryResultMessageOpts): string {
  const attrs: string[] = [
    `mime="${escapeAttr(opts.mime)}"`,
    `size="${escapeAttr(formatBlobBytes(opts.sizeBytes))}"`,
  ]
  if (opts.path) attrs.push(`path="${escapeAttr(opts.path)}"`)
  if (opts.sha256) attrs.push(`sha256="${escapeAttr(opts.sha256)}"`)
  if (opts.tool) attrs.push(`tool="${escapeAttr(opts.tool)}"`)

  const tag = `<ma::agent::binary-result ${attrs.join(" ")} />`

  const prose = opts.optedInButWithheld
    ? "Binary body is too large to inline as base64 under the tool-output budget. Use the path above (Read it, or ask the user to attach the file to their message)."
    : `Binary body withheld from model context (not valid text; dumping it wastes tokens).${
        opts.path ? " Full bytes saved at the path above." : ""
      } Re-call with binary=true for base64 when small enough, Read the saved path, or ask the user to attach the file.`

  return `${tag}\n\n${prose}`
}

/**
 * Max raw byte size we will base64-inline when `binary: true`.
 * Base64 expands ~4/3, so 48 KiB raw ≈ 64 KiB encoded — under the universal
 * tool-output clamp with room for the annotation footer.
 */
export const MAX_INLINE_BINARY_BYTES = 48 * 1024

/**
 * Format an opted-in binary body as base64 for the model, or a withhold
 * message when over {@link MAX_INLINE_BINARY_BYTES}.
 */
export function formatBinaryOptInContent(opts: {
  bytes: Uint8Array
  mime: string
  path?: string
  sha256?: string
  tool?: string
}): string {
  if (opts.bytes.length > MAX_INLINE_BINARY_BYTES) {
    return formatBinaryResultMessage({
      mime: opts.mime,
      sizeBytes: opts.bytes.length,
      path: opts.path,
      sha256: opts.sha256,
      tool: opts.tool,
      optedInButWithheld: true,
    })
  }
  const b64 = Buffer.from(opts.bytes).toString("base64")
  const attrs: string[] = [
    `mime="${escapeAttr(opts.mime)}"`,
    `size="${escapeAttr(formatBlobBytes(opts.bytes.length))}"`,
    `encoding="base64"`,
  ]
  if (opts.path) attrs.push(`path="${escapeAttr(opts.path)}"`)
  if (opts.sha256) attrs.push(`sha256="${escapeAttr(opts.sha256)}"`)
  if (opts.tool) attrs.push(`tool="${escapeAttr(opts.tool)}"`)
  return `<ma::agent::binary-result ${attrs.join(" ")}>\n${b64}\n</ma::agent::binary-result>`
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}
