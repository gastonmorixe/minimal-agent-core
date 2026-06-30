/**
 * A small, dependency-free JSON Schema validator for `--output-schema`.
 *
 * `--output-schema FILE` lets a `--print`/`--json` caller constrain the
 * agent's final answer to a JSON shape. The host (index.ts) parses the file
 * and, after the run, checks the final answer against it: a mismatch is a
 * stderr diagnostic plus a non-zero exit. This module is the PURE functional
 * core of that check: no I/O, no host deps, no process exit. The imperative
 * shell (the exit-code wiring) lives in the host.
 *
 * SUPPORTED SUBSET (deliberately small — YAGNI over a full JSON Schema lib):
 *   - `type`: "object" | "array" | "string" | "number" | "integer" |
 *     "boolean" | "null", or an ARRAY of those (value matches if it matches
 *     any). `integer` means a number with no fractional part.
 *   - `properties`: per-key subschemas, validated recursively. Only checked
 *     when the value is an object.
 *   - `required`: array of keys that must be present (own enumerable) on an
 *     object value.
 *   - `additionalProperties: false`: reject object keys not named in
 *     `properties`. Any other value (true / a schema / absent) allows extras.
 *   - `items`: a single subschema applied to every element of an array value.
 *   - `enum`: the value must deep-equal one of the listed constants.
 *
 * EXPLICITLY NOT SUPPORTED (a schema using these is accepted structurally,
 * but the keyword is IGNORED — document the boundary for callers):
 *   anyOf/oneOf/allOf/not, $ref/$defs, pattern/format/minLength/maxLength,
 *   minimum/maximum, tuple-form `items` (array), patternProperties,
 *   dependencies, const (use a single-element enum). If `--output-schema`
 *   ever needs one of these, add it here behind a test — do not pull in ajv.
 *
 * @module sdk/output-schema
 */

/** A JSON Schema, as the parsed object the host threads in. */
export type JsonSchema = Record<string, unknown>

/** The structured outcome of {@link validateAgainstSchema}. */
export interface ValidationResult {
  /** True iff `value` satisfies the supported keywords of `schema`. */
  valid: boolean
  /**
   * One human-readable message per failure, each prefixed with the JSON
   * Pointer-ish path to the offending location (`""` is the root, `/items/0`
   * a nested spot). Empty iff `valid`.
   */
  errors: string[]
}

const PRIMITIVE_TYPES = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
])

/** The JSON type name this validator assigns to a runtime value. */
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  const t = typeof value
  if (t === "number") return Number.isInteger(value) ? "integer" : "number"
  return t // "string" | "boolean" | "object" | ...
}

/** True iff a runtime value matches one declared schema `type` token. */
function matchesType(value: unknown, type: string): boolean {
  const actual = jsonTypeOf(value)
  if (type === "number") return actual === "number" || actual === "integer"
  if (type === "object") return actual === "object"
  return actual === type
}

/** Structural deep-equality for `enum` matching (JSON values only). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((x, i) => deepEqual(x, b[i]))
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    const ak = Object.keys(ao)
    const bk = Object.keys(bo)
    if (ak.length !== bk.length) return false
    return ak.every((k) => Object.hasOwn(bo, k) && deepEqual(ao[k], bo[k]))
  }
  return false
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Join a parent path and a key/index into a JSON-Pointer-ish path. */
function childPath(path: string, key: string | number): string {
  return `${path}/${key}`
}

function validateNode(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  // enum: value must deep-equal one listed constant.
  if (Array.isArray(schema.enum)) {
    const ok = schema.enum.some((c) => deepEqual(value, c))
    if (!ok) {
      errors.push(`${path || "(root)"}: value does not match any enum constant`)
      // an enum miss is terminal for this node; other keywords add noise.
      return
    }
  }

  // type: string token or array of tokens (matches if any).
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    const known = types.filter((t): t is string => typeof t === "string" && PRIMITIVE_TYPES.has(t))
    if (known.length > 0 && !known.some((t) => matchesType(value, t))) {
      errors.push(
        `${path || "(root)"}: expected type ${known.join(" | ")}, got ${jsonTypeOf(value)}`,
      )
      // wrong type → don't descend into properties/items (would cascade).
      return
    }
  }

  // object keywords.
  if (isPlainObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !Object.hasOwn(value, key)) {
          errors.push(`${path || "(root)"}: missing required property "${key}"`)
        }
      }
    }

    const properties = isPlainObject(schema.properties) ? schema.properties : undefined
    if (properties) {
      for (const [key, sub] of Object.entries(properties)) {
        if (Object.hasOwn(value, key) && isPlainObject(sub)) {
          validateNode(value[key], sub, childPath(path, key), errors)
        }
      }
    }

    if (schema.additionalProperties === false) {
      const allowed = properties ? new Set(Object.keys(properties)) : new Set<string>()
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          errors.push(`${path || "(root)"}: additional property "${key}" is not allowed`)
        }
      }
    }
  }

  // array keyword: single-subschema `items` applied elementwise.
  if (Array.isArray(value) && isPlainObject(schema.items)) {
    value.forEach((el, i) => {
      validateNode(el, schema.items as JsonSchema, childPath(path, i), errors)
    })
  }
}

/**
 * Validate a JSON value against a (subset) JSON Schema. Pure: returns the
 * full list of failures rather than throwing or exiting. An empty `errors`
 * array means the value satisfies every supported keyword in the schema.
 *
 * Unsupported keywords are ignored (see the module doc-comment for the
 * supported/unsupported boundary), so a schema this validator cannot fully
 * express never produces a FALSE failure — at worst it under-constrains.
 */
export function validateAgainstSchema(value: unknown, schema: object): ValidationResult {
  const errors: string[] = []
  validateNode(value, schema as JsonSchema, "", errors)
  return { valid: errors.length === 0, errors }
}

/**
 * Parse the raw text of an `--output-schema FILE` into a schema object. Throws
 * a clear {@link Error} (not a bare SyntaxError) when the text is not valid
 * JSON or is not a JSON object, so the host can print one clean diagnostic.
 */
export function parseSchemaFile(raw: string): JsonSchema {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(`--output-schema is not valid JSON: ${reason}`)
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`--output-schema must be a JSON object, got ${jsonTypeOf(parsed)}`)
  }
  return parsed
}

/**
 * Validate the agent's FINAL ANSWER TEXT against a schema, parsing the answer
 * as JSON first. The string-entrypoint the host wants for `--output-schema`
 * validate-and-exit: it folds a JSON parse failure into the same
 * {@link ValidationResult} as a schema mismatch, so the caller has ONE branch:
 *
 * ```ts
 * const { valid, errors } = validateJsonAnswer(finalText, schema)
 * if (!valid) { process.stderr.write(`${errors.join("\n")}\n`); process.exit(1) }
 * ```
 *
 * Keeps the parse-vs-validate semantics owned here (one source of truth)
 * rather than each call site re-deriving "unparseable answer = invalid".
 */
export function validateJsonAnswer(answerText: string, schema: object): ValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(answerText)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      valid: false,
      errors: [`(root): final answer is not valid JSON: ${reason}`],
    }
  }
  return validateAgainstSchema(parsed, schema)
}
