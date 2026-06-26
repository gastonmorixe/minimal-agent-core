/**
 * Tests for the default transport selector.
 *
 * There is one transport for every model: the canonical `run()`-backed
 * `canonicalSendFn`. `pickTransport` and `selectedTransport` both resolve to
 * it regardless of model id. The agent loop never chooses a transport by
 * provider.
 */

import { describe, expect, it } from "bun:test"

import { canonicalSendFn } from "./canonical-send.ts"
import { pickTransport, selectedTransport } from "./select-transport.ts"

describe("pickTransport", () => {
  it("returns the canonical transport for any model id", () => {
    expect(pickTransport("some-model")).toBe(canonicalSendFn)
    expect(pickTransport("some-model[1m]")).toBe(canonicalSendFn)
    expect(pickTransport("gateway/upstream-model")).toBe(canonicalSendFn)
  })

  it("returns the canonical transport when no model id is given", () => {
    expect(pickTransport(undefined)).toBe(canonicalSendFn)
    expect(pickTransport()).toBe(canonicalSendFn)
  })
})

describe("selectedTransport", () => {
  it("is the canonical transport", () => {
    expect(selectedTransport).toBe(canonicalSendFn)
  })
})
