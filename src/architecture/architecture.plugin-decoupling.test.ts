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
 * Wave-G roots the I3 ratchet enforces across. Embedded `plugins/` PLUS the
 * sibling `../minimal-agent-plugins/` checkout (where migrated plugins live),
 * so a plugin that moves out of the monorepo does NOT escape the coupling
 * ratchet — it must stay `src/`-free in its new home too. The sibling is
 * scanned only when present (a bare host checkout without the plugins repo
 * still runs this test green). File keys stay distinct across roots: embedded
 * plugins use bare dir names (`memory/...`), migrated ones use `ma-*-plugin/`.
 */
const SIBLING_ROOT = join(import.meta.dirname, "..", "..", "..", "minimal-agent-plugins")
const PLUGIN_ROOTS = [PLUGINS_ROOT, ...(existsSync(SIBLING_ROOT) ? [SIBLING_ROOT] : [])]

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
  // Wave D-anthropic: §5 net/registry/pure-neutral re-point sweep (76→51).
  // Residual src sites are all blocked type families: canonical-request (C-3),
  // model-registry runtime + ModelEntry, provider.ts port (post-C-3), pricing
  // MTokRate, defaultNetworkClient (startup-probe + probeQuota param default),
  // and host-only modules with no package home (auth, headers, quota-cache/
  // broadcast, model-label, list-models, preflight, session-restore, media).
  // See reports/D-anthropic.md.
  ["llm-anthropic/adapter.broadcast.test.ts", 3], // [surfaced by FIX-i3] +1: multi-line clause
  ["llm-anthropic/adapter.preflight.test.ts", 2],
  ["llm-anthropic/adapter.ts", 5], // dropped client/list-models import (provider-decoupling final wave)
  ["llm-anthropic/anthropic.test.ts", 3], // [surfaced by FIX-i3] +1: multi-line clause
  ["llm-anthropic/beta-flags.characterization.test.ts", 2],
  ["llm-anthropic/beta-flags.ts", 2],
  ["llm-anthropic/beta-gates.ts", 1],
  ["llm-anthropic/bootstrap.ts", 3],
  ["llm-anthropic/forked-session.e2e.test.ts", 3],
  ["llm-anthropic/headers.ts", 2],
  ["llm-anthropic/list-models.ts", 3], // GET /v1/models moved out of core (provider-decoupling final wave)
  ["llm-anthropic/media-limits.ts", 1],
  ["llm-anthropic/models.ts", 3], // [surfaced by FIX-i3] +1: multi-line clause
  // [surfaced by FIX-i3] +2: two multi-line clauses (canonical-request type,
  // model-registry).
  ["llm-anthropic/opus-48-features.test.ts", 2],
  ["llm-anthropic/pricing.test.ts", 1],
  ["llm-anthropic/pricing.ts", 1],
  ["llm-anthropic/quota-probe.test.ts", 2],
  ["llm-anthropic/quota-probe.ts", 5],
  ["llm-anthropic/session-info.cache.test.ts", 1],
  ["llm-anthropic/session-info.ts", 4],
  ["llm-anthropic/system-prompt.ts", 1],
  ["llm-anthropic/thinking-preflight.test.ts", 1],
  ["llm-anthropic/thinking-preflight.ts", 2],
  ["llm-anthropic/validate.degrade.test.ts", 2],
  // [surfaced by FIX-i3] +1: multi-line `} from "../../src/headers.ts"`.
  ["llm-openai/adapter.ts", 3], // D-net-seam: network singleton → ctx.networkClient (port); classifyUpstreamError → plugin-api. Left: canonical-request, model-registry, provider.ts (all C-3 / port-split deferred)
  ["llm-openai/chat/request-body.ts", 2],
  ["llm-openai/models.ts", 1], // D-2: makeCharRatioEstimator → plugin-api. D-net-seam: registerModel now a ctx.models fallback (registrar adopted via register(ctx)); import drops to 0 once activateDiscoveredProviders is the live path (convergence)
  // [surfaced by FIX-i3] +1: multi-line `} from "../../src/llm/index.ts"`.
  ["llm-openai/openai.test.ts", 1],
  ["llm-openai/pricing.ts", 1],
  ["llm-openai/responses/request-body.ts", 2],
  // session-info.ts imports `announceQuotaRefresh` from src/quota-broadcast.ts
  // to emit `quota.headersReceived` after caching the provider's rate-limit
  // headers, so the `quota-status` footer repaints on EVERY turn instead of
  // only on its 5-minute heartbeat. Symmetric with `llm-anthropic/adapter.ts`,
  // which imports `broadcastResponseRateLimits` from the same module for the
  // identical reason. Drops to 0 once the bus emit is exposed as a ctx/host
  // capability (same convergence as the other quota-broadcast couplings).
  ["llm-openai/session-info.ts", 1],
  // Host-runtime integration test for the gpt-5.5 resume stall (session
  // 7919d877): it drives the REAL production stream pipeline end-to-end
  // (parseSse → translateOpenAIResponsesStream → withStreamWatchdog →
  // canonicalEventsToLegacyStream) over captured wire bytes to prove the
  // watchdog/keepalive + no-terminal-close fix. The two src/ imports
  // (transport/watchdog.ts, llm/adapter-legacy.ts) ARE the pipeline under
  // test, so they are not decouplable — same category as schedule/fire-e2e
  // and file-lock/integration.
  ["llm-openai/stall-repro.test.ts", 2],
  ["llm-openai/validate.ts", 3], // D-net-seam: errors + modality-check → plugin-api. Left: canonical-request, model-registry, provider.ts (all deferred)
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
  // D-usage-render: usage renderers + report shapes moved to plugin-api. The
  // remaining handler src/ import is the host usage DATA ENGINE
  // (scanUsageEvents / aggregate* / parseUsagePeriod), which scans the session
  // store + reads the model registry. It stays until a `usage:read` capability
  // exists.
  ["usage/handlers/cmd_usage.ts", 1],
  ["usage/lib/overlay.test.ts", 1],
  ["usage/lib/state.test.ts", 1],
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
