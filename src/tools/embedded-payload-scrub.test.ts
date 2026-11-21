import { describe, expect, test } from "bun:test"

import { NO_SIDEBAND } from "../sideband/api.ts"
import { fixtureSidebandOrNone } from "../test-utils/sideband-fixture.ts"

import {
  containsScrubbableDataUri,
  DEFAULT_MIN_BASE64_CHARS,
  formatRedactedAssetStub,
  formatSanitizerFooter,
  scrubEmbeddedPayloads,
} from "./embedded-payload-scrub.ts"

/** The real codec (sibling checkout), else none. */
const SB = fixtureSidebandOrNone()

/** Build a synthetic data-URI of at least `minChars` base64 payload. */
function dataUri(mime: string, minChars: number): string {
  // 'A' is valid base64; pad to length.
  const payload = "A".repeat(Math.max(minChars, 4))
  return `data:${mime};base64,${payload}`
}

describe("scrubEmbeddedPayloads", () => {
  test("empty / no data: is a no-op", () => {
    expect(scrubEmbeddedPayloads(SB, "").changed).toBe(false)
    expect(scrubEmbeddedPayloads(SB, "# hello\n\nplain text").changed).toBe(false)
    expect(scrubEmbeddedPayloads(SB, "# hello\n\nplain text").text).toBe("# hello\n\nplain text")
  })

  test("disabled opt-out leaves text alone", () => {
    const uri = dataUri("image/png", 1000)
    const body = `logo: ${uri}`
    const r = scrubEmbeddedPayloads(SB, body, { disabled: true })
    expect(r.changed).toBe(false)
    expect(r.text).toBe(body)
  })

  test("tiny data-URI under threshold is kept", () => {
    // 40 chars << DEFAULT_MIN_BASE64_CHARS (256)
    const tiny = "data:image/png;base64," + "A".repeat(40)
    const body = `![x](${tiny})`
    const r = scrubEmbeddedPayloads(SB, body)
    expect(r.changed).toBe(false)
    expect(r.text).toContain(tiny)
  })

  test("oversized data-URI is replaced with redacted-asset stub", () => {
    const uri = dataUri("image/png", 500)
    const body = `Before\n\n![logo](${uri})\n\nAfter`
    const r = scrubEmbeddedPayloads(SB, body, { tool: "Fetch" })
    expect(r.changed).toBe(true)
    expect(r.redactions).toHaveLength(1)
    expect(r.redactions[0]!.mime).toBe("image/png")
    expect(r.redactions[0]!.base64Chars).toBe(500)
    expect(r.charsRemoved).toBe(500)
    // Original base64 gone.
    expect(r.text).not.toContain("AAAA")
    expect(r.text).not.toContain(";base64,")
    // Stub present.
    expect(r.text).toContain("<ma::agent::redacted-asset")
    expect(r.text).toContain('kind="data_uri"')
    expect(r.text).toContain('mime="image/png"')
    expect(r.text).toContain('tool="Fetch"')
    // Surrounding prose preserved.
    expect(r.text).toContain("Before")
    expect(r.text).toContain("After")
    // Aggregate footer.
    expect(r.text).toContain("<ma::agent::context-sanitizer")
    expect(r.text).toContain('removed="1"')
  })

  test("multiple data-URIs are all scrubbed", () => {
    const a = dataUri("image/png", 300)
    const b = dataUri("image/jpeg", 400)
    const body = `one ${a} two ${b}`
    const r = scrubEmbeddedPayloads(SB, body)
    expect(r.changed).toBe(true)
    expect(r.redactions).toHaveLength(2)
    expect(r.redactions[0]!.mime).toBe("image/png")
    expect(r.redactions[1]!.mime).toBe("image/jpeg")
    expect(r.text).toContain('removed="2"')
    expect(r.text.match(/<ma::agent::redacted-asset/g)?.length).toBe(2)
  })

  test("stops at newline (does not swallow following prose)", () => {
    // "after" is entirely base64-alphabet; a newline-tolerant payload would eat it.
    const uri = "data:image/png;base64," + "A".repeat(300)
    const r = scrubEmbeddedPayloads(SB, `before\n${uri}\nafter`)
    expect(r.changed).toBe(true)
    expect(r.redactions[0]!.base64Chars).toBe(300)
    expect(r.text).toContain("after")
    expect(r.text).toContain("before")
  })

  test("stops before markdown closing paren", () => {
    const uri = "data:image/png;base64," + "A".repeat(300)
    const r = scrubEmbeddedPayloads(SB, `![alt](${uri}) trailing`)
    expect(r.changed).toBe(true)
    expect(r.text).toContain("trailing")
    expect(r.text).toContain("![alt](")
  })

  test("charset param before base64 still matches", () => {
    const payload = "A".repeat(300)
    const uri = `data:image/svg+xml;charset=utf-8;base64,${payload}`
    const r = scrubEmbeddedPayloads(SB, uri)
    expect(r.changed).toBe(true)
    expect(r.redactions[0]!.mime).toBe("image/svg+xml")
  })

  test("minBase64Chars: 0 scrubs even tiny URIs", () => {
    const tiny = "data:image/gif;base64,AAAA"
    const r = scrubEmbeddedPayloads(SB, tiny, { minBase64Chars: 0 })
    expect(r.changed).toBe(true)
  })

  test("idempotent: scrubbing twice does not stack footers or double-count", () => {
    const uri = dataUri("image/png", 500)
    const once = scrubEmbeddedPayloads(SB, `body ${uri}`, { tool: "Fetch" })
    expect(once.changed).toBe(true)
    const twice = scrubEmbeddedPayloads(SB, once.text, { tool: "Fetch" })
    // No remaining scrubbable URI → second pass is a no-op.
    expect(twice.changed).toBe(false)
    expect(twice.text).toBe(once.text)
    // Only one sanitizer footer.
    expect(once.text.match(/<ma::agent::context-sanitizer/g)?.length).toBe(1)
  })

  test("application/pdf data-URI is scrubbed", () => {
    const uri = dataUri("application/pdf", 400)
    const r = scrubEmbeddedPayloads(SB, uri)
    expect(r.changed).toBe(true)
    expect(r.redactions[0]!.mime).toBe("application/pdf")
  })

  test("DEFAULT_MIN_BASE64_CHARS is 256", () => {
    expect(DEFAULT_MIN_BASE64_CHARS).toBe(256)
  })
})

