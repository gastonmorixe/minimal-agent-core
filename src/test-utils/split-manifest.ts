/**
 * Test fixtures only: turn a short flat manifest into the split form (S31).
 *
 * Many loader tests write their fixture manifests in the old flat shape
 * (`tuis`, `hooks`, ... at the top level). Core rejects that shape since
 * S41. This helper moves the contribution keys into the `headless` block
 * (`tuis` become `headless.tools`) and `liveAreaSlots` into the `ui`
 * block, and drops the tool presentation fields (`icon`, `color`,
 * `headerKey`). A manifest that already has a `headless` block, or a
 * value that is not an object, passes through unchanged.
 *
 * Tests of the flat-manifest rejection must not use this helper.
 *
 * @module test-utils/split-manifest
 */

/** Flat contribution keys that the split form keeps in `headless`. */
const FLAT_HEADLESS_KEYS: readonly string[] = [
  "tuis",
  "modes",
  "events",
  "hooks",
  "promptFragments",
  "commands",
  "hostModes",
  "setup",
  "replayRenderers",
  "turnAttachments",
]

/** Tool presentation fields. Core rejects them since S41. */
const COSMETIC: readonly string[] = ["icon", "color", "headerKey"]

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

/** The split form of a flat fixture manifest. See the module doc. */
export function splitFlatManifest<T>(manifest: T): T {
  if (!isRecord(manifest) || manifest.headless !== undefined) return manifest
  const out: Record<string, unknown> = {}
  const headless: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(manifest)) {
    if (FLAT_HEADLESS_KEYS.includes(k)) headless[k === "tuis" ? "tools" : k] = v
    else if (k === "liveAreaSlots") out.ui = { liveAreaSlots: v }
    else out[k] = v
  }
  if (Array.isArray(headless.tools)) {
    headless.tools = headless.tools.map((t: unknown) => {
      if (!isRecord(t)) return t
      const copy = { ...t }
      for (const k of COSMETIC) delete copy[k]
      return copy
    })
  }
  if (Object.keys(headless).length > 0) out.headless = headless
  return out as T
}
