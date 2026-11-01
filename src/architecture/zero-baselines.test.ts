/**
 * Zero ratchets (spec S44). Every shrink-only baseline in core is empty, or
 * holds only a named exception with a reason. A new exception needs a lead
 * decision: add it here and in its own baseline, with the reason.
 *
 * Empty:
 * - core-to-host imports (`core-host-import-scan.ts`): no site.
 * - core-to-plugin imports (`core-plugin-import-scan.ts`): no site.
 * - direct writes (`direct-write-scan.ts`): no site.
 * - global `diag.*` call sites (`diag-call-sites.ts`): no entry.
 * - SDK port boundary violations (`sdk-port-boundaries-scan.ts`): none.
 * - public closure (`public-closure-scan.ts`): no host folder, and no stdio
 *   outside the S2429 row below.
 *
 * Named exceptions:
 * - public closure: `plugin-api/src/utils/term-width.ts`, `ansi: 1`. The
 *   one ESC literal is the SGR reset that closes a style the input opened
 *   (decision 18 keeps term-width in core).
 * - public closure: `src/adapters/tool-executor-adapter.ts`, `stdio: 6`.
 *   Owned by S2429, which removes the terminal-size reads. Then drop it.
 * - provider tokens: `auth/auth.ts` and its test. They hold the plan OAuth
 *   client that the CLI still calls through `./host/auth`. It leaves core
 *   when the provider plugin owns its OAuth refresh (B-6).
 *
 * Not baselines (they do not need to reach zero):
 * - the timer inventory (S43): S44 says it does not need to be empty.
 * - the SDK type-only import count (`sdk-port-boundaries.test.ts`): it
 *   counts legal type edges inside the SDK, not violations.
 * - `CLOSURE_FORBIDDEN_FOLDERS` (decision 25): a guard, not a baseline.
 *
 * @module architecture/zero-baselines.test
 */

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  DEFAULT_EXEMPT as CORE_HOST_EXEMPT,
  DEFAULT_HOST_ROOTS,
  scanCoreHostImports,
} from "./core-host-import-scan.ts"
import {
  DEFAULT_EXEMPT as CORE_PLUGIN_EXEMPT,
  DEFAULT_PLUGIN_ROOTS,
  scanCorePluginImports,
} from "./core-plugin-import-scan.ts"
import { DIAG_CALL_SITE_INVENTORY, scanDiagCallSites } from "./diag-call-sites.ts"
import { directWriteScope, scanDirectWrites } from "./direct-write-scan.ts"
import { LEGACY_PROVIDER_TOKEN_BASELINE } from "./provider-baseline.ts"
import {
  CLOSURE_FORBIDDEN_FOLDERS,
  PUBLIC_CLOSURE_BASELINE,
  walkPublicClosure,
} from "./public-closure-scan.ts"
import { formatSdkViolations, scanSdkPortBoundaries } from "./sdk-port-boundaries-scan.ts"

const REPO_ROOT = join(import.meta.dirname, "..", "..")
const SRC_ROOT = join(REPO_ROOT, "src")

describe("zero baselines (S44)", () => {
  it("core imports no host folder", () => {
    expect(scanCoreHostImports(SRC_ROOT, DEFAULT_HOST_ROOTS, CORE_HOST_EXEMPT)).toEqual([])
  })

  it("core imports no plugin folder", () => {
    expect(scanCorePluginImports(SRC_ROOT, DEFAULT_PLUGIN_ROOTS, CORE_PLUGIN_EXEMPT)).toEqual([])
  })

  it("no engine file writes directly", () => {
    expect(scanDirectWrites(REPO_ROOT, directWriteScope(REPO_ROOT))).toEqual([])
  })

  it("the diag call-site inventory is empty and the scan agrees", () => {
    expect([...DIAG_CALL_SITE_INVENTORY]).toEqual([])
    expect([...scanDiagCallSites(REPO_ROOT)]).toEqual([])
  })

  it("the SDK has no port boundary violation", () => {
    expect(formatSdkViolations(scanSdkPortBoundaries("src/sdk"))).toEqual([])
  })

  it("the public closure baseline holds only the named exceptions", () => {
    expect([...PUBLIC_CLOSURE_BASELINE.keys()]).toEqual([
      "plugin-api/src/utils/term-width.ts",
      "src/adapters/tool-executor-adapter.ts",
    ])
    const entry = PUBLIC_CLOSURE_BASELINE.get("plugin-api/src/utils/term-width.ts")
    expect(entry?.cliFile).toBe(false)
    expect(entry?.stdio).toBe(0)
    expect(entry?.ansi).toBe(1)
    expect(entry?.reason).toContain("S44 exception")
  })

  it("the public closure reaches no stdio and no host folder", () => {
    const closure = walkPublicClosure(REPO_ROOT)
    const bad = [...closure.findings].filter(
      ([file, f]) => f.cliFile || (f.stdio > 0 && file !== "src/adapters/tool-executor-adapter.ts"),
    )
    expect(bad).toEqual([])
    for (const file of closure.reached) {
      expect(CLOSURE_FORBIDDEN_FOLDERS.some((folder) => file.startsWith(folder))).toBe(false)
    }
  })

  it("the provider token baseline holds only the plan OAuth exception", () => {
    expect([...LEGACY_PROVIDER_TOKEN_BASELINE].sort()).toEqual([
      "auth/auth.test.ts",
      "auth/auth.ts",
    ])
  })

  it("CLOSURE_FORBIDDEN_FOLDERS stays as a guard (decision 25)", () => {
    expect(CLOSURE_FORBIDDEN_FOLDERS.length).toBeGreaterThan(0)
  })
})
