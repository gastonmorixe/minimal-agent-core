/**
 * The `hostMode:stdio` permission gate, shared by the loader
 * (`loader/host-modes.ts`) and the CLI catalog (`catalog.ts`). One copy of
 * the predicate, so the two cannot drift (SPEC-HELP K-12).
 *
 * No imports on purpose: the catalog must stay a static, import-free
 * read of manifests.
 *
 * @module plugins/host-mode-permission
 */

/** The implicit permission that every `hostModes[]` entry requires. */
export const HOST_MODE_STDIO_PERMISSION = "hostMode:stdio"

/** Any manifest shape with an optional `permissions` list. */
export interface HostModePermissionSource {
  /** The declared permissions, if any. */
  permissions?: readonly string[]
}

/**
 * True when the manifest declares the `hostMode:stdio` permission. A
 * plugin without it gets every host mode skipped by the loader.
 *
 * @param manifest - The manifest to check.
 */
export function hasHostModeStdio(manifest: HostModePermissionSource): boolean {
  return (manifest.permissions ?? []).includes(HOST_MODE_STDIO_PERMISSION)
}
