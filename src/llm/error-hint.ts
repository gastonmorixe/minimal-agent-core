/**
 * Duck-typed readers for the provider error hint channel.
 *
 * `ProviderError` (plugin-api `llm/errors.ts`) carries optional `hint` (one
 * line, the user's next step) and `code` (stable machine code). Plugins vendor
 * their own copy of the class, so `instanceof` is not reliable. Any thrown
 * object with a string `hint` / `code` property counts. The `cause` chain is
 * walked so a wrapped provider error keeps its hint.
 *
 * @module llm/error-hint
 */

const MAX_CAUSE_DEPTH = 5

function readStringProp(err: unknown, key: "hint" | "code"): string | undefined {
  let node: unknown = err
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (node === null || typeof node !== "object") return undefined
    const value = (node as Record<string, unknown>)[key]
    if (typeof value === "string") {
      const trimmed = value.replace(/\s+/g, " ").trim()
      if (trimmed.length > 0) return trimmed
    }
    node = (node as { cause?: unknown }).cause
  }
  return undefined
}

/** The one-line user hint on a thrown error, if any (collapsed to one line). */
export function errorHint(err: unknown): string | undefined {
  return readStringProp(err, "hint")
}

/** The stable machine code on a thrown error, if any. */
export function errorCode(err: unknown): string | undefined {
  return readStringProp(err, "code")
}

/** The `error` event fields for a fatal non-abort throw, or `null` for an abort. */
export function fatalErrorFields(
  err: unknown,
): { message: string; code?: string; hint?: string } | null {
  if (err instanceof Error && err.name === "AbortError") return null
  const code = errorCode(err)
  const hint = errorHint(err)
  return {
    message: err instanceof Error ? err.message : String(err),
    ...(code ? { code } : {}),
    ...(hint ? { hint } : {}),
  }
}
