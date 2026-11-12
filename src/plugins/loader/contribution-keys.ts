/**
 * The contribution keys a plugin manifest can declare. The "declares no
 * contributions" check and its warning text both read this one list.
 *
 * @module plugins/loader/contribution-keys
 */

import type { ManifestFile } from "../types.ts"

/**
 * Every contribution key of a manifest. One line here adds the next kind:
 * add the key, then add a case in {@link declaresAnyContribution}.
 */
export const CONTRIBUTION_KEYS = [
  "tools",
  "modes",
  "events",
  "hooks",
  "promptFragments",
  "commands",
  "hostModes",
  "errorRenderers",
  "sideband",
  "sidebandCodec",
  // Raw only on this base: no parsed field. Read from the raw manifest.
  "promptTemplate",
  "syntheticText",
  "replayRenderers",
  "turnAttachments",
  "ui",
] as const

/** One contribution key. */
export type ContributionKey = (typeof CONTRIBUTION_KEYS)[number]

/** Raw (unparsed) manifest values for the keys the parser does not keep. */
export type RawContributions = Partial<Record<ContributionKey, unknown>>

const nonEmptyArray = (v: unknown): boolean => Array.isArray(v) && v.length > 0

/** Does the manifest declare this one key? */
function declares(key: ContributionKey, m: ManifestFile, raw: RawContributions): boolean {
  switch (key) {
    case "ui":
      return m.declaresUi === true
    case "sidebandCodec":
      return m.sidebandCodec !== undefined
    case "promptTemplate":
      return raw.promptTemplate != null
    case "replayRenderers":
    case "turnAttachments":
      return nonEmptyArray(raw[key])
    default:
      return nonEmptyArray(m[key])
  }
}

/** True when the manifest declares at least one key of {@link CONTRIBUTION_KEYS}. */
export function declaresAnyContribution(m: ManifestFile, raw: RawContributions = {}): boolean {
  return CONTRIBUTION_KEYS.some((k) => declares(k, m, raw))
}
