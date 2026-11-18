/**
 * 15e.1b: `tool_result.invalid_input` carries the schema errors as flat
 * indexed facts (`SyntheticFacts` is flat). Core holds no validator prose;
 * the text plugin rebuilds the words. Validity is the validator flag, never
 * the text (see tool-input-no-resolver.test.ts).
 */

import { describe, expect, it } from "bun:test"

import type { SyntheticFacts, SyntheticKind } from "../../plugin-api/src/types/synthetic-text.ts"
import { createSyntheticTextResolver } from "../agent/synthetic-text.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import { validateAgainstSchema } from "../sdk/output-schema.ts"
import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"

import { validateToolInput } from "./tool-input.ts"
import { invalidInputText, schemaErrorFacts } from "./tool-result-text.ts"

function recording(): {
  text: ReturnType<typeof createSyntheticTextResolver>
  calls: Array<{ kind: SyntheticKind; facts: SyntheticFacts }>
} {
  const calls: Array<{ kind: SyntheticKind; facts: SyntheticFacts }> = []
  const provider = {
    kinds: ["tool_result.invalid_input"] as const,
    text(kind: SyntheticKind, facts: SyntheticFacts): string {
      calls.push({ kind, facts })
      return "STUB"
    },
  }
  return {
    text: createSyntheticTextResolver([provider], createDiagnostics({ emit: () => {} })),
    calls,
  }
}

describe("schemaErrorFacts (flat indexed facts)", () => {
  it("encodes every rule with its own keys", () => {
    const schema = {
      type: "object",
      required: ["a"],
      properties: { b: { type: ["string", "null"] }, c: { enum: [1] } },
      additionalProperties: false,
    }
    const { errors } = validateAgainstSchema({ b: 5, c: 2, z: 0 }, schema)
    expect(schemaErrorFacts(errors)).toEqual({
      count: 4,
      "path.0": "",
      "rule.0": "required",
      "key.0": "a",
      "path.1": "/b",
      "rule.1": "type",
      "expected.1": "string,null",
      "got.1": "integer",
      "path.2": "/c",
      "rule.2": "enum",
      "path.3": "",
      "rule.3": "additional",
      "key.3": "z",
    })
  })

  it("every value is a flat primitive", () => {
    const { errors } = validateAgainstSchema({}, { required: ["x", "y"] })
    for (const v of Object.values(schemaErrorFacts(errors))) {
      expect(["string", "number"]).toContain(typeof v)
    }
  })
})

describe("validateToolInput asks the resolver with indexed facts", () => {
  it("Bash with a mistyped command", () => {
    const rec = recording()
    expect(validateToolInput("Bash", { command: 5 }, rec.text)).toBe("STUB")
    expect(rec.calls).toEqual([
      {
        kind: "tool_result.invalid_input",
        facts: {
          tool: "Bash",
          count: 1,
          "path.0": "/command",
          "rule.0": "type",
          "expected.0": "string",
          "got.0": "integer",
        },
      },
    ])
  })

  it("Read with a missing file_path", () => {
    const rec = recording()
    validateToolInput("Read", {}, rec.text)
    expect(rec.calls[0]?.facts).toEqual({
      tool: "Read",
      count: 1,
      "path.0": "",
      "rule.0": "required",
      "key.0": "file_path",
    })
  })
})

describe.skipIf(!textFixturesPresent())("the text plugin rebuilds the old bytes", () => {
  // bun runs a describe body at collection, even when skipIf skips the tests.
  // Resolve the text on the first call, inside a running test.
  let text: ReturnType<typeof fixtureSyntheticTextResolver> | undefined
  const say = (value: unknown, schema: object) => {
    text ??= fixtureSyntheticTextResolver()
    return invalidInputText(text, "T", validateAgainstSchema(value, schema).errors)
  }

  it("type, required, enum, additional, and the `. ` join", () => {
    expect(say(5, { type: "string" })).toBe("T error: (root): expected type string, got integer")
    expect(say(5, { type: ["string", "null"] })).toBe(
      "T error: (root): expected type string | null, got integer",
    )
    expect(say({}, { required: ["a", "b"] })).toBe(
      'T error: (root): missing required property "a". (root): missing required property "b"',
    )
    expect(say({ c: 2 }, { properties: { c: { enum: [1] } } })).toBe(
      "T error: /c: value does not match any enum constant",
    )
    expect(say({ z: 1 }, { additionalProperties: false })).toBe(
      'T error: (root): additional property "z" is not allowed',
    )
  })
})
