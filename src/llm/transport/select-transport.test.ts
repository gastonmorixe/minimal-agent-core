/**
 * Tests for the default transport selector (pickTransport).
 *
 * Pins the provider-conditional routing + the env escape hatch by function
 * identity, without a network: Anthropic → legacy sendMessage, others →
 * canonicalSendFn, with "off"/"all" overrides and a safe legacy fallback
 * for unresolved ids.
 *
 * @module llm/transport/select-transport.test
 */

import { beforeAll, describe, expect, it } from "bun:test"

import { bootstrapAnthropic } from "../../../plugins/llm-anthropic/adapter.ts"
import { bootstrapOpenAI } from "../../../plugins/llm-openai/adapter.ts"
import { bootstrapOpenRouter } from "../../../plugins/llm-openrouter/adapter.ts"
import { sendMessage } from "../../client.ts"

import { canonicalSendFn } from "./canonical-send.ts"
import { pickTransport } from "./select-transport.ts"

beforeAll(() => {
  bootstrapAnthropic()
  bootstrapOpenAI()
  bootstrapOpenRouter()
})

describe("pickTransport", () => {
  it("auto: Anthropic models use the legacy sendMessage", () => {
    expect(pickTransport("claude-opus-4-8", "auto")).toBe(sendMessage)
    expect(pickTransport("claude-opus-4-8[1m]", "auto")).toBe(sendMessage)
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

  it("all: forces canonical for every model (incl. Anthropic, for Phase 4)", () => {
    expect(pickTransport("claude-opus-4-8", "all")).toBe(canonicalSendFn)
    expect(pickTransport("gpt-5.5", "all")).toBe(canonicalSendFn)
  })
})
