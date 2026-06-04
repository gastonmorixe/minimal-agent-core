import { describe, expect, it } from "bun:test"

import { DEFAULT_POLICY } from "./guard.ts"
import {
  resolveAgentBin,
  resolveAutoTier,
  resolveDepth,
  resolveModelOverride,
  resolvePolicy,
  resolveTokenBudget,
} from "./runtime.ts"

describe("resolveAgentBin", () => {
  it("prefers MINIMAL_AGENT_BIN (split on whitespace)", () => {
    expect(resolveAgentBin({ MINIMAL_AGENT_BIN: "bun run /x/index.ts" }, [])).toEqual([
      "bun",
      "run",
      "/x/index.ts",
    ])
  })
  it("falls back to [execPath, entry]", () => {
    expect(resolveAgentBin({}, ["/usr/bin/bun", "/repo/src/index.ts", "--flag"])).toEqual([
      "/usr/bin/bun",
      "/repo/src/index.ts",
    ])
  })
})

describe("resolveDepth", () => {
  it("0 by default; reads the depth env marker", () => {
    expect(resolveDepth({})).toBe(0)
    expect(resolveDepth({ MINIMAL_AGENT_SUBAGENT_DEPTH: "2" })).toBe(2)
    expect(resolveDepth({ MINIMAL_AGENT_SUBAGENT_DEPTH: "junk" })).toBe(0)
  })
})

describe("resolveModelOverride", () => {
  it("is empty by default (model-agnostic: NO hardcoded SKU fallback)", () => {
    expect(resolveModelOverride({})).toBe("")
  })
  it("honors the explicit env override", () => {
    expect(resolveModelOverride({ MINIMAL_AGENT_SUBAGENT_MODEL: "gpt-5.5" })).toBe("gpt-5.5")
    expect(resolveModelOverride({ MINIMAL_AGENT_SUBAGENT_MODEL: "claude-opus-4-8" })).toBe(
      "claude-opus-4-8",
    )
  })
  it("treats whitespace-only as unset", () => {
    expect(resolveModelOverride({ MINIMAL_AGENT_SUBAGENT_MODEL: "   " })).toBe("")
  })
})

describe("resolveAutoTier", () => {
  it("is OFF by default (workers inherit the lead's model, no downgrade)", () => {
    expect(resolveAutoTier({})).toBe(false)
  })
  it("is ON only for the exact opt-in value", () => {
    expect(resolveAutoTier({ MINIMAL_AGENT_SUBAGENT_AUTO_TIER: "1" })).toBe(true)
    expect(resolveAutoTier({ MINIMAL_AGENT_SUBAGENT_AUTO_TIER: "0" })).toBe(false)
    expect(resolveAutoTier({ MINIMAL_AGENT_SUBAGENT_AUTO_TIER: "true" })).toBe(false)
  })
})

describe("resolvePolicy", () => {
  it("returns the defaults with no env", () => {
    expect(resolvePolicy({})).toEqual(DEFAULT_POLICY)
  })
  it("raises caps for extreme fleets via env", () => {
    const p = resolvePolicy({
      MINIMAL_AGENT_SUBAGENT_MAX_CONCURRENT: "64",
      MINIMAL_AGENT_SUBAGENT_MAX_TOTAL: "500",
      MINIMAL_AGENT_SUBAGENT_MAX_DEPTH: "3",
    })
    expect(p).toEqual({ maxDepth: 3, maxConcurrent: 64, maxTotal: 500 })
  })
  it("ignores non-positive / junk overrides (keeps the default)", () => {
    expect(resolvePolicy({ MINIMAL_AGENT_SUBAGENT_MAX_CONCURRENT: "0" }).maxConcurrent).toBe(
      DEFAULT_POLICY.maxConcurrent,
    )
    expect(resolvePolicy({ MINIMAL_AGENT_SUBAGENT_MAX_TOTAL: "nope" }).maxTotal).toBe(
      DEFAULT_POLICY.maxTotal,
    )
  })
})

describe("resolveTokenBudget", () => {
  it("defaults to 200k; honors override", () => {
    expect(resolveTokenBudget({})).toBe(200_000)
    expect(resolveTokenBudget({ MINIMAL_AGENT_SUBAGENT_TOKEN_BUDGET: "1000000" })).toBe(1_000_000)
  })
})
