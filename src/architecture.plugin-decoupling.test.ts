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

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { countByFile, scanPluginSrcImports } from "./architecture/plugin-import-scan.ts"

const PLUGINS_ROOT = join(import.meta.dirname, "..", "plugins")

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
  ["file-lock/cli.test.ts", 1],
  ["file-lock/cli.ts", 2],
  // [surfaced by FIX-i3] +1: multi-line `} from "../../../src/file-lock.ts"`.
  ["file-lock/handlers/lock_status.test.ts", 1],
  // [surfaced by FIX-i3] 1→3: multi-line `} from "../../../src/file-lock.ts"`
  // clause plus `require("../../../src/config.ts")`.
  ["file-lock/handlers/lock_status.ts", 3],
  ["file-lock/integration.test.ts", 2],
  // D-quickwins: residual. This is a host-runtime integration test that drives
  // the REAL PluginLoader (`src/plugins/loader.ts`) end-to-end to prove the
  // plugin loads + wires through the live loader — that import IS the point of
  // the test, so it is not decouplable (same category as schedule/fire-e2e).
  ["history/integration.test.ts", 1],
  // Wave D-anthropic: §5 net/registry/pure-neutral re-point sweep (76→51).
  // Residual src sites are all blocked type families: canonical-request (C-3),
  // model-registry runtime + ModelEntry, provider.ts port (post-C-3), pricing
  // MTokRate, defaultNetworkClient (startup-probe + probeQuota param default),
  // and host-only modules with no package home (auth, headers, quota-cache/
  // broadcast, model-label, list-models, preflight, session-restore, media).
  // See reports/D-anthropic.md.
  ["llm-anthropic/adapter.broadcast.test.ts", 3], // [surfaced by FIX-i3] +1: multi-line clause
  ["llm-anthropic/adapter.preflight.test.ts", 2],
  ["llm-anthropic/adapter.ts", 6], // [surfaced by FIX-i3] +1: multi-line clause
  ["llm-anthropic/anthropic.test.ts", 3], // [surfaced by FIX-i3] +1: multi-line clause
  ["llm-anthropic/beta-flags.characterization.test.ts", 3],
  ["llm-anthropic/beta-flags.ts", 2],
  ["llm-anthropic/beta-gates.ts", 1],
  ["llm-anthropic/bootstrap.ts", 3],
  ["llm-anthropic/forked-session.e2e.test.ts", 3],
  ["llm-anthropic/headers.ts", 2],
  ["llm-anthropic/media-limits.ts", 1],
  ["llm-anthropic/models.ts", 3], // [surfaced by FIX-i3] +1: multi-line clause
  // [surfaced by FIX-i3] +2: two multi-line clauses (canonical-request type,
  // model-registry).
  ["llm-anthropic/opus-48-features.test.ts", 2],
  ["llm-anthropic/quota-probe.test.ts", 2],
  ["llm-anthropic/quota-probe.ts", 5],
  ["llm-anthropic/request-body.ts", 2],
  ["llm-anthropic/session-info.cache.test.ts", 1],
  ["llm-anthropic/session-info.ts", 4],
  ["llm-anthropic/system-prompt.ts", 1],
  ["llm-anthropic/thinking-preflight.test.ts", 1],
  ["llm-anthropic/thinking-preflight.ts", 2],
  ["llm-anthropic/validate.degrade.test.ts", 2],
  ["llm-anthropic/validate.ts", 3],
  // [surfaced by FIX-i3] +1: multi-line `} from "../../src/headers.ts"`.
  ["llm-anthropic/wire-constants.ts", 1],
  ["llm-openai/adapter.ts", 3], // D-net-seam: network singleton → ctx.networkClient (port); classifyUpstreamError → plugin-api. Left: canonical-request, model-registry, provider.ts (all C-3 / port-split deferred)
  ["llm-openai/chat/request-body.ts", 2],
  ["llm-openai/models.ts", 1], // D-2: makeCharRatioEstimator → plugin-api. D-net-seam: registerModel now a ctx.models fallback (registrar adopted via register(ctx)); import drops to 0 once activateDiscoveredProviders is the live path (convergence)
  // [surfaced by FIX-i3] +1: multi-line `} from "../../src/llm/index.ts"`.
  ["llm-openai/openai.test.ts", 1],
  ["llm-openai/pricing.ts", 1],
  ["llm-openai/responses/request-body.ts", 2],
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
  ["llm-openrouter/adapter.ts", 4],
  ["llm-openrouter/models.ts", 1], // D-2: makeCharRatioEstimator → @minimal-agent/plugin-api; registerModel stays (no-arg register())
  ["llm-openrouter/openrouter.test.ts", 2], // [surfaced by FIX-i3] +1: multi-line clause
  ["llm-openrouter/pricing.ts", 1],
  // Pre-existing provider plugin — needs src/ imports for model registration,
  // canonical request types, and pricing (host-side types not yet in plugin-api).
  ["llm-opencode/adapter.ts", 4],
  ["llm-opencode/models.ts", 2],
  ["llm-opencode/opencode.test.ts", 2],
  ["llm-opencode/pricing.ts", 1],
  // Wafer provider plugin — same pre-existing provider pattern as llm-opencode
  // and llm-openrouter: needs src/ imports for model registration, canonical
  // request types, pricing types, provider adapter types, network client, and
  // session-info (resolveModel, modelShortLabel). Tests drive real registries.
  ["llm-wafer/adapter.ts", 4],
  ["llm-wafer/models.ts", 1],
  ["llm-wafer/pricing.ts", 1],
  ["llm-wafer/session-info.ts", 3],
  ["llm-wafer/wafer-disambiguation.test.ts", 1],
  ["llm-wafer/wafer-dispatch.test.ts", 6],
  ["llm-wafer/wafer.test.ts", 3],
  // Wave D-7: memory swept to its residual. Only summarize.ts keeps two
  // src/ sites — the summary pipeline needs an authenticated LLM call at
  // prompt-fragment time (getAuth + canonicalSendFn) and there is no
  // `auth`/`llm:send` capability on the plugin host yet, nor a `ctx.host` on
  // the prompt-fragment context. See reports/D7-memory.md.
  ["memory/lib/summarize.ts", 2],
  // D-quota-schedule: render.ts/render*.test.ts/script-runner.ts swept to 0
  // (QuotaWindow → plugin-api/llm/provider-plugin; stripAnsi/displayWidth →
  // plugin-api/utils/term-width; SessionTokens → local structural slice; the
  // `c` palette wrappers → local module over plugin-api/utils/palette;
  // parseFormatterCommand inlined). handler.ts keeps 3: it is a live-area slot
  // whose ctx has NO `ctx.host`, and there is no config / session-tokens /
  // provider-session capability — loadUserConfig, getSessionTokens, and
  // resolveProviderSessionInfo stay host imports until such a seam exists.
  ["quota-status/handler.ts", 3],
  // Integration test driving the real provider registries end-to-end to prove
  // provider-scoped model resolution (the deepseek-v4-flash disambiguation fix).
  ["quota-status/render.provider-scoping.test.ts", 3],
  // D-quota-schedule: the two host-runtime integration tests keep their src/
  // imports — they drive the REAL PluginLoader / REPL / Compositor / agent
  // run() end-to-end, which is the whole point of the test, so they are not
  // decouplable. Every other schedule file swept to 0 (TUIContext/TUIResult/
  // CommandContext/CommandResult/LiveAreaHandlerContext → plugin-api/types/
  // plugin; PALETTE → plugin-api/utils/palette; displayWidth → plugin-api/
  // utils/term-width).
  ["schedule/fire-e2e.test.ts", 6],
  ["schedule/load.test.ts", 1],
  // D-quickwins: resolveModel → ctx.host.models.resolve (models:read; manifest
  // grants it). The remaining 2 are residual: resolveProviderSessionInfo
  // (provider-session) + getSessionTokens (session-tokens) have NO capability
  // on the plugin host (same gap as quota-status/handler.ts), so they stay until a
  // session-tokens / provider-session seam exists.
  ["session-info/lib/gather.ts", 2],
  // D-usage-render: usage renderers + report shapes moved to plugin-api. The
  // remaining handler src/ import is the host usage DATA ENGINE
  // (scanUsageEvents / aggregate* / parseUsagePeriod), which scans the session
  // store + reads the model registry. It stays until a `usage:read` capability
  // exists.
  ["usage/handlers/cmd_usage.ts", 1],
  ["usage/lib/overlay.test.ts", 1],
  ["usage/lib/state.test.ts", 1],
  // D-quickwins: residual. `brave.ts` imports `retry` + `type RetryOptions`
  // from `src/retry.ts`. That module is PURE (zero host state, injectable
  // sleep/now/random) and belongs in `@minimal-agent/plugin-api/utils/retry`,
  // but no such export exists yet and plugin-api/ is out of this unit's
  // allowlist. Re-point mechanically once a plugin-api unit adds the export
  // (trivial pure-util move). Inlining a 250-line fork here was rejected as a
  // maintenance/behavior risk, not a mechanical re-point.
  ["web-search/providers/brave.ts", 1],
])

describe("architecture: plugin decoupling (plugins never import src/)", () => {
  const counts = countByFile(scanPluginSrcImports(PLUGINS_ROOT))

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
