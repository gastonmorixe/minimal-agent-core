/**
 * Tests for `signature-model.ts` — extracting the model id from real
 * Anthropic thinking-block signatures.
 *
 * The fixtures are real captures from session cc53c9fe (a fork chain
 * that switched models mid-conversation, the exact case this fix is
 * for). They are TRIMMED to the first 100 bytes — the model_id field
 * always lives near the top of the protobuf payload — so the test file
 * stays under git review-friendly size.
 *
 * @module llm/providers/anthropic/signature-model.test
 */

import { describe, expect, test } from "bun:test"

import { extractModelFromSignature, looksLikeAnthropicModelId } from "./signature-model.ts"

// ---------------------------------------------------------------------------
// Real captures from cc53c9fe-7f91-45cd-91c4-6f3ddc74e20b.jsonl
// Each is the first ~250 chars of the base64 signature, which is more
// than enough to contain field 6 (model_id) since it appears at the start.
// ---------------------------------------------------------------------------

const SIG_OPUS_4_7 =
  "EpUCCmMIDhgCKkAQrL0+hYeX1InhE2rPG/evDayIGjau7OuNGrVEhuuiHcjsNUMYeem+GdGa4uQZ0CSkPrBTu8RJV+0raNJqsAnnMg9jbGF1ZGUtb3B1cy00LTc4AEIIdGhpbmtpbmcSDG1OckwAeikdLQCZEBoMDqfO3jopjAX7TWK9IjCw9AXe8/qt/3o2D1cwTAA1KhBgQ9CHLqnxc2dc2DgVBaSuqU68CGodJjuTDNQ+Q9AqYDmahuPBysrWI+MW+edm+yueb3OO5LhhBJ0JXtoEezP0Fmz5NCdNL1mqh9XE0AxQLbztg6bc4GIAq9dCir4xqQaYIQMO86wzNY9WJQzHSLjv+CVsvLziTsDf/YmakkAUxRgB"

const SIG_OPUS_4_8 =
  "EsoCCmMIDhgCKkCg3zHIYqE7PGjs0sXXx0WnzdaGrK9KWQcvg/dzaVhCgroOSFq6QoCXzfQkMTEd3BxKdjROwTr5RnEGjKfYTB9gMg9jbGF1ZGUtb3B1cy00LTg4AEIIdGhpbmtpbmcSDNDCE09b7dmEAIiL/xoMqTv4VdY27mgG2KJcIjDE834tb7K5j8hvYKEFhOMg2CK7owhNniW31Txp4TjDB/SK2gNlrvOFJlBvBVRYoqoqlAF1lO2FGpXAprB2W8WJhC2SnqNWg9Au7EVTJ8oWwxXt4eq1JQzUNt9AcEwq700UpU2WU5QOR2m7L3ISarGx1Z1rmQmLsy9NRPg5U0foLr8DQYJt4Ad5ZkQ/wTMN7zc9o+597T0GOR6VfyAoliGgx5jQyWQthodz2qHvmAODtClEr8SWU0D8ui4CMgeTdVCSTUg8BgaFGAE="

describe("extractModelFromSignature", () => {
  test("returns null for null/undefined/empty", () => {
    expect(extractModelFromSignature(null)).toBeNull()
    expect(extractModelFromSignature(undefined)).toBeNull()
    expect(extractModelFromSignature("")).toBeNull()
  })

  test("returns null for non-base64 input", () => {
    expect(extractModelFromSignature("not!valid!base64!@#$%^&*()_")).toBeNull()
  })

  test("returns null for valid base64 that lacks the model_id tag", () => {
    // "hello world" base64 → no protobuf structure at all
    expect(extractModelFromSignature(Buffer.from("hello world").toString("base64"))).toBeNull()
  })

  test("extracts claude-opus-4-7 from a real signature", () => {
    expect(extractModelFromSignature(SIG_OPUS_4_7)).toBe("claude-opus-4-7")
  })

  test("extracts claude-opus-4-8 from a real signature", () => {
    expect(extractModelFromSignature(SIG_OPUS_4_8)).toBe("claude-opus-4-8")
  })

  test("synthetic claude-sonnet-4-6 (16-char model)", () => {
    // Build a minimal protobuf payload:
    //   tag=0x32 (field 6, wire type 2)
    //   length=16 (0x10)
    //   "claude-sonnet-4-6"
    // ↑ NB: the length includes only the model bytes, NOT the tag.
    const modelId = "claude-sonnet-4-6"
    const buf = Buffer.concat([Buffer.from([0x32, modelId.length]), Buffer.from(modelId, "utf8")])
    expect(extractModelFromSignature(buf.toString("base64"))).toBe(modelId)
  })

  test("synthetic model_id behind one preceding field", () => {
    // First field: field 1, wire type 0 (varint), value 0
    //   tag = (1 << 3) | 0 = 0x08
    //   varint value = 0
    // Then the model_id field.
    const modelId = "claude-opus-4-9"
    const buf = Buffer.concat([
      Buffer.from([0x08, 0x00]),
      Buffer.from([0x32, modelId.length]),
      Buffer.from(modelId, "utf8"),
    ])
    expect(extractModelFromSignature(buf.toString("base64"))).toBe(modelId)
  })

  test("rejects a fake 0x32 hit whose payload isn't an Anthropic model id", () => {
    // 0x32 0x05 "hello"  — not a claude- string, so we should keep scanning
    // and return null when no real model id is found.
    const buf = Buffer.from([0x32, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])
    expect(extractModelFromSignature(buf.toString("base64"))).toBeNull()
  })

  test("truncated length prefix returns null", () => {
    // 0x32 then EOF — length byte missing.
    const buf = Buffer.from([0x32])
    expect(extractModelFromSignature(buf.toString("base64"))).toBeNull()
  })

  test("length prefix that runs past EOF returns null", () => {
    // 0x32 0x0F "claude" (length says 15, only 6 follow)
    const buf = Buffer.from([0x32, 0x0f, 0x63, 0x6c, 0x61, 0x75, 0x64, 0x65])
    expect(extractModelFromSignature(buf.toString("base64"))).toBeNull()
  })
})

describe("looksLikeAnthropicModelId", () => {
  test("accepts canonical ids", () => {
    expect(looksLikeAnthropicModelId("claude-opus-4-7")).toBe(true)
    expect(looksLikeAnthropicModelId("claude-opus-4-8")).toBe(true)
    expect(looksLikeAnthropicModelId("claude-sonnet-4-6")).toBe(true)
    expect(looksLikeAnthropicModelId("claude-haiku-4-5")).toBe(true)
  })

  test("accepts model with date suffix", () => {
    expect(looksLikeAnthropicModelId("claude-opus-4-5-20251015")).toBe(true)
  })

  test("rejects empty / no claude prefix / non-ascii", () => {
    expect(looksLikeAnthropicModelId("")).toBe(false)
    expect(looksLikeAnthropicModelId("opus-4-7")).toBe(false)
    expect(looksLikeAnthropicModelId("claude_opus_4_7")).toBe(false) // underscore not allowed
    expect(looksLikeAnthropicModelId("claude-opus-4-7 ")).toBe(false) // trailing space
  })

  test("rejects overly long strings", () => {
    expect(looksLikeAnthropicModelId(`claude-${"a".repeat(65)}`)).toBe(false)
  })
})
