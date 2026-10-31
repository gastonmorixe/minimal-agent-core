/**
 * Tests for the default transport selector.
 *
 * There is one transport for every model: the canonical `run()`-backed
 * `canonicalAttemptFn` (one attempt; the agent loop owns retries).
 * `pickTransport` and `selectedTransport` both resolve to it regardless of
 * model id. The agent loop never chooses a transport by provider.
 */

import { describe, expect, it } from "bun:test"

import { canonicalAttemptFn } from "./canonical-send.ts"
import { pickTransport, selectedTransport } from "./select-transport.ts"

describe("pickTransport", () => {
  it("returns the canonical transport for any model id", () => {
    expect(pickTransport("some-model")).toBe(canonicalAttemptFn)
    expect(pickTransport("some-model[1m]")).toBe(canonicalAttemptFn)
    expect(pickTransport("gateway/upstream-model")).toBe(canonicalAttemptFn)
  })

  it("returns the canonical transport when no model id is given", () => {
    expect(pickTransport(undefined)).toBe(canonicalAttemptFn)
    expect(pickTransport()).toBe(canonicalAttemptFn)
  })
})

describe("selectedTransport", () => {
  it("is the canonical transport", () => {
    expect(selectedTransport).toBe(canonicalAttemptFn)
  })
})
