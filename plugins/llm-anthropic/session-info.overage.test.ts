/**
 * Anthropic overage parsing → neutral `QuotaSnapshot.overage` DTO.
 *
 * `parseAnthropicOverage` maps the raw
 * `anthropic-ratelimit-unified-overage-status` header to the
 * provider-neutral `{ active }` shape, and never adds an
 * overage pseudo-window to `parseAnthropicQuotaWindows` (overage has no
 * utilization).
 *
 * @module llm-anthropic/session-info.overage.test
 */

import { describe, expect, it } from "bun:test"

import { parseAnthropicOverage, parseAnthropicQuotaWindows } from "./session-info.ts"

describe("parseAnthropicOverage", () => {
  it("maps 'off' → { active: false }", () => {
    const rl = new Map([["anthropic-ratelimit-unified-overage-status", "off"]])
    expect(parseAnthropicOverage(rl)).toEqual({ active: false })
  })

  it("maps 'allowed' → { active: true }", () => {
    const rl = new Map([["anthropic-ratelimit-unified-overage-status", "allowed"]])
    expect(parseAnthropicOverage(rl)).toEqual({ active: true })
  })

  it("returns undefined when the overage header is absent", () => {
    const rl = new Map([["anthropic-ratelimit-unified-5h-utilization", "0.10"]])
    expect(parseAnthropicOverage(rl)).toBeUndefined()
  })

  it("treats any non-'allowed' value as inactive", () => {
    const rl = new Map([["anthropic-ratelimit-unified-overage-status", "denied"]])
    expect(parseAnthropicOverage(rl)).toEqual({ active: false })
  })
})

describe("parseAnthropicQuotaWindows — overage is never a window", () => {
  it("drops the overage pseudo-entry from windows", () => {
    const rl = new Map([
      ["anthropic-ratelimit-unified-5h-utilization", "0.21"],
      ["anthropic-ratelimit-unified-7d-utilization", "0.08"],
      ["anthropic-ratelimit-unified-overage-status", "off"],
    ])
    const wins = parseAnthropicQuotaWindows(rl)
    expect(wins.map((w) => w.id)).toEqual(["5h", "7d"])
    expect(wins.some((w) => w.id === "overage")).toBe(false)
  })
})
