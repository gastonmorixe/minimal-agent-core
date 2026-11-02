#!/usr/bin/env bun
/**
 * Generate `src/plugins/loader/host-core-modules.ts` from the `exports` map.
 *
 *   bun run gen:host-core-modules           # write the file
 *   bun run gen:host-core-modules --check   # exit 1 when the file is stale
 *
 * The file maps each public specifier to a static `require()` of its target.
 * See `renderHostCoreModules` in `src/plugins/loader/host-core-modules-render.ts`
 * for why. A test in `host-core-resolver.test.ts` fails when the file and `package.json`
 * disagree, so a new export cannot ship without a regenerated map.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import {
  HOST_CORE_MODULES_PATH,
  renderHostCoreModules,
} from "../src/plugins/loader/host-core-modules-render.ts"

const root = join(import.meta.dir, "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  exports: Record<string, unknown>
}
const outPath = join(root, HOST_CORE_MODULES_PATH)
const next = renderHostCoreModules(pkg.exports)

if (process.argv.includes("--check")) {
  let current = ""
  try {
    current = readFileSync(outPath, "utf8")
  } catch {
    // Missing file: stale.
  }
  if (current !== next) {
    console.error(`${HOST_CORE_MODULES_PATH} is stale. Run: bun run gen:host-core-modules`)
    process.exit(1)
  }
  console.log(`${HOST_CORE_MODULES_PATH} is up to date`)
} else {
  writeFileSync(outPath, next)
  console.log(`wrote ${HOST_CORE_MODULES_PATH}`)
}
