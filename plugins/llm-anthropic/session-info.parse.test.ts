/**
 * `parseAnthropicQuotaWindows` header-parsing characterization.
 *
 * Moved from `src/llm/provider-session.test.ts` (Wave A unit A-5, PLAN.md):
 * the parser is Anthropic wire knowledge (`anthropic-ratelimit-unified-*`
 * header grammar), so its pins live with the provider, not in core.
 *
 * @module llm/providers/anthropic/session-info.parse.test
 */

import { describe, expect, it } from "bun:test"

import { parseAnthropicQuotaWindows } from "./session-info.ts"

describe("parseAnthropicQuotaWindows", () => {
  it("parses unified-window utilization + reset, drops synthetic windows, sorts 5h/7d", () => {
    const rl = new Map<string, string>([
      ["anthropic-ratelimit-unified-7d-utilization", "0.08"],
      ["anthropic-ratelimit-unified-5h-utilization", "0.21"],
      ["anthropic-ratelimit-unified-5h-reset", "1777000000"],
      ["anthropic-ratelimit-unified-fallback-utilization", "0.99"],
      ["anthropic-ratelimit-unified-representative-utilization", "0.5"],
      ["anthropic-ratelimit-unified-overage-utilization", "0.0"],
    ])
    const wins = parseAnthropicQuotaWindows(rl)
    expect(wins.map((w) => w.id)).toEqual(["5h", "7d"])
    expect(wins[0]?.utilization).toBeCloseTo(0.21)
    expect(wins[0]?.resetAtMs).toBe(1777000000 * 1000)
  })

  it("returns [] for an empty / non-quota header map", () => {
    expect(parseAnthropicQuotaWindows(new Map())).toEqual([])
  })
})
