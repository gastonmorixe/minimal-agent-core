import { describe, expect, it } from "bun:test"

import { outputConfigSpread } from "./output-config.ts"

describe("outputConfigSpread", () => {
  const schema = { type: "object" }

  it("is empty with no effort and no schema", () => {
    expect(outputConfigSpread({})).toEqual({})
  })

  it("puts strict into the format when on and a schema is set", () => {
    expect(outputConfigSpread({ outputSchema: schema, strict: true })).toEqual({
      outputConfig: { format: { type: "json_schema", schema, strict: true } },
    })
  })

  it("leaves strict out when it is false or absent", () => {
    const want = { outputConfig: { format: { type: "json_schema", schema } } }
    expect(outputConfigSpread({ outputSchema: schema, strict: false })).toEqual(want)
    expect(outputConfigSpread({ outputSchema: schema })).toEqual(want)
  })

  it("ignores strict without a schema", () => {
    expect(outputConfigSpread({ effort: "high", strict: true })).toEqual({
      outputConfig: { effort: "high" },
    })
  })
})
