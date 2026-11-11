import { describe, expect, it } from "bun:test"

import { outputConfigSpread } from "../sdk/output-config.ts"

import { outputFormatName, sendOptionsToCanonical } from "./adapter-legacy.ts"
import type { SendOptions } from "./transport/types.ts"

const auth = { type: "api-key", token: "k" } as unknown as SendOptions["auth"]

function canonicalFormat(cfg: ReturnType<typeof outputConfigSpread>) {
  return sendOptionsToCanonical({ auth, model: "m", messages: [], ...cfg } as SendOptions)
    .outputFormat
}

describe("outputFormatName", () => {
  it("uses the schema title", () => {
    expect(outputFormatName({ title: "Person_v2-x" })).toBe("Person_v2-x")
  })

  it("falls back to output when the title is missing, not a string, or empty", () => {
    expect(outputFormatName({ type: "object" })).toBe("output")
    expect(outputFormatName({ title: 42 })).toBe("output")
    expect(outputFormatName({ title: "" })).toBe("output")
  })

  it("replaces chars outside [a-zA-Z0-9_-] with _", () => {
    expect(outputFormatName({ title: "My Schema.v1/é" })).toBe("My_Schema_v1__")
  })

  it("cuts the name to 64 chars", () => {
    const name = outputFormatName({ title: "a".repeat(100) })
    expect(name).toHaveLength(64)
    expect(name).toBe("a".repeat(64))
  })
})

describe("sendOptionsToCanonical purpose", () => {
  const base = { auth, model: "m", messages: [] } as SendOptions

  it("maps requestType title to purpose title", () => {
    expect(sendOptionsToCanonical({ ...base, requestType: "title" }).purpose).toBe("title")
  })

  it("sets no purpose for other request types", () => {
    expect(sendOptionsToCanonical({ ...base, requestType: "conversation" }).purpose).toBeUndefined()
    expect(sendOptionsToCanonical({ ...base, requestType: "quota" }).purpose).toBeUndefined()
    expect(sendOptionsToCanonical(base).purpose).toBeUndefined()
  })
})

describe("sendOptionsToCanonical outputFormat", () => {
  const schema = { title: "Answer", type: "object" }

  it("carries strict and the name to the canonical request", () => {
    expect(canonicalFormat(outputConfigSpread({ outputSchema: schema, strict: true }))).toEqual({
      type: "json_schema",
      schema,
      name: "Answer",
      strict: true,
    })
  })

  it("omits strict when off, and keeps the fallback name", () => {
    const plain = { type: "object" }
    expect(canonicalFormat(outputConfigSpread({ outputSchema: plain }))).toEqual({
      type: "json_schema",
      schema: plain,
      name: "output",
    })
  })

  it("sends no format when strict is asked without a schema", () => {
    expect(outputConfigSpread({ strict: true })).toEqual({})
    expect(canonicalFormat(outputConfigSpread({ strict: true }))).toBeUndefined()
  })
})
