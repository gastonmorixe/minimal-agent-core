// Wave G test support: several integration tests exercise plugins that have
// been physically moved to the sibling plugins repo checkout. On a
// bare host checkout (a fresh clone, contributors who have not cloned the
// sibling), that repo is absent and those tests cannot run. They SKIP, and
// this module prints one reason line, so the skip is visible.
// `MA_REQUIRE_PLUGINS=1` (CI sets it when it clones the sibling) makes a
// missing repo or plugin FAIL instead of skip.
//
// Use with bun:test `describe.skipIf(!siblingPluginPresent("ma-foo-plugin"))`.
// Every core test that needs the plugins repo finds it here, and only here.

import { existsSync } from "node:fs"
import { join, resolve } from "node:path"

/** This repo's root (two levels up from `src/test-utils/`). */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..")

/** True when `MA_REQUIRE_PLUGINS=1`: a missing sibling is an error, not a skip. */
const REQUIRE = process.env.MA_REQUIRE_PLUGINS === "1"

/**
 * The places to look for the plugins repo, in order:
 * 1. `MA_PLUGINS_DIR` (an absolute path, or a path relative to the cwd).
 * 2. `../plugins` (the umbrella layout, next to the `core` submodule).
 * 3. `../minimal-agent-plugins` (next to a `minimal-agent-core` clone).
 */
const CANDIDATES: readonly string[] = [
  ...(process.env.MA_PLUGINS_DIR ? [resolve(process.env.MA_PLUGINS_DIR)] : []),
  resolve(REPO_ROOT, "..", "plugins"),
  resolve(REPO_ROOT, "..", "minimal-agent-plugins"),
]

const FOUND: string | undefined = process.env.MA_PLUGINS_DIR
  ? CANDIDATES[0]
  : CANDIDATES.find((dir) => existsSync(dir))

/**
 * Absolute path to the plugins repo checkout: the first entry of the search
 * order that exists. When `MA_PLUGINS_DIR` is set, it is used as is (no
 * fallback). When nothing exists, this is the `../plugins` path, and
 * {@link siblingRepoPresent} is false. Only tests use this path: core itself
 * takes plugin roots as data (S40).
 */
export const SIBLING_REPO_ROOT: string = FOUND ?? resolve(REPO_ROOT, "..", "plugins")

const PRESENT = existsSync(SIBLING_REPO_ROOT)

if (!PRESENT) {
  const reason =
    `no plugins repo found (tried ${CANDIDATES.join(", ")}).` +
    " Set MA_PLUGINS_DIR, or clone minimal-agent-plugins next to this repo."
  if (REQUIRE) throw new Error(`[sibling-plugins] MA_REQUIRE_PLUGINS=1 and ${reason}`)
  console.warn(`[sibling-plugins] SKIP the tests that need the plugins repo: ${reason}`)
}

/** True when the sibling plugins repo is checked out (see {@link SIBLING_REPO_ROOT}). */
export function siblingRepoPresent(): boolean {
  return PRESENT
}

/**
 * True when a specific migrated plugin is present in the sibling repo. `dir` is
 * the plugin's directory name (e.g. `ma-file-lock-plugin`). Checks for the dir
 * itself so both manifest plugins and provider (`provider.json`) plugins pass.
 *
 * @throws Error when `MA_REQUIRE_PLUGINS=1` and the plugin dir is missing
 */
export function siblingPluginPresent(dir: string): boolean {
  const present = existsSync(join(SIBLING_REPO_ROOT, dir))
  if (!present && REQUIRE) {
    throw new Error(
      `[sibling-plugins] MA_REQUIRE_PLUGINS=1 and ${dir} is missing in ${SIBLING_REPO_ROOT}`,
    )
  }
  return present
}
