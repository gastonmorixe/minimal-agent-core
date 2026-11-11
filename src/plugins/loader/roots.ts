/**
 * Plugin roots as data (spec S40).
 *
 * Core does not compute where plugins live. The host (the CLI, a web
 * server, a test) computes each root directory and passes the list in.
 * Each root directory holds plugin package directories directly: every
 * immediate subdirectory with a `manifest.json` (or a `provider.json`) is
 * one package.
 *
 * The tier of a root sets its precedence on a package id collision:
 * project wins over user, and user over embedded.
 *
 * @module plugins/loader/roots
 */

/** The precedence tier of a plugin root. */
export type PluginRootTier = "embedded" | "user" | "project"

/**
 * Plugin root directories by tier. Each directory holds plugin package
 * directories directly. Order inside one tier is scan order.
 */
export interface PluginRoots {
  /** Lowest precedence: plugins that ship with the host, and dev checkouts. */
  readonly embedded?: readonly string[]
  /** The per-user plugin clone (the first-run sync target). */
  readonly user?: readonly string[]
  /** Highest precedence: plugins of the current project. */
  readonly project?: readonly string[]
}

/** Tiers from lowest to highest precedence. */
export const PLUGIN_ROOT_TIERS: readonly PluginRootTier[] = ["embedded", "user", "project"]

/**
 * The provider plugin roots (`provider.json` packages) for `roots`, in
 * first-wins order: embedded roots first, then user roots. Provider
 * discovery keeps the first copy of each provider id, so a dev checkout in
 * the embedded tier shadows the user clone.
 */
export function providerRootsOf(roots: PluginRoots): string[] {
  return [...(roots.embedded ?? []), ...(roots.user ?? [])]
}
