import { describe, expect, test } from "bun:test"

import { isStructuredPrintFormat, parsePrintFormat } from "./print-format.ts"

describe("parsePrintFormat", () => {
  test("defaults and aliases map to text", () => {
    expect(parsePrintFormat(undefined)).toBe("text")
    expect(parsePrintFormat("")).toBe("text")
    expect(parsePrintFormat("tui")).toBe("text")
    expect(parsePrintFormat("console")).toBe("text")
    expect(parsePrintFormat("stdout")).toBe("text")
    expect(parsePrintFormat("nope")).toBe("text")
  })

  test("accepts structured formats", () => {
    expect(parsePrintFormat("json")).toBe("json")
    expect(parsePrintFormat("JSON")).toBe("json")
    expect(parsePrintFormat("md")).toBe("md")
    expect(parsePrintFormat("xml")).toBe("xml")
    expect(isStructuredPrintFormat("json")).toBe(true)
    expect(isStructuredPrintFormat("text")).toBe(false)
  })
})
