/**
 * Tolerance shim for the legacy flat cosmetic tool-presentation fields
 * (`icon`, `color`, `headerKey`) that a pre-S29/S31 manifest still sets on a
 * `tuis[]` handler entry (spec S31). `parseManifest` (`./manifest.ts`) no
 * longer validates these or carries them through into `ManifestHandler` —
 * they are silently dropped there, same as any other unknown key.
 *
 * This module is the ONE file that still reads them: it logs a single
 * warning per plugin package (not per field, not per handler) so an author
 * knows the fields no longer do anything, then the caller moves on. It is
 * deleted in S41, once the CLI has its own static tool-presentation map and
 * manifests have dropped the fields for good.
 *
 * @module plugins/manifest-legacy
 */

/** True if a raw `tuis[]` handler entry still sets a legacy cosmetic field. */
function handlerHasLegacyPresentationFields(entry: unknown): boolean {
  if (entry === null || typeof entry !== "object") return false
  const obj = entry as Record<string, unknown>
  return obj.icon != null || obj.color != null || obj.headerKey != null
}

/**
 * Logs one warning via `logger` when `rawManifest`'s `tuis[]` array has at
 * least one handler entry carrying a legacy cosmetic field (`icon`,
 * `color`, or `headerKey`). No-op otherwise, including when `tuis` is
 * absent or malformed (that shape error is `parseManifest`'s job).
 *
 * `rawManifest` is the raw, unvalidated `JSON.parse` result — the fields
 * this checks for no longer exist on the typed `ManifestHandler`, so there
 * is nothing to read them off of after validation.
 */
export function warnLegacyToolPresentationFields(
  rawManifest: unknown,
  pluginId: string,
  logger: (msg: string) => void,
): void {
  if (rawManifest === null || typeof rawManifest !== "object") return
  const tuis = (rawManifest as Record<string, unknown>).tuis
  if (!Array.isArray(tuis)) return
  if (tuis.some(handlerHasLegacyPresentationFields)) {
    logger(
      `plugin "${pluginId}": manifest.json sets icon/color/headerKey on a tuis[] handler; ` +
        "core no longer reads these cosmetic fields (S29/S31) and ignores them.",
    )
  }
}
