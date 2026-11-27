/**
 * The `{base64}` wire form of plugin tool attachments (attachment-wire.ts)
 * and the JSON stdout form of a subprocess tool handler (subprocess-json.ts).
 */
import { describe, expect, it, spyOn } from "bun:test"

import type { ToolHandlerResult } from "../../../plugin-api/src/types/plugin.ts"
import { MAX_ATTACHMENT_BYTES } from "../../media/tool-attachment.ts"
import { parseHandlerEntry } from "../manifest-helpers.ts"

import {
  decodeWire,
  decodeWireAttachments,
  decodeWireEntry,
  isStrictBase64,
  MAX_ATTACHMENT_BASE64_CHARS,
  MAX_WIRE_ATTACHMENTS,
} from "./attachment-wire.ts"
import { parseJsonToolResult } from "./subprocess-json.ts"

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const PNG_B64 = Buffer.from(PNG).toString("base64")

function warnSink() {
  const warns: Array<{ id: string; data: unknown }> = []
  return {
    warns,
    d: { warn: (id: string, _m: string, data?: unknown) => warns.push({ id, data }) },
  }
}

describe("isStrictBase64", () => {
  it("accepts standard base64 with and without padding", () => {
    expect(isStrictBase64("QUJD")).toBe(true)
    expect(isStrictBase64("QUI=")).toBe(true)
    expect(isStrictBase64("QQ==")).toBe(true)
  })

  it("rejects whitespace, URL-safe chars, bad padding, a bad length and empty", () => {
    for (const s of [
      "QU JD",
      "QUJD\n",
      "QU-_",
      "Q===",
      "QU=D",
      "QUJ",
      "",
      "data:image/png;base64,QUJD",
    ]) {
      expect(isStrictBase64(s)).toBe(false)
    }
  })
})

describe("decodeWireEntry", () => {
  it("decodes the bytes and keeps mimeType and label", () => {
    const r = decodeWireEntry({ base64: PNG_B64, mimeType: "image/png", label: "shot" })
    expect(typeof r).toBe("object")
    const a = r as { bytes: Uint8Array; mimeType?: string; label?: string }
    expect(a.bytes).toBeInstanceOf(Uint8Array)
    expect([...a.bytes]).toEqual([...PNG])
    expect(a.mimeType).toBe("image/png")
    expect(a.label).toBe("shot")
  })

  it("drops a base64 that is not a string, or not valid", () => {
    expect(decodeWireEntry({ base64: 42 })).toBe("base64-not-string")
    expect(decodeWireEntry({ base64: "not base64!" })).toBe("base64-invalid")
  })

  it("rejects a too-long string BEFORE the decode", () => {
    const from = spyOn(Buffer, "from")
    const long = "A".repeat(MAX_ATTACHMENT_BASE64_CHARS + 4)
    try {
      expect(decodeWireEntry({ base64: long })).toBe("base64-too-long")
      expect(from).not.toHaveBeenCalled()
    } finally {
      from.mockRestore()
    }
  })

  it("the string cap is the base64 length of the byte cap", () => {
    expect(MAX_ATTACHMENT_BASE64_CHARS).toBe(4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3))
    expect(MAX_ATTACHMENT_BASE64_CHARS).toBe(44_739_244)
  })

  it("checks the decoded size against MAX_ATTACHMENT_BYTES", () => {
    // 44739244 chars with "==" decode to 33554431 bytes (under the cap). With
    // no padding they decode to 33554433 bytes, 1 over the cap.
    const over = "A".repeat(MAX_ATTACHMENT_BASE64_CHARS)
    expect(decodeWireEntry({ base64: over })).toBe("too-large")
  })
})

