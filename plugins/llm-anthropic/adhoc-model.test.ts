/**
 * Ad-hoc Anthropic model registration.
 *
 * Pins the {@link ProviderPlugin.registerAdHocModel} behavior: an uncataloged
 * Claude id (a SKU newer than this build) must synthesize a registry entry with
 * the capability + pricing profile of its closest known family sibling, so
 * `--model <new-id>` boots instead of failing with "unknown model".
 *
 * Uses an in-memory fake {@link ModelRegistrar} (capturing the registered spec)
 * rather than the global registry, so the test is pure and adds no plugin-to-src
 * import.
 *
 * @module llm/providers/anthropic/adhoc-model.test
 */

import { beforeEach, describe, expect, it } from "bun:test"

import type {
  ModelRegistrar,
  ProviderModelSpec,
} from "@minimal-agent/plugin-api/llm/provider-plugin"

import { registerAnthropicAdHocModelInto } from "./models.ts"

/** A registrar that records every registered spec by id, no global mutation. */
function fakeRegistrar(): ModelRegistrar & { specs: Map<string, ProviderModelSpec> } {
  const specs = new Map<string, ProviderModelSpec>()
  return {
    specs,
    register: (spec: ProviderModelSpec) => {
      specs.set(spec.id, spec)
    },
    setDefault: () => {},
  }
}

describe("registerAnthropicAdHocModelInto", () => {
  let reg: ReturnType<typeof fakeRegistrar>
  beforeEach(() => {
    reg = fakeRegistrar()
  })

  it("synthesizes a sonnet-class entry (1M context) for an unknown sonnet id", () => {
    const id = registerAnthropicAdHocModelInto(reg, "claude-sonnet-6")
    expect(id).toBe("claude-sonnet-6")
    const m = reg.specs.get("claude-sonnet-6")
    expect(m).toBeDefined()
    expect(m?.providerId).toBe("anthropic")
    expect(m?.surfaceId).toBe("anthropic-messages")
    expect(m?.capabilities.contextWindow).toBe(1_000_000)
    expect(m?.tags).toContain("adhoc")
    expect(m?.tags).toContain("sonnet")
  })

  it("defaults an id naming no known family to the sonnet profile", () => {
    registerAnthropicAdHocModelInto(reg, "claude-zephyr-1")
    const m = reg.specs.get("claude-zephyr-1")
    expect(m?.capabilities.contextWindow).toBe(1_000_000)
    expect(m?.tags).toContain("sonnet")
  })

  it("synthesizes an opus-class entry with opus pricing for an unknown opus id", () => {
    registerAnthropicAdHocModelInto(reg, "claude-opus-5-0")
    const m = reg.specs.get("claude-opus-5-0")
    expect(m?.tags).toContain("opus")
    // Opus standard rate: $5 / $25 per Mtok.
    expect(m?.pricing.inputUSD).toBe(5)
    expect(m?.pricing.outputUSD).toBe(25)
  })

  it("synthesizes a haiku-class entry with haiku pricing for an unknown haiku id", () => {
    registerAnthropicAdHocModelInto(reg, "claude-haiku-5")
    const m = reg.specs.get("claude-haiku-5")
    expect(m?.tags).toContain("haiku")
    expect(m?.pricing.inputUSD).toBe(1)
    expect(m?.pricing.outputUSD).toBe(5)
  })

  it("strips a [1m] suffix to the bare canonical id and keeps it as an alias", () => {
    const id = registerAnthropicAdHocModelInto(reg, "claude-sonnet-6[1m]")
    expect(id).toBe("claude-sonnet-6")
    const m = reg.specs.get("claude-sonnet-6")
    expect(m).toBeDefined()
    expect(m?.aliases).toContain("claude-sonnet-6[1m]")
  })

  it("marks the displayName as ad-hoc so it is visibly distinct from a catalog entry", () => {
    registerAnthropicAdHocModelInto(reg, "claude-sonnet-6")
    expect(reg.specs.get("claude-sonnet-6")?.displayName).toContain("ad-hoc")
  })

  it("returns the bare id (idempotent input → stable canonical id)", () => {
    expect(registerAnthropicAdHocModelInto(reg, "claude-sonnet-6")).toBe("claude-sonnet-6")
    expect(registerAnthropicAdHocModelInto(reg, "claude-sonnet-6")).toBe("claude-sonnet-6")
  })
})
