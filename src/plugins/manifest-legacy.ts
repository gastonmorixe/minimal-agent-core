/**
 * Legacy manifest support (spec S31). Deleted in S41.
 *
 * A plugin manifest has identity fields at the top level, a `headless`
 * block that core loads, and an optional `ui` block that only the terminal
 * host loads. Before S31, manifests were flat: tools sat in a top-level
 * `tuis` array next to `modes`, `hooks`, and the other contributions, and
 * UI entries (`liveAreaSlots`, and the `icon`, `color`, and `headerKey`
 * tool fields) sat in the same places.
 *
 * This module is the ONE core file that still reads the legacy flat UI
 * field names. {@link splitManifest} turns a flat manifest into the
 * split form, so `parseManifest` (`./manifest.ts`) validates only the
 * split form. It also builds one notice per plugin (not per field) when
 * the manifest still has legacy UI fields, so an author knows to move
 * them. Core ignores those fields.
 *
 * @module plugins/manifest-legacy
 */

/** Contribution keys that live in the `headless` block. */
export const HEADLESS_KEYS: readonly string[] = [
  "tools",
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

/** Legacy flat keys that the split form keeps in a block. */
const FLAT_KEYS: readonly string[] = [...HEADLESS_KEYS.filter((k) => k !== "tools"), "tuis"]

/** Legacy cosmetic tool fields. */
const COSMETIC_TOOL_FIELDS: readonly string[] = ["icon", "color", "headerKey"]

/** The split view of one raw manifest. */
export interface SplitManifest {
  /** The `headless` block (or the flat contributions of a legacy manifest). */
  readonly headless: unknown
  /** The `ui` block (or the flat UI entries of a legacy manifest). `undefined` when absent. */
  readonly ui: unknown
  /**
   * Flat contribution keys found next to a `headless` block. Mixing both
   * forms is an error: `parseManifest` rejects the manifest.
   */
  readonly mixedKeys: readonly string[]
  /** One notice for the author when legacy UI fields are present. */
  readonly legacyNotice: string | undefined
}

/** True for a plain JSON object. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
}

/** Cosmetic fields that any tool entry in `tools` still sets. */
function cosmeticFieldsIn(tools: unknown): string[] {
  if (!Array.isArray(tools)) return []
  const found = new Set<string>()
  for (const entry of tools) {
    if (!isRecord(entry)) continue
    for (const k of COSMETIC_TOOL_FIELDS) if (entry[k] != null) found.add(k)
  }
  return COSMETIC_TOOL_FIELDS.filter((k) => found.has(k))
}

/**
 * Split a raw (unvalidated) manifest into its `headless` and `ui` parts.
 *
 * A manifest with a `headless` key is in the split form: the blocks pass
 * through as they are. A manifest without one is a legacy flat manifest:
 * its `tuis` become `headless.tools`, its other contributions move into
 * `headless`, and its `liveAreaSlots` move into `ui`. Shape errors are
 * `parseManifest`'s job, so this function never throws.
 */
export function splitManifest(raw: Record<string, unknown>): SplitManifest {
  const pluginId = typeof raw.id === "string" ? raw.id : "?"
  if (raw.headless !== undefined) {
    const mixedKeys = [...FLAT_KEYS, "liveAreaSlots"].filter((k) => raw[k] !== undefined)
    const cosmetic = isRecord(raw.headless) ? cosmeticFieldsIn(raw.headless.tools) : []
    return {
      headless: raw.headless,
      ui: raw.ui,
      mixedKeys,
      legacyNotice: noticeFor(pluginId, cosmetic, []),
    }
  }

  const headless: Record<string, unknown> = {}
  for (const k of FLAT_KEYS) {
    if (raw[k] === undefined) continue
    headless[k === "tuis" ? "tools" : k] = raw[k]
  }
  const ui = raw.liveAreaSlots !== undefined ? { liveAreaSlots: raw.liveAreaSlots } : raw.ui
  // The flat `tuis` key alone is no UI entry (it holds the tools), so it
  // gets no notice. Flat `liveAreaSlots` and cosmetic tool fields do.
  const flatUi = raw.liveAreaSlots !== undefined ? ["liveAreaSlots"] : []
  return {
    headless,
    ui,
    mixedKeys: [],
    legacyNotice: noticeFor(pluginId, cosmeticFieldsIn(raw.tuis), flatUi),
  }
}

/** The one notice for a plugin, or `undefined` when nothing is legacy. */
function noticeFor(
  pluginId: string,
  cosmetic: readonly string[],
  flatUi: readonly string[],
): string | undefined {
  if (cosmetic.length === 0 && flatUi.length === 0) return undefined
  const parts: string[] = []
  if (flatUi.length > 0) {
    parts.push(`flat ${flatUi.join("/")} (move UI entries to the ui block)`)
  }
  if (cosmetic.length > 0) {
    parts.push(`icon/color/headerKey on a tool (${cosmetic.join(", ")}); core ignores these`)
  }
  return `plugin "${pluginId}": manifest.json uses legacy UI fields (S31): ${parts.join("; ")}`
}
