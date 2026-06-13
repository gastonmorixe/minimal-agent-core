/**
 * Tests for the default transport selector (pickTransport).
 *
 * Post-flip (Wave B unit B-0, PLAN.md §2): the CANONICAL transport is the
 * default for EVERY registered model — Anthropic included. Pins, by function
 * identity and without a network:
 *
 *   - auto: registered models (any provider) → canonicalSendFn
 *   - auto: unregistered / missing ids → legacy sendMessage (safe default,
 *     a genuinely bad id fails the same way it used to)
 *   - off / "all" mode overrides
 *   - MINIMAL_AGENT_LEGACY_TRANSPORT=1 → legacy for everything (the B-0
 *     rollback escape hatch), proven BOTH ways (set → legacy; unset →
 *     canonical default), and absolute (wins over
 *     MINIMAL_AGENT_CANONICAL_TRANSPORT=all).
 *
 * @module llm/transport/select-transport.test
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test"

import { sendMessage } from "../../client.ts"
import { registerTestProvider } from "../test-fixtures.ts"

import { canonicalSendFn } from "./canonical-send.ts"
import { pickTransport, transportMode } from "./select-transport.ts"

beforeAll(() => {
  // Synthetic registrations replace the real adapter bootstraps (I2: core
  // tests never import plugins/). pickTransport's contract only needs the
  // ids to RESOLVE in the registry — which provider owns them is
  // irrelevant to transport selection, so one fake provider carries the
  // whole multi-vendor id set the flip pins below exercise.
  registerTestProvider({
    id: "test-prov",
    models: [
      { id: "claude-opus-4-8", aliases: ["claude-opus-4-8[1m]"] },
      { id: "gpt-5.5" },
      { id: "gpt-4o" },
      { id: "anthropic/claude-3.5-sonnet" },
    ],
  })
})

describe("pickTransport", () => {
  it("auto: Anthropic models use the canonical transport (the B-0 flip)", () => {
    expect(pickTransport("claude-opus-4-8", "auto")).toBe(canonicalSendFn)
    expect(pickTransport("claude-opus-4-8[1m]", "auto")).toBe(canonicalSendFn)
  })

  it("auto: non-Anthropic models use the canonical transport", () => {
    expect(pickTransport("gpt-5.5", "auto")).toBe(canonicalSendFn)
    expect(pickTransport("gpt-4o", "auto")).toBe(canonicalSendFn)
    expect(pickTransport("anthropic/claude-3.5-sonnet", "auto")).toBe(canonicalSendFn) // openrouter
  })

  it("auto: an unknown / unregistered model falls back to legacy (prior behavior)", () => {
    expect(pickTransport("totally-unknown-model", "auto")).toBe(sendMessage)
    expect(pickTransport(undefined, "auto")).toBe(sendMessage)
  })

  it("off: forces legacy for every model (emergency revert)", () => {
    expect(pickTransport("gpt-5.5", "off")).toBe(sendMessage)
    expect(pickTransport("claude-opus-4-8", "off")).toBe(sendMessage)
  })

  it("all: forces canonical for every model", () => {
    expect(pickTransport("claude-opus-4-8", "all")).toBe(canonicalSendFn)
    expect(pickTransport("gpt-5.5", "all")).toBe(canonicalSendFn)
  })
})

describe("MINIMAL_AGENT_LEGACY_TRANSPORT escape hatch (B-0 rollback)", () => {
  const LEGACY = "MINIMAL_AGENT_LEGACY_TRANSPORT"
  const CANONICAL = "MINIMAL_AGENT_CANONICAL_TRANSPORT"
  let prevLegacy: string | undefined
  let prevCanonical: string | undefined

  beforeEach(() => {
    prevLegacy = process.env[LEGACY]
    prevCanonical = process.env[CANONICAL]
    delete process.env[LEGACY]
    delete process.env[CANONICAL]
  })

  afterEach(() => {
    if (prevLegacy === undefined) delete process.env[LEGACY]
    else process.env[LEGACY] = prevLegacy
    if (prevCanonical === undefined) delete process.env[CANONICAL]
    else process.env[CANONICAL] = prevCanonical
  })

  it("=1 maps the mode to 'off' and routes EVERY model back to legacy", () => {
    process.env[LEGACY] = "1"
    expect(transportMode()).toBe("off")
    // No explicit mode arg: pickTransport reads the env via transportMode().
    expect(pickTransport("claude-opus-4-8")).toBe(sendMessage)
    expect(pickTransport("gpt-5.5")).toBe(sendMessage)
  })

  it("unset: the default stays canonical for registered models (the other way)", () => {
    expect(transportMode()).toBe("auto")
    expect(pickTransport("claude-opus-4-8")).toBe(canonicalSendFn)
    expect(pickTransport("gpt-5.5")).toBe(canonicalSendFn)
  })

  it("values other than '1' do not engage the escape hatch", () => {
    process.env[LEGACY] = "0"
    expect(transportMode()).toBe("auto")
    process.env[LEGACY] = ""
    expect(transportMode()).toBe("auto")
  })

  it("wins over MINIMAL_AGENT_CANONICAL_TRANSPORT=all (the revert is absolute)", () => {
    process.env[LEGACY] = "1"
    process.env[CANONICAL] = "all"
    expect(transportMode()).toBe("off")
    expect(pickTransport("claude-opus-4-8")).toBe(sendMessage)
  })
})
