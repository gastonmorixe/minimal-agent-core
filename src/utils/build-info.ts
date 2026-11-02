/**
 * The agent's own build identity. Provider-neutral.
 *
 * `AGENT_VERSION` is minimal-agent's real semver, from the repo
 * `package.json`. This is distinct from any provider's wire-protocol
 * version string (e.g. an upstream CLI version a provider plugin mimics in
 * its User-Agent); those live in the relevant provider plugin, never here.
 *
 * The manifest is a static JSON import, not a file read: Bun inlines it at
 * build time, so a `bun build --compile` binary (which has no `package.json`
 * on disk) reports the same version as a run from source.
 *
 * @module build-info
 */

import pkg from "../../package.json" with { type: "json" }

/**
 * The `version` field of a parsed manifest, or `"0.0.0"` when it is missing
 * or not a string.
 */
export function manifestVersion(manifest: unknown): string {
  if (
    manifest &&
    typeof manifest === "object" &&
    "version" in manifest &&
    typeof (manifest as { version: unknown }).version === "string"
  ) {
    return (manifest as { version: string }).version
  }
  return "0.0.0"
}

/** minimal-agent's own version (semver from package.json). */
export const AGENT_VERSION: string = manifestVersion(pkg)
