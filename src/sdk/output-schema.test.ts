import { describe, expect, test } from "bun:test"

import { parseSchemaFile, validateAgainstSchema } from "./output-schema.ts"

describe("validateAgainstSchema — type", () => {
  test("accepts a matching primitive type", () => {
    expect(validateAgainstSchema("hi", { type: "string" })).toEqual({ valid: true, errors: [] })
    expect(validateAgainstSchema(42, { type: "number" }).valid).toBe(true)
    expect(validateAgainstSchema(true, { type: "boolean" }).valid).toBe(true)
    expect(validateAgainstSchema(null, { type: "null" }).valid).toBe(true)
    expect(validateAgainstSchema([], { type: "array" }).valid).toBe(true)
    expect(validateAgainstSchema({}, { type: "object" }).valid).toBe(true)
  })

  test("rejects a mismatched type with a descriptive message", () => {
    const r = validateAgainstSchema("not a number", { type: "number" })
    expect(r.valid).toBe(false)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain("expected type number")
    expect(r.errors[0]).toContain("got string")
  })

  test("integer is a number with no fractional part; number is not integer", () => {
    expect(validateAgainstSchema(3, { type: "integer" }).valid).toBe(true)
    expect(validateAgainstSchema(3.5, { type: "integer" }).valid).toBe(false)
    // a number schema accepts both integral and fractional
    expect(validateAgainstSchema(3, { type: "number" }).valid).toBe(true)
    expect(validateAgainstSchema(3.5, { type: "number" }).valid).toBe(true)
  })

  test("array of types matches if any member matches", () => {
    const schema = { type: ["string", "null"] }
    expect(validateAgainstSchema("x", schema).valid).toBe(true)
    expect(validateAgainstSchema(null, schema).valid).toBe(true)
    expect(validateAgainstSchema(5, schema).valid).toBe(false)
  })

  test("an array is NOT an object (type discrimination)", () => {
    expect(validateAgainstSchema([], { type: "object" }).valid).toBe(false)
    expect(validateAgainstSchema({}, { type: "array" }).valid).toBe(false)
  })
})

describe("validateAgainstSchema — required + properties", () => {
  const schema = {
    type: "object",
    required: ["name", "age"],
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
    },
  }

  test("accepts a fully valid object", () => {
    expect(validateAgainstSchema({ name: "Betty", age: 3 }, schema)).toEqual({
      valid: true,
      errors: [],
    })
  })

  test("reports each missing required property", () => {
    const r = validateAgainstSchema({}, schema)
    expect(r.valid).toBe(false)
    expect(r.errors).toHaveLength(2)
    expect(r.errors.some((e) => e.includes('missing required property "name"'))).toBe(true)
    expect(r.errors.some((e) => e.includes('missing required property "age"'))).toBe(true)
  })

  test("reports a property whose value is the wrong type, with a path", () => {
    const r = validateAgainstSchema({ name: "Betty", age: "old" }, schema)
    expect(r.valid).toBe(false)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain("/age")
    expect(r.errors[0]).toContain("expected type integer")
  })

  test("a present-but-not-required property is still type-checked", () => {
    const s = { type: "object", properties: { tag: { type: "string" } } }
    expect(validateAgainstSchema({ tag: 5 }, s).valid).toBe(false)
    expect(validateAgainstSchema({}, s).valid).toBe(true) // absent → no check
  })
})

describe("validateAgainstSchema — nesting, items, additionalProperties, enum", () => {
  test("validates nested objects and reports a deep path", () => {
    const schema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer" } },
        },
      },
    }
    const r = validateAgainstSchema({ user: { id: "nope" } }, schema)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toContain("/user/id")
  })

  test("applies items elementwise and reports the offending index", () => {
    const schema = { type: "array", items: { type: "integer" } }
    expect(validateAgainstSchema([1, 2, 3], schema).valid).toBe(true)
    const r = validateAgainstSchema([1, "two", 3], schema)
    expect(r.valid).toBe(false)
    expect(r.errors).toHaveLength(1)
    expect(r.errors[0]).toContain("/1")
  })

  test("additionalProperties:false rejects unlisted keys", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    }
    expect(validateAgainstSchema({ a: "x" }, schema).valid).toBe(true)
    const r = validateAgainstSchema({ a: "x", b: 1 }, schema)
    expect(r.valid).toBe(false)
    expect(r.errors[0]).toContain('additional property "b"')
  })

  test("enum matches by deep equality", () => {
    const schema = { enum: ["red", "green", { k: 1 }] }
    expect(validateAgainstSchema("green", schema).valid).toBe(true)
    expect(validateAgainstSchema({ k: 1 }, schema).valid).toBe(true)
    expect(validateAgainstSchema("blue", schema).valid).toBe(false)
    expect(validateAgainstSchema({ k: 2 }, schema).valid).toBe(false)
  })

  test("collects multiple independent failures in one pass", () => {
    const schema = {
      type: "object",
      required: ["a"],
      properties: { b: { type: "string" }, c: { type: "integer" } },
    }
    const r = validateAgainstSchema({ b: 1, c: 2.5 }, schema)
    expect(r.valid).toBe(false)
    // missing a, wrong b, wrong c
    expect(r.errors).toHaveLength(3)
  })
})

describe("validateAgainstSchema — unsupported keywords are ignored, never false-fail", () => {
  test("an unsupported keyword (pattern/minimum) does not reject a structurally valid value", () => {
    const schema = { type: "string", pattern: "^x", minLength: 100 }
    // pattern/minLength are ignored; only `type` is enforced
    expect(validateAgainstSchema("short", schema).valid).toBe(true)
  })

  test("anyOf is ignored (under-constrains rather than wrongly failing)", () => {
    const schema = { anyOf: [{ type: "string" }, { type: "number" }] }
    expect(validateAgainstSchema(true, schema).valid).toBe(true)
  })
})

describe("parseSchemaFile", () => {
  test("parses a valid JSON object", () => {
    expect(parseSchemaFile('{"type":"object"}')).toEqual({ type: "object" })
  })

  test("throws a clean, prefixed error on malformed JSON", () => {
    expect(() => parseSchemaFile("{not json")).toThrow(/--output-schema is not valid JSON/)
  })

  test("throws when the JSON is valid but not an object", () => {
    expect(() => parseSchemaFile("42")).toThrow(/must be a JSON object, got integer/)
    expect(() => parseSchemaFile("[1,2]")).toThrow(/must be a JSON object, got array/)
    expect(() => parseSchemaFile("null")).toThrow(/must be a JSON object, got null/)
  })

  test("the parsed schema feeds straight into validateAgainstSchema", () => {
    const schema = parseSchemaFile('{"type":"object","required":["ok"]}')
    expect(validateAgainstSchema({ ok: true }, schema).valid).toBe(true)
    expect(validateAgainstSchema({}, schema).valid).toBe(false)
  })
})
