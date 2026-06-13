/**
 * Decode the model id embedded in an Anthropic thinking-block
 * `signature`.
 *
 * Anthropic's thinking-block signature is a base64-encoded protobuf
 * blob the server emits alongside every thinking block and that the
 * client MUST send back verbatim on subsequent requests so the server
 * can verify the conversation context wasn't tampered with.
 *
 * Inside the blob, field 6 carries the model id as a length-delimited
 * UTF-8 string (wire type 2). On wire, that's a 0x32 tag byte followed
 * by a varint length and the string bytes:
 *
 *     0x32 0x0F "claude-opus-4-7"
 *     0x32 0x0F "claude-opus-4-8"
 *     0x32 0x10 "claude-sonnet-4-6"
 *
 * (Verified against 22 live signatures from session cc53c9fe.)
 *
 * Why this matters: when a session is forked across model boundaries
 * (e.g. parent ran on claude-opus-4-7, child resumes on claude-opus-4-8),
 * the inherited thinking blocks carry signatures bound to the OLD model.
 * The new model rejects them with
 * `messages.<i>.content.<j>: thinking blocks in the latest assistant message cannot be modified`.
 * The
 * decoded model id lets us detect this BEFORE sending and offer the
 * user a clean recovery path (strip stale thinking vs switch back).
 *
 * This file is the smallest unit of the detection: pure protobuf
 * inspection, no Anthropic adapter wiring. Tested independently against
 * real signatures.
 *
 * @module llm/providers/anthropic/signature-model
 */

import { Buffer as NodeBuffer } from "node:buffer"

/**
 * Protobuf wire tag for field 6 (`model_id`), wire type 2
 * (length-delimited). `(6 << 3) | 2 = 0x32`.
 */
const FIELD_TAG_MODEL_ID = 0x32

/**
 * Extract the model id from an Anthropic thinking-block signature.
 *
 * Returns `null` if:
 *  - `sig` is empty or not valid base64
 *  - the protobuf tag for field 6 (`model_id`) isn't present
 *  - the length prefix is malformed
 *
 * Pure / synchronous. Safe to call on every thinking block in a
 * message history (microseconds per call).
 *
 * # Why a byte-scan instead of a structured protobuf walk
 *
 * The signature payload nests the model_id field 1–2 levels deep inside
 * an outer length-delimited envelope (observed: top-level field 2 wraps
 * a sub-message that contains field 6). A structured walk would have to
 * recurse into every length-delimited field at every level, doubling
 * the surface area for parser bugs without buying us anything: the
 * signature format is opaque and we only care about ONE field.
 *
 * Instead we scan the buffer for occurrences of the model_id tag
 * (`0x32`) followed by a sane length prefix and a string that
 * structurally matches an Anthropic model id (`claude-…`). The
 * structural check (see {@link looksLikeAnthropicModelId}) prevents
 * false positives from random 0x32 bytes inside other fields.
 *
 * @param sig - The signature string as stored on `ThinkingBlock.signature`.
 * @returns The model id (e.g. `"claude-opus-4-7"`) or `null` when not
 *   decodable.
 */
export function extractModelFromSignature(sig: string | undefined | null): string | null {
  if (!sig) return null
  let bytes: Buffer
  try {
    bytes = NodeBuffer.from(sig, "base64")
  } catch {
    return null
  }
  if (bytes.length === 0) return null

  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== FIELD_TAG_MODEL_ID) continue
    // Try to parse a length-delimited string starting at i+1. Length
    // prefix is a varint, but Anthropic model ids fit in 1 length byte
    // (≤ 127 chars) so we only need to handle the 1-byte case.
    const lenByte = bytes[i + 1]
    if (lenByte === undefined || lenByte === 0 || lenByte > 0x7f) continue
    const strStart = i + 2
    const strEnd = strStart + lenByte
    if (strEnd > bytes.length) continue
    const candidate = bytes.subarray(strStart, strEnd).toString("utf8")
    if (looksLikeAnthropicModelId(candidate)) return candidate
  }
  return null
}

/**
 * Lightweight sanity check on a candidate model id decoded from a
 * signature. Real Anthropic ids match `/^claude-[a-z]+-\d+-\d+$/`
 * with optional `-YYYYMMDD` date suffix. We accept anything that
 * starts with `"claude-"` and is pure ASCII identifier chars to stay
 * forward-compatible with future shapes (e.g. `claude-mythos-preview-1`).
 *
 * Exported for use in {@link extractModelFromSignature} and tests.
 */
export function looksLikeAnthropicModelId(s: string): boolean {
  if (s.length === 0 || s.length > 64) return false
  if (!s.startsWith("claude-")) return false
  // Allow ascii letters, digits, '-'. Reject control chars and high bytes.
  return /^[a-zA-Z0-9-]+$/.test(s)
}
