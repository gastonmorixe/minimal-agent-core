/**
 * Smoke test: the quota cluster of `./host/*` subpaths resolves and works
 * through the package name.
 *
 * @module host-public/quota.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { formatQuotaWindows } from "@minimal-agent/core/host/quota-summary"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { aggregateUsage, collectSessionEvents } from "@minimal-agent/core/host/usage-stats"

describe("./host/* quota cluster (public subpaths)", () => {
  it("./host/quota-summary: renders nothing for an empty window list", () => {
    expect(formatQuotaWindows([])).toBe("")
  })

  it("./host/usage-stats: aggregates zero events to an empty report", () => {
    expect(collectSessionEvents([])).toEqual([])
    const report = aggregateUsage([], "all", Date.now())
    expect(report.totals.turns).toBe(0)
  })
})
