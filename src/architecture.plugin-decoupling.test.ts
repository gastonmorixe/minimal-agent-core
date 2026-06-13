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
 * `src/plugins/v2/host-capabilities.ts` for the capability-host design that
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
 */
const BASELINE = new Map<string, number>([
  ["diagnostics/lib/structural-contract.test.ts", 1],
  ["file-lock/cli.test.ts", 1],
  ["file-lock/cli.ts", 2],
  ["file-lock/handlers/lock_status.ts", 1],
  ["file-lock/integration.test.ts", 2],
  ["history/integration.test.ts", 1],
  ["llm-anthropic/adapter.broadcast.test.ts", 4], // committed in 5d12dc0 (quota footer fix); Wave D-5 sweeps to 0
  ["llm-anthropic/adapter.preflight.test.ts", 2],
  ["llm-anthropic/adapter.ts", 10], // 9→10 in 5d12dc0 (quota footer fix); Wave D-5 sweeps to 0
  ["llm-anthropic/anthropic.test.ts", 4],
  ["llm-anthropic/beta-flags.characterization.test.ts", 3],
  ["llm-anthropic/beta-flags.ts", 2],
  ["llm-anthropic/beta-gates.ts", 1],
  ["llm-anthropic/bootstrap.ts", 4],
  ["llm-anthropic/capabilities.ts", 2],
  ["llm-anthropic/forked-session.e2e.test.ts", 3],
  ["llm-anthropic/headers.ts", 3],
  ["llm-anthropic/media-limits.ts", 1],
  ["llm-anthropic/models.ts", 3],
  ["llm-anthropic/quota-probe.test.ts", 3],
  ["llm-anthropic/quota-probe.ts", 5],
  ["llm-anthropic/request-body.ts", 7],
  ["llm-anthropic/session-info.cache.test.ts", 1],
  ["llm-anthropic/session-info.ts", 5],
  ["llm-anthropic/system-prompt.ts", 1],
  ["llm-anthropic/thinking-preflight.test.ts", 2],
  ["llm-anthropic/thinking-preflight.ts", 3],
  ["llm-anthropic/validate.degrade.test.ts", 2],
  ["llm-anthropic/validate.ts", 5],
  ["llm-openai/adapter.ts", 5],
  ["llm-openai/chat/request-body.ts", 2],
  ["llm-openai/models.ts", 1], // D-2: makeCharRatioEstimator → @minimal-agent/plugin-api; registerModel stays (no-arg register())
  ["llm-openai/pricing.ts", 1],
  ["llm-openai/responses/request-body.ts", 2],
  ["llm-openai/responses/response-stream.ts", 1],
  ["llm-openai/validate.ts", 5],
  ["llm-openrouter/adapter.ts", 4],
  ["llm-openrouter/models.ts", 1], // D-2: makeCharRatioEstimator → @minimal-agent/plugin-api; registerModel stays (no-arg register())
  ["llm-openrouter/openrouter.test.ts", 1],
  ["llm-openrouter/pricing.ts", 1],
  ["memory/handlers/load.test.ts", 1],
  ["memory/handlers/load.ts", 1],
  ["memory/handlers/memory_tool.test.ts", 1],
  ["memory/handlers/memory_tool.ts", 1],
  ["memory/handlers/memory.test.ts", 4],
  ["memory/handlers/memory.ts", 2],
  ["memory/integration.test.ts", 2],
  ["memory/lib/memory-config.ts", 2],
  ["memory/lib/save-echo.test.ts", 1],
  ["memory/lib/save-echo.ts", 2],
  ["memory/lib/short-term-snapshot.ts", 1],
  ["memory/lib/summarize.test.ts", 2],
  ["memory/lib/summarize.ts", 5],
  ["memory/lib/summary-refresh.ts", 1],
  ["quota-status/handler.ts", 4],
  ["quota-status/render.overage.test.ts", 3],
  ["quota-status/render.segments.test.ts", 3],
  ["quota-status/render.test.ts", 2],
  ["quota-status/render.ts", 4],
  ["quota-status/script-runner.ts", 1],
  ["schedule/fire-e2e.test.ts", 6],
  ["schedule/handlers/cmd_loop.ts", 1],
  ["schedule/handlers/cmd_schedule.ts", 1],
  ["schedule/handlers/cron_create.ts", 1],
  ["schedule/handlers/cron_delete.ts", 1],
  ["schedule/handlers/cron_list.ts", 1],
  ["schedule/handlers/heartbeat.ts", 1],
  ["schedule/lib/box.ts", 1],
  ["schedule/lib/footer.test.ts", 2],
  ["schedule/lib/footer.ts", 2],
  ["schedule/load.test.ts", 1],
  ["session-info/lib/gather.ts", 3],
  ["usage/handlers/cmd_usage.ts", 1],
  ["usage/lib/overlay.test.ts", 1],
  ["usage/lib/overlay.ts", 2],
  ["usage/lib/state.test.ts", 1],
  ["usage/lib/state.ts", 1],
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
