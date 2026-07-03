/**
 * `usage:read` capability (Wave G).
 *
 * Verifies the host factory grants `ctx.host.usage` ONLY when the capability
 * is declared, and that `report(period)` / `reports()` fold token usage from
 * the (host-owned) session scan into the neutral {@link UsageReport} shape.
 * This is the seam that lets the `usage` plugin render the `/usage` overlay
 * without importing `scanUsageEvents` / `aggregateUsage` from `src/` (which
 * reach the pricing table + model registry + session store).
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { USAGE_PERIODS } from "@minimal-agent/plugin-api/utils/usage-report"

import { buildPluginHost } from "./factory.ts"

let dir: string

beforeEach(() => {
  // An empty sessions dir → zero events → zeroed reports, no disk coupling.
  dir = mkdtempSync(join(tmpdir(), "usage-cap-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("plugin host: usage capability", () => {
  it("is undefined when not granted (deny-by-default)", () => {
    const host = buildPluginHost({ capabilities: [], sessionsDir: dir })
    expect(host.usage).toBeUndefined()
  })

  it("usage:read populates host.usage with report + reports", () => {
    const host = buildPluginHost({ capabilities: ["usage:read"], sessionsDir: dir })
    expect(host.usage).toBeDefined()
    expect(typeof host.usage?.report).toBe("function")
    expect(typeof host.usage?.reports).toBe("function")
  })

  it("report(period) folds one period (empty store → zeroed totals)", () => {
    const host = buildPluginHost({ capabilities: ["usage:read"], sessionsDir: dir })
    const r = host.usage?.report("all")
    expect(r?.period).toBe("all")
    expect(r?.totals.tokens).toBe(0)
    expect(r?.totals.turns).toBe(0)
    expect(r?.byProvider).toEqual([])
    expect(r?.byModel).toEqual([])
    expect(r?.estimated).toBe(false)
  })

  it("reports() returns one report per known period from a single scan", () => {
    const host = buildPluginHost({ capabilities: ["usage:read"], sessionsDir: dir })
    const all = host.usage?.reports()
    expect(all).toBeDefined()
    for (const { id } of USAGE_PERIODS) {
      expect(all?.[id]?.period).toBe(id)
      expect(all?.[id]?.totals.tokens).toBe(0)
    }
  })
})
