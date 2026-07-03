/**
 * The agent's own build identity. Provider-neutral.
 *
 * `AGENT_VERSION` is minimal-agent's real semver, read from the repo
 * `package.json` next to the source tree at module load. This is distinct
 * from any provider's wire-protocol version string (e.g. an upstream CLI
 * version a provider plugin mimics in its User-Agent); those live in the
 * relevant provider plugin, never here.
 *
 * @module build-info
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Read the agent's semver from the embedded `<repo>/package.json`. Returns
 * `"0.0.0"` on any failure (missing file, malformed JSON, missing `version`)
 * so a dev tree with a broken manifest never throws at import time.
 */
function readAgentVersion(): string {
  try {
    const raw = readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      typeof (parsed as { version: unknown }).version === "string"
    ) {
      return (parsed as { version: string }).version
    }
  } catch {
    // Best-effort. Fall through to the default below.
  }
  return "0.0.0"
}

/** minimal-agent's own version (semver from package.json). */
export const AGENT_VERSION: string = readAgentVersion()
