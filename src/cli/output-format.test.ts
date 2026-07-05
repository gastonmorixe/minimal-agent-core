/**
 * Unit tests for the `--output-format` resolver (`src/cli/output-format.ts`).
 *
 * Pins the precedence contract: a valid `--output-format` value wins, then
 * `--json` (the alias), then `text` (default). Also covers the {@link
 * isOutputFormat} guard and the malformed-value fall-through.
 *
 * @module cli/output-format.test
 */

import { describe, expect, it } from "bun:test"

import {
  isOutputFormat,
  OUTPUT_FORMATS,
  type OutputFormat,
  resolveOutputFormat,
} from "./output-format.ts"

describe("isOutputFormat", () => {
  it("accepts the three valid formats", () => {
    expect(isOutputFormat("text")).toBe(true)
    expect(isOutputFormat("json")).toBe(true)
    expect(isOutputFormat("stream-json")).toBe(true)
  })

  it("rejects unknown / malformed / absent values", () => {
    expect(isOutputFormat("jsonl")).toBe(false)
    expect(isOutputFormat("streamjson")).toBe(false)
    expect(isOutputFormat("JSON")).toBe(false)
    expect(isOutputFormat("")).toBe(false)
    expect(isOutputFormat(undefined)).toBe(false)
  })

  it("exposes exactly the three formats in OUTPUT_FORMATS", () => {
    expect([...OUTPUT_FORMATS]).toEqual(["text", "json", "stream-json"])
  })
})

describe("resolveOutputFormat", () => {
  it("defaults to text when nothing is set", () => {
    expect(resolveOutputFormat({ outputFormatFlag: undefined, jsonFlag: false })).toBe("text")
  })

  it("maps --json to json when --output-format is absent", () => {
    expect(resolveOutputFormat({ outputFormatFlag: undefined, jsonFlag: true })).toBe("json")
  })

  it("resolves each explicit --output-format value", () => {
    expect(resolveOutputFormat({ outputFormatFlag: "text", jsonFlag: false })).toBe("text")
    expect(resolveOutputFormat({ outputFormatFlag: "json", jsonFlag: false })).toBe("json")
    expect(resolveOutputFormat({ outputFormatFlag: "stream-json", jsonFlag: false })).toBe(
      "stream-json",
    )
  })

  it("lets a valid --output-format win over --json (precedence)", () => {
    // --output-format text --json → text (explicit format beats the alias)
    expect(resolveOutputFormat({ outputFormatFlag: "text", jsonFlag: true })).toBe("text")
    // --output-format stream-json --json → stream-json
    expect(resolveOutputFormat({ outputFormatFlag: "stream-json", jsonFlag: true })).toBe(
      "stream-json",
    )
    // --output-format json --json → json (agree, no conflict)
    expect(resolveOutputFormat({ outputFormatFlag: "json", jsonFlag: true })).toBe("json")
  })

  it("falls through to --json when --output-format value is malformed", () => {
    expect(resolveOutputFormat({ outputFormatFlag: "nonsense", jsonFlag: true })).toBe("json")
  })

  it("falls through to text when --output-format value is malformed and no --json", () => {
    expect(resolveOutputFormat({ outputFormatFlag: "nonsense", jsonFlag: false })).toBe("text")
  })

  it("returns a value assignable to OutputFormat", () => {
    const fmt: OutputFormat = resolveOutputFormat({ outputFormatFlag: "json", jsonFlag: false })
    expect(OUTPUT_FORMATS).toContain(fmt)
  })
})
