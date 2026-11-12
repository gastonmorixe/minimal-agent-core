/**
 * Abstract base of every core error. Holds no text: `message` is always empty.
 *
 * @module errors/core-error
 */

import type { CoreErrorJson, ForeignErrorJson, JsonValue } from "./types.ts"

/** The reserved `kind` of a non-`CoreError` cause. No subclass may use it. */
export const FOREIGN_ERROR_KIND = "ForeignError" as const

const OMIT = new Set(["kind", "name", "message", "stack", "cause"])

function foreignJson(cause: unknown): ForeignErrorJson {
  const out: ForeignErrorJson = { kind: FOREIGN_ERROR_KIND }
  if (typeof cause === "object" && cause !== null) {
    const { code, errno } = cause as { code?: unknown; errno?: unknown }
    if (typeof code === "string") out.code = code
    if (typeof errno === "number") out.errno = errno
  }
  return out
}

/**
 * Pure normalizer so that `JSON.parse(JSON.stringify(e))` equals `e.toJSON()`.
 * Object keys with `undefined` are dropped (array slots become `null`, as JSON
 * does). `Date` becomes its ISO string. A `CoreError` becomes its `toJSON()`.
 * A bigint, function, symbol or circular reference becomes the identifier
 * marker `{ kind: "UnserializableValue", type: <typeof> }`. Never throws.
 */
function toJsonValue(v: unknown, ancestors: object[]): JsonValue {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  if (typeof v !== "object") {
    return { kind: "UnserializableValue", type: typeof v }
  }
  if (v instanceof CoreError) return v.toJSON() as unknown as JsonValue
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString()
  if (ancestors.includes(v)) return { kind: "UnserializableValue", type: "object" }
  const next = [...ancestors, v]
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : toJsonValue(x, next)))
  const out: Record<string, JsonValue> = {}
  for (const [k, x] of Object.entries(v)) {
    if (x !== undefined) out[k] = toJsonValue(x, next)
  }
  return out
}

/**
 * Base class for typed core errors. A subclass declares
 * `static readonly kind = "<ClassName>"` and the type-only
 * `declare readonly kind: "<ClassName>"`. The constructor reads
 * `new.target.kind` and sets the own properties `kind` and `name`.
 */
export abstract class CoreError extends Error {
  declare static readonly kind: string
  declare readonly kind: string

  constructor(options?: { cause?: unknown }) {
    super("", options)
    const kind = (new.target as unknown as { kind: string }).kind
    Object.defineProperty(this, "kind", {
      value: kind,
      enumerable: true,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(this, "name", {
      value: kind,
      enumerable: false,
      writable: true,
      configurable: true,
    })
  }

  /** Return `{ kind, fields, cause? }`. A foreign cause keeps only `code` and `errno`. */
  toJSON(): CoreErrorJson {
    const fields: Record<string, JsonValue> = {}
    for (const [k, v] of Object.entries(this)) {
      if (OMIT.has(k) || v === undefined) continue
      fields[k] = toJsonValue(v, [])
    }
    const out: CoreErrorJson = { kind: this.kind, fields }
    if (this.cause !== undefined) {
      out.cause = this.cause instanceof CoreError ? this.cause.toJSON() : foreignJson(this.cause)
    }
    return out
  }
}
