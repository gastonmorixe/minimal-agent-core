import { describe, expect, test } from "bun:test"

import { NO_SIDEBAND } from "../sideband/api.ts"
import { fixtureSidebandOrNone } from "../test-utils/sideband-fixture.ts"
import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import {
  BINARY_OPT_IN_ARG,
  classifyBinaryBytes,
  classifyBinaryText,
  formatBinaryOptInContent,
  formatBinaryResultMessage,
  injectBinaryOptInArg,
  isBinaryOptIn,
  MAX_INLINE_BINARY_BYTES,
} from "./binary-guard.ts"

/** The real codec (sibling checkout), else none. */
const SB = fixtureSidebandOrNone()

describe("classifyBinaryBytes", () => {
  test("empty is text", () => {
    expect(classifyBinaryBytes(new Uint8Array()).binary).toBe(false)
  })

  test("PDF magic", () => {
    const b = new TextEncoder().encode("%PDF-1.6\n%âãÏÓ\n")
    const r = classifyBinaryBytes(b)
    expect(r.binary).toBe(true)
    expect(r.mime).toBe("application/pdf")
  })

  test("PNG magic", () => {
    const b = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const r = classifyBinaryBytes(b)
    expect(r.binary).toBe(true)
    expect(r.mime).toBe("image/png")
  })

  test("plain UTF-8 text is not binary", () => {
    const b = new TextEncoder().encode("# Hello\n\nSome markdown body.\n")
    expect(classifyBinaryBytes(b).binary).toBe(false)
  })

  test("NUL-containing buffer is binary", () => {
    const b = new Uint8Array([0x68, 0x69, 0x00, 0x21]) // hi\0!
    expect(classifyBinaryBytes(b).binary).toBe(true)
  })
})

describe("classifyBinaryText", () => {
  test("PDF header as string", () => {
    const r = classifyBinaryText("%PDF-1.6\nstream\n...")
    expect(r.binary).toBe(true)
    expect(r.mime).toBe("application/pdf")
  })

  test("normal markdown is not binary", () => {
    expect(classifyBinaryText("# Title\n\nparagraph\n").binary).toBe(false)
  })

  test("high U+FFFD ratio is binary", () => {
    const s = "\uFFFD".repeat(100) + "x".repeat(20)
    expect(classifyBinaryText(s).binary).toBe(true)
  })

  test("embedded NUL is binary", () => {
    expect(classifyBinaryText("abc\u0000def").binary).toBe(true)
  })
})

describe("isBinaryOptIn / injectBinaryOptInArg", () => {
  test("only boolean true counts", () => {
    expect(isBinaryOptIn({ binary: true })).toBe(true)
    expect(isBinaryOptIn({ binary: false })).toBe(false)
    expect(isBinaryOptIn({ binary: "true" })).toBe(false)
    expect(isBinaryOptIn({})).toBe(false)
    expect(isBinaryOptIn(undefined)).toBe(false)
  })

  test("injects binary property when missing", () => {
    const schema = {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    }
    const out = injectBinaryOptInArg(schema)
    const props = out.properties as Record<string, unknown>
    expect(props.url).toEqual({ type: "string" })
    expect(props[BINARY_OPT_IN_ARG]).toMatchObject({ type: "boolean", default: false })
    // original untouched
    expect((schema.properties as Record<string, unknown>).binary).toBeUndefined()
  })

  test("does not overwrite existing binary property", () => {
    const schema = {
      type: "object",
      properties: {
        binary: { type: "boolean", description: "plugin-owned" },
      },
    }
    const out = injectBinaryOptInArg(schema)
    expect(out).toBe(schema)
    expect((out.properties as Record<string, unknown>).binary).toEqual({
      type: "boolean",
      description: "plugin-owned",
    })
  })
})

const fx = () => (textFixturesPresent() ? fixtureSyntheticTextResolver() : undefined)
const needFx = !textFixturesPresent()

describe("formatBinaryResultMessage", () => {
  test("bare core: the tag alone (no provider)", () => {
    const msg = formatBinaryResultMessage(SB, { mime: "application/pdf", sizeBytes: 10 })
    expect(msg).toBe('<ma::agent::binary-result mime="application/pdf" size="10B" />')
  })

  test.skipIf(needFx)("emits ma::agent::binary-result tag with attrs", () => {
    const msg = formatBinaryResultMessage(SB, {
      mime: "application/pdf",
      sizeBytes: 5_200_000,
      path: "/tmp/x.bin",
      sha256: "deadbeef",
      tool: "Fetch",
      text: fx(),
    })
    expect(msg).toContain('<ma::agent::binary-result mime="application/pdf"')
    expect(msg).toContain('path="/tmp/x.bin"')
    expect(msg).toContain('sha256="deadbeef"')
    expect(msg).toContain('tool="Fetch"')
    expect(msg).toContain("The harness did not put the binary body in the model context")
    expect(msg).not.toContain("%PDF")
  })
})

describe("formatBinaryOptInContent", () => {
  test("inlines base64 under the cap", () => {
    const bytes = new TextEncoder().encode("%PDF-1.4 small")
    const msg = formatBinaryOptInContent(SB, {
      bytes,
      mime: "application/pdf",
      tool: "Fetch",
    })
    expect(msg).toContain('encoding="base64"')
    expect(msg).toContain(Buffer.from(bytes).toString("base64"))
  })

  test.skipIf(needFx)("withholds when over the inline cap", () => {
    const bytes = new Uint8Array(MAX_INLINE_BINARY_BYTES + 1)
    bytes[0] = 0x25 // %
    const msg = formatBinaryOptInContent(SB, {
      bytes,
      mime: "application/octet-stream",
      path: "/tmp/big.bin",
      text: fx(),
    })
    expect(msg).toContain("too large to include as base64")
    expect(msg).toContain('path="/tmp/big.bin"')
  })
})

describe("binary-result with NO_SIDEBAND (design step 7)", () => {
  test("withheld: no tag, the prose alone with no separator", () => {
    const text = { resolve: () => "PROSE" }
    expect(formatBinaryResultMessage(NO_SIDEBAND, { mime: "a/b", sizeBytes: 3, text })).toBe(
      "PROSE",
    )
    expect(formatBinaryResultMessage(NO_SIDEBAND, { mime: "a/b", sizeBytes: 3 })).toBe("")
  })
  test("opt-in base64: no tag gives an empty text", () => {
    expect(
      formatBinaryOptInContent(NO_SIDEBAND, { bytes: new Uint8Array([1, 2, 3]), mime: "a/b" }),
    ).toBe("")
  })
})
