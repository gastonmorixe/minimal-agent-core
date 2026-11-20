/**
 * The optional boolean flags of a tool trigger in a plugin manifest
 * (`mayReturnBinary`, `concurrencySafe`). Split out of `manifest.ts` to keep
 * that file under the `max-lines` lint budget.
 *
 * @module plugins/manifest-tool-flags
 */

/**
 * Check optional boolean keys of `obj`: each key must be a boolean, or
 * absent (`null` or `undefined`). Else call `err` with
 * `<prefix><key> must be a boolean if present`. Returns an object with only
 * the keys that are `true`, in the order of `keys` (a `false` key is left
 * out, so the parsed manifest has no key for the default).
 */
export function optionalTrueFlags(
  obj: Record<string, unknown>,
  keys: readonly string[],
  prefix: string,
  err: (msg: string) => void,
): Record<string, true> {
  const out: Record<string, true> = {}
  for (const key of keys) {
    if (typeof obj[key] !== "boolean" && obj[key] != null)
      err(`${prefix}${key} must be a boolean if present`)
    if (obj[key] === true) out[key] = true
  }
  return out
}
