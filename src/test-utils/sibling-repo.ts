// Wave G test support: several integration tests exercise plugins that have
// been physically moved to the sibling plugins repo checkout. On a
// bare host checkout (CI, a fresh clone, contributors who have not cloned the
// sibling), that repo is absent and those tests cannot run. They must SKIP
// cleanly rather than fail, so the host repo stays green on its own.
//
// Use with bun:test `describe.skipIf(!siblingPluginPresent("ma-foo-plugin"))`.

import { existsSync } from "node:fs"
import { basename, join, resolve } from "node:path"

/** This repo's root (two levels up from `src/test-utils/`). */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..")

/**
 * Absolute path to the sibling plugins checkout. It sits next to this repo,
 * and its dir name is this repo's dir name with the last `core` changed to
 * `plugins` (a `<prefix>-core` clone next to `<prefix>-plugins`, or the
 * umbrella's `core` submodule next to `plugins`).
 * `MINIMAL_AGENT_TEST_PLUGINS_CHECKOUT` (an absolute path) overrides it.
 * Only tests use this path: core itself takes plugin roots as data (S40).
 */
export const SIBLING_REPO_ROOT: string =
  process.env.MINIMAL_AGENT_TEST_PLUGINS_CHECKOUT ??
  resolve(REPO_ROOT, "..", basename(REPO_ROOT).replace(/core$/, "plugins"))

/** True when the sibling plugins repo is checked out next to this repo. */
export function siblingRepoPresent(): boolean {
  return existsSync(SIBLING_REPO_ROOT)
}

/**
 * True when a specific migrated plugin is present in the sibling repo. `dir` is
 * the plugin's directory name (e.g. `ma-file-lock-plugin`). Checks for the dir
 * itself so both manifest plugins and provider (`provider.json`) plugins pass.
 */
export function siblingPluginPresent(dir: string): boolean {
  return existsSync(join(SIBLING_REPO_ROOT, dir))
}