describe("containsScrubbableDataUri", () => {
  test("false for clean text", () => {
    expect(containsScrubbableDataUri("hello")).toBe(false)
  })

  test("true for oversized data-URI", () => {
    expect(containsScrubbableDataUri(dataUri("image/png", 500))).toBe(true)
  })

  test("false for tiny data-URI", () => {
    expect(containsScrubbableDataUri("data:image/png;base64," + "A".repeat(40))).toBe(false)
  })
})

describe("formatRedactedAssetStub", () => {
  test("includes required attrs", () => {
    const s = formatRedactedAssetStub(
      SB,
      { kind: "data_uri", mime: "image/png", base64Chars: 1000, approxBytes: 750 },
      "Fetch",
    )
    expect(s).toContain("<ma::agent::redacted-asset")
    expect(s).toContain('kind="data_uri"')
    expect(s).toContain('mime="image/png"')
    expect(s).toContain('tool="Fetch"')
    expect(s).toContain("chars_removed=")
  })
})

describe("scrub with NO_SIDEBAND (design step 7)", () => {
  test("no codec: the URI stays, no stub, no footer, no separator", () => {
    const body = `x ${dataUri("image/png", 500)} y`
    const r = scrubEmbeddedPayloads(NO_SIDEBAND, body, { tool: "Fetch" })
    expect(r).toEqual({ text: body, changed: false, redactions: [], charsRemoved: 0 })
  })
  test("no codec: the stub and the footer builders give an empty text", () => {
    const rec = { kind: "data_uri" as const, mime: "image/png", base64Chars: 4, approxBytes: 3 }
    expect(formatRedactedAssetStub(NO_SIDEBAND, rec, "Fetch")).toBe("")
    expect(formatSanitizerFooter(NO_SIDEBAND, [rec], 4)).toBe("")
  })
})
