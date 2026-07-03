/**
 * Architecture fitness function (I2): core NEVER imports plugins.
 *
 * THE RULE (Gaston, 2026-06-10): `src/` is the provider-agnostic harness;
 * `plugins/` (future home `../minimal-agent-plugins/`) is adapter land. No
 * file under `src/` may import — static, `export ... from`, type-only, or
 * dynamic with a LITERAL specifier — anything that RESOLVES into a
 * top-level plugins tree. Resolution is path-aware: `../plugins/x` from
 * `src/headers.ts` escapes into `plugins/` (violation), while
 * `../plugins/types.ts` from `src/llm/provider.ts` resolves to
 * `src/plugins/types.ts` (loader infrastructure, core-internal, legal).
 * The ONE blessed seam is the loader's runtime discovery: dynamic
 * `import(abs)` with a COMPUTED path. Computed dynamic imports are not
 * literal specifiers and are not flagged.
 *
 * THE RATCHET: `BASELINE` freezes the per-file count of plugins/ import
 * sites that existed when this test landed (34 sites / 17 files,
 * regenerated from the scanner on 2026-06-10). The assertion is
 * two-directional:
 *
 *   - A file ABOVE its baseline count (or a new file with any site) → FAIL:
 *     route the dependency through a core-owned seam (registration hook,
 *     ctx/host capability) instead. New coupling dies in one test run.
 *   - A file BELOW its baseline count (or fully cleaned) → FAIL: ratchet
 *     down — update/remove its entry so the cleanup can never regress.
 *
 * Counting SITES per file (not just membership) means adding a second
 * plugins/ import to an already-dirty file trips the ratchet too.
 *
 * Scanner internals live in `src/architecture/core-plugin-import-scan.ts`.
 * To regenerate the baseline after intentional cleanups:
 *
 *   bun -e 'import("./src/architecture/core-plugin-import-scan.ts").then(m =\>
 *     console.log(m.renderBaseline(m.scanCorePluginImports("src",
 *       m.DEFAULT_PLUGIN_ROOTS, m.DEFAULT_EXEMPT))))'
 */

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import {
  countSitesByFile,
  DEFAULT_EXEMPT,
  DEFAULT_PLUGIN_ROOTS,
  scanCorePluginImports,
} from "./core-plugin-import-scan.ts"

const SRC_ROOT = join(import.meta.dirname, "..")

/**
 * Frozen legacy violations: `src/<...>.ts` → number of plugins/ import
 * sites at freeze time (2026-06-10). Wave A severs these; every change
 * here is a reviewed edit. DO NOT INCREASE ANY COUNT and DO NOT ADD
 * ENTRIES — core reaches plugins only through the loader's runtime
 * discovery seam. END STATE: this map is EMPTY and deleted.
 */
const BASELINE = new Map<string, number>([
  // A-4 (Wave A) severed the agent-cluster test reach-ins: canonical-dispatch
  // (2), preflight (1), tasks-attachment (2), turn-attachments (3),
  // preflight-pipeline (1) now route through core seams (registerTestProvider,
  // the turn-attachment registry, in-test fake producers/providers) and import
  // no plugins. B-4 severed the final site: headers.ts no longer imports
  // ../plugins/llm-anthropic/beta-gates.ts (the two model-gate predicates are
  // now inlined as local copies). I2 in src/ is ZERO. END STATE reached: this
  // map is EMPTY. Keep it empty — any new entry is a NEW core→plugin coupling.
])

describe("architecture: core→plugin imports (I2 — src/ never imports plugins/)", () => {
  const counts = countSitesByFile(
    scanCorePluginImports(SRC_ROOT, DEFAULT_PLUGIN_ROOTS, DEFAULT_EXEMPT),
  )

  it("no NEW plugins/ imports beyond the frozen baseline (ratchet up-direction)", () => {
    const regressions: string[] = []
    for (const [file, n] of counts) {
      const allowed = BASELINE.get(file) ?? 0
      if (n > allowed) regressions.push(`${file}: ${n} sites (baseline ${allowed})`)
    }
    expect(
      regressions.sort(),
      `NEW core→plugin coupling. Core must stay provider/plugin-agnostic: reach plugin ` +
        `behavior through a core-owned seam (registration hook, loader discovery, ctx/host ` +
        `capability), never a literal import into plugins/. Do NOT extend the baseline:\n  ` +
        regressions.join("\n  "),
    ).toEqual([])
  })

  it("cleanups ratchet the baseline down (down-direction)", () => {
    const stale: string[] = []
    for (const [file, allowed] of BASELINE) {
      const n = counts.get(file) ?? 0
      if (n < allowed) stale.push(`${file}: now ${n} sites (baseline ${allowed})`)
    }
    expect(
      stale.sort(),
      `These files have FEWER plugins/ imports than the frozen baseline — ratchet down: ` +
        `update/remove their entries in BASELINE so the cleanup can never regress:\n  ${stale.join("\n  ")}`,
    ).toEqual([])
  })
})
