/** Built-in input normalization and validation before guards or file operations. */

import { validateAgainstSchema } from "../sdk/output-schema.ts"

import { globPathFromInput, globPatternFromInput, resolveGlobExecArgs } from "./glob-input.ts"
import { TOOL_DEFINITIONS } from "./tool-definitions.ts"
import { resolveWriteExecArgs } from "./write-input.ts"

/** Normalize only documented built-in aliases. Never change custom tool input. */
export function normalizeToolInput(
  name: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input
  if (!["Read", "Write", "Edit", "Glob"].includes(name)) return input
  const normalized = { ...input }
  const alias = (canonical: string, alternate: string): void => {
    if (!Object.hasOwn(normalized, canonical) && Object.hasOwn(normalized, alternate)) {
      normalized[canonical] = normalized[alternate]
    }
    delete normalized[alternate]
  }
  if (name === "Glob") {
    // Keep the existing blank-string and null fallback behavior for Glob.
    const pattern = globPatternFromInput(input)
    const path = globPathFromInput(input)
    if (pattern.status === "ok") normalized.pattern = pattern.value
    if (path.status === "ok") normalized.path = path.value
    else if (path.status === "missing") delete normalized.path
    if (pattern.status !== "invalid") delete normalized.glob_pattern
    if (path.status !== "invalid") delete normalized.target_directory
  } else {
    alias("file_path", "path")
    if (name === "Write") alias("content", "contents")
  }
  return normalized
}

/** Return a tool error for missing required fields or wrong declared types. */
export function validateToolInput(name: string, input: Record<string, unknown>): string | null {
  const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name)
  if (!definition) return null
  if (input && typeof input === "object" && !Array.isArray(input)) {
    // Preserve the existing actionable Write and Glob diagnostics.
    if (name === "Write") {
      const args = resolveWriteExecArgs(input)
      if (!args.ok) return args.error
    }
    if (name === "Glob") {
      const args = resolveGlobExecArgs(input, ".")
      if (!args.ok) return args.error
    }
  }
  // Unknown fields remain allowed for compatibility. Only declared fields and
  // required fields are checked. Alias removal keeps canonical precedence.
  const validation = validateAgainstSchema(input, {
    ...definition.input_schema,
    additionalProperties: true,
  })
  return validation.valid ? null : `${name} error: ${validation.errors.join(". ")}`
}

/** Normalize aliases then validate. One call for executeTool's line budget. */
export function prepareBuiltInToolInput(
  name: string,
  input: Record<string, unknown>,
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  const normalized = normalizeToolInput(name, input)
  const error = validateToolInput(name, normalized)
  if (error) return { ok: false, error }
  return { ok: true, input: normalized }
}