describe("decodeWireAttachments", () => {
  it("keeps the array length and order, and a dropped entry keeps its place", () => {
    const drops: Array<[number, string]> = []
    const out = decodeWireAttachments(
      [{ base64: "bad!" }, { base64: PNG_B64 }, { bytes: PNG }],
      (i, r) => drops.push([i, r]),
    )
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ base64: "" })
    expect((out[1] as { bytes: Uint8Array }).bytes).toBeInstanceOf(Uint8Array)
    expect((out[2] as { bytes: Uint8Array }).bytes).toBe(PNG)
    expect(drops).toEqual([[0, "base64-invalid"]])
  })

  it("drops the wire entries after the 8th", () => {
    const drops: number[] = []
    const list = Array.from({ length: MAX_WIRE_ATTACHMENTS + 2 }, () => ({ base64: PNG_B64 }))
    const out = decodeWireAttachments(list, (i) => drops.push(i))
    expect(out).toHaveLength(10)
    expect(drops).toEqual([8, 9])
  })

  it("gives the same array when it has no wire entry", () => {
    const list = [{ bytes: PNG }]
    expect(decodeWireAttachments(list, () => {})).toBe(list)
  })
})

describe("decodeWire", () => {
  it("warns tool-attachment.invalid with the index and reason, and does not fail the call", () => {
    const { warns, d } = warnSink()
    const r: ToolHandlerResult = {
      kind: "tool_result",
      content: "ok",
      attachments: [{ base64: "%%%%" }, { base64: PNG_B64 }],
    }
    const out = decodeWire(r, d, "p", "Shot")
    expect(out.kind).toBe("tool_result")
    if (out.kind !== "tool_result") throw new Error("kind")
    expect(out.is_error).toBeUndefined()
    expect(out.content).toBe("ok")
    expect(warns).toEqual([
      {
        id: "tool-attachment.invalid",
        data: { pluginId: "p", tool: "Shot", index: 0, reason: "base64-invalid" },
      },
    ])
  })

  it("leaves a result with no attachments, or a rendered result, as is", () => {
    const { d } = warnSink()
    const a: ToolHandlerResult = { kind: "tool_result", content: "x" }
    const b: ToolHandlerResult = { kind: "rendered", ansi: "y" }
    expect(decodeWire(a, d, "p", "T")).toBe(a)
    expect(decodeWire(b, d, "p", "T")).toBe(b)
  })
})

describe("parseJsonToolResult", () => {
  it("keeps the known fields with the correct type", () => {
    const out = JSON.stringify({
      kind: "tool_result",
      content: "c",
      display: "d",
      displayHeader: "h",
      displayFooter: 3,
      suppressToolTime: true,
      attachments: [{ base64: PNG_B64 }],
      other: 1,
    })
    expect(parseJsonToolResult(out, 0)).toEqual({
      kind: "tool_result",
      content: "c",
      is_error: false,
      display: "d",
      displayHeader: "h",
      suppressToolTime: true,
      attachments: [{ base64: PNG_B64 }],
    })
  })

  it("a non-zero exit or is_error: true sets is_error", () => {
    expect(parseJsonToolResult('{"content":"c"}', 1)?.is_error).toBe(true)
    expect(parseJsonToolResult('{"content":"c","is_error":true}', 0)?.is_error).toBe(true)
  })

  it("gives null for bad JSON, a non-object, no string content or another kind", () => {
    for (const s of [
      "not json",
      "[1]",
      "null",
      '{"content":1}',
      '{"kind":"rendered","content":"c"}',
    ]) {
      expect(parseJsonToolResult(s, 0)).toBeNull()
    }
  })
})

describe("manifest subprocess output", () => {
  it("accepts output text and json, and rejects other values", () => {
    const e = parseHandlerEntry({ type: "subprocess", command: ["x"], output: "json" }, "t", "m")
    expect(e).toEqual({ type: "subprocess", command: ["x"], output: "json" })
    const plain = parseHandlerEntry({ type: "subprocess", command: ["x"] }, "t", "m")
    expect(plain).toEqual({ type: "subprocess", command: ["x"] })
    expect(() =>
      parseHandlerEntry({ type: "subprocess", command: ["x"], output: "xml" }, "t", "m"),
    ).toThrow(/output must be/)
  })
})
