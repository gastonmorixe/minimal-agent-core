/**
 * Architecture fitness function: plugins do NOT import host code.
 *
 * THE RULE (Gaston, 2026-06-09): a plugin under `plugins/<id>/` must be able
 * to live in its own repository. It may not import from `src/` — not even
 * type-only. Everything a plugin needs crosses the boundary through the
 * shared context the host hands it (`ctx`, `ctx.host` capabilities, env
 * vars, JSON envelopes), and the plugin re-declares the slice it consumes
 * as a LOCAL structural interface (TypeScript's structural typing makes the
 * real host object satisfy it at runtime). See
 * `src/plugins/host/capabilities.ts` for the capability-host design that
 * exists precisely to make this possible.
 *
 * THE RATCHET: `BASELINE` freezes the per-file count of `src/` import sites
 * that existed when this test landed. The assertion is two-directional:
 *
 *   - A file ABOVE its baseline count (or a new file with any site) → FAIL:
 *     route the data through the handler context / capability host instead.
 *     New coupling dies in one test run.
 *   - A file BELOW its baseline count (or fully cleaned) → FAIL: ratchet
 *     down — update/remove its entry so the cleanup can never regress.
 *
 * Counting SITES per file (not just membership) means adding a second
 * `src/` import to an already-dirty file trips the ratchet too.
 *
 * Scanner internals live in `src/architecture/plugin-import-scan.ts`. To
 * regenerate the baseline after intentional cleanups:
 *
 *   bun -e 'import("./src/architecture/plugin-import-scan.ts").then(m =\>
 *     console.log(m.renderBaseline(m.scanPluginSrcImports("plugins"))))'
 */

import { existsSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { countByFile, scanPluginSrcImports } from "./plugin-import-scan.ts"

const PLUGINS_ROOT = join(import.meta.dirname, "..", "..", "plugins")

/**
 * Wave-G roots the I3 ratchet enforces across. The embedded `plugins/` tree
 * (empty as of Wave G — every plugin has moved to the sibling repo, so the
 * directory no longer exists) PLUS the sibling `../minimal-agent-plugins/`
 * checkout (where migrated plugins live), so a plugin that moves out of the
 * monorepo does NOT escape the coupling ratchet — it must stay `src/`-free in
 * its new home too. Each root is scanned only when present (a bare host
 * checkout without either tree still runs this test green). File keys stay
 * distinct across roots: any residual embedded plugin uses a bare dir name
 * (`memory/...`), migrated ones use `ma-*-plugin/`.
 */
const SIBLING_ROOT = join(import.meta.dirname, "..", "..", "..", "minimal-agent-plugins")
const PLUGIN_ROOTS = [
  ...(existsSync(PLUGINS_ROOT) ? [PLUGINS_ROOT] : []),
  ...(existsSync(SIBLING_ROOT) ? [SIBLING_ROOT] : []),
]

/** Scan every enforced root and concatenate the sites (keys are root-relative, disjoint). */
function scanAllRoots(): ReturnType<typeof scanPluginSrcImports> {
  return PLUGIN_ROOTS.flatMap((root) => scanPluginSrcImports(root))
}

/**
 * Frozen legacy violations: `plugins/<...>.ts` → number of `src/` import
 * sites at freeze time. Decoupling waves shrink counts toward zero; every
 * change here is a reviewed edit. DO NOT INCREASE ANY COUNT and DO NOT ADD
 * ENTRIES — new plugin code talks to the host through its context.
 *
 * SCANNER-HARDENING RE-BASELINE (FIX-i3, contrarian audit §5): the I3 scanner
 * (`architecture/plugin-import-scan.ts`) used to split source BY LINE before
 * matching, so it MISSED every import whose specifier did not sit on the same
 * line as the `import` keyword: multi-line `import { … } from "../../src/x.ts"`
 * clauses, `require("../../src/x.ts")`, and side-effect `import "../../src/x.ts"`.
 * The scanner now strips comments over the WHOLE source and matches with a
 * multiline-capable regex (mirroring core-plugin-import-scan.ts). That surfaced
 * 13 sites across 11 files that were ALWAYS there but hidden, raising the honest
 * count 97 → 110. Entries marked `[surfaced by FIX-i3]` below are those
 * previously-hidden sites being frozen at their TRUE values — freezing reality,
 * NOT widening the gate. All but one were multi-line clauses; the exception is a
 * `require("../../../src/config.ts")` in file-lock's lock_status.ts. Full
 * site-by-site list in reports/FIX-i3.md.
 */
const BASELINE = new Map<string, number>([
  // Wave G: llm-anthropic physically moved to the sibling
  // ../minimal-agent-plugins/ma-llm-anthropic-plugin and was made fully
  // src/-clean in the move (vendored plugin-api leaf libs into lib/, a
  // plugin-local model catalog in lib/registry.ts replacing the host
  // model-registry reads, a plugin-local quota cache + `setQuotaRefreshHook`
  // seam replacing quota-cache/quota-broadcast, a vendored prompt loader in
  // lib/prompts.ts, and the cold-start quota probe dropped in favor of
  // filling the cache from real response headers — same design as the openai
  // plugin). Two host-orchestrator tests (forked-session.e2e, the
  // adapter.preflight integration) could not follow it without a
  // core->sibling import the arch scan forbids; they must be re-adopted as
  // core integration tests (the preflight pipeline + session-restore paths
  // are already exercised by src/agent/preflight-pipeline.test.ts and
  // src/llm/preflight.test.ts). With anthropic gone, the top-level ./plugins
  // tree is empty and I3's frozen baseline is now EMPTY: every remaining
  // plugin lives in the sibling repo and is src/-clean.
  //
  // Wave G: the llm-openai provider physically moved to the sibling
  // ../minimal-agent-plugins/ma-llm-openai-plugin (its plugin-local tests ride
  // along). The stall-repro capstone (a host watchdog/adapter-legacy stream
  // regression built on captured wire bytes) is NOT relocated this wave: it
  // needs the plugin's OWN Responses translator, which from core would require
  // a cross-repo import (core->sibling) the arch scan forbids. The translator's
  // own leaf tests + the plugin's suite cover it; a core-importable relocation
  // (move the Responses translator to the plugin-api leaf) is a follow-up.
  // Wave G phase 4: llm-opencode + llm-wafer physically moved to the sibling
  // ../minimal-agent-plugins/ repo (coordinated dual-removal), so they no longer
  // appear here. Their cross-provider disambiguation/dispatch tests were adopted
  // into src/llm/wafer-opencode-{disambiguation,dispatch}.integration.test.ts,
  // which discover both providers from the sibling.
  // Wave G: the schedule plugin physically moved to the sibling
  // ../minimal-agent-plugins/ma-schedule-plugin. Its production was already
  // src/-clean (utils vendored to lib/, host types mirrored in lib/host-types.ts).
  // The load-integration test was adopted into
  // src/plugins/schedule.load.integration.test.ts, which discovers the plugin
  // from the sibling via siblingDirs + siblingPluginPresent.
  // D-usage: RESOLVED (Scott, Wave G). The usage DATA ENGINE
  // (scanUsageEvents / aggregate* — which scan the session store + price
  // against the model registry) now sits behind the `usage:read` host
  // capability: cmd_usage reads folded reports via `ctx.host.usage`, and
  // `parseUsagePeriod` + an `emptyUsageReports` fixture helper moved to the
  // leaf `@minimal-agent/plugin-api/utils/usage-report`. All three usage
  // files now have 0 src/ imports; baseline entries removed.
  // D-quickwins: RESOLVED (Scott, Wave G). `brave.ts` used to import `retry` +
  // `type RetryOptions` from `src/utils/retry.ts`. That module is PURE (zero
  // host state, injectable sleep/now/random), so it was leaf-extracted to
  // `@minimal-agent/plugin-api/utils/retry` and brave now imports the leaf.
  // Baseline entry removed (0 sites).
])

describe("architecture: plugin decoupling (plugins never import src/)", () => {
  const counts = countByFile(scanAllRoots())

  it("no NEW src/ imports beyond the frozen baseline (ratchet up-direction)", () => {
    const regressions: string[] = []
    for (const [file, n] of counts) {
      const allowed = BASELINE.get(file) ?? 0
      if (n > allowed) regressions.push(`${file}: ${n} sites (baseline ${allowed})`)
    }
    expect(
      regressions.sort(),
      `NEW plugin→src coupling. A plugin must be able to live in its own repo: ` +
        `consume host data through ctx / ctx.host capabilities and re-declare types ` +
        `as local structural interfaces. Do NOT extend the baseline:\n  ${regressions.join("\n  ")}`,
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
      `These files have FEWER src/ imports than the frozen baseline — ratchet down: ` +
        `update/remove their entries in BASELINE so the cleanup can never regress:\n  ${stale.join("\n  ")}`,
    ).toEqual([])
  })
})
