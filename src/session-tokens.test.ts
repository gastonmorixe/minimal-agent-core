/**
 * Tests for the session-tokens accumulator. Pinned to a stable shape
 * because the `quota-status` plugin reads `getSessionTokens()` to render
 * the footer.
 */

import { afterEach, describe, expect, it } from "bun:test"
import { addSessionUsage, clearSessionTokens, getSessionTokens } from "./session-tokens.ts"

afterEach(() => clearSessionTokens())

describe("session-tokens", () => {
  it("starts at zero with zero turns", () => {
    const t = getSessionTokens()
    expect(t).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
      total: 0,
      turns: 0,
    })
  })

  it("accumulates each field across turns", () => {
    addSessionUsage({
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5,
    })
    addSessionUsage({
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 0,
    })
    const t = getSessionTokens()
    expect(t.input).toBe(11)
    expect(t.output).toBe(22)
    expect(t.cacheRead).toBe(33)
    expect(t.cacheCreate).toBe(5)
    expect(t.total).toBe(11 + 22 + 33 + 5)
    expect(t.turns).toBe(2)
  })

  it("ignores undefined and missing fields", () => {
    addSessionUsage(undefined)
    addSessionUsage({})
    addSessionUsage({ output_tokens: 7 })
    const t = getSessionTokens()
    expect(t.total).toBe(7)
    // An empty `{}` still counts as a turn (the API returned a response);
    // undefined does not.
    expect(t.turns).toBe(2)
  })

  it("returns a copy so callers cannot mutate internal state", () => {
    addSessionUsage({ input_tokens: 1 })
    const t = getSessionTokens()
    t.input = 999
    expect(getSessionTokens().input).toBe(1)
  })

  it("clearSessionTokens resets everything", () => {
    addSessionUsage({ input_tokens: 5, output_tokens: 6 })
    clearSessionTokens()
    expect(getSessionTokens().total).toBe(0)
    expect(getSessionTokens().turns).toBe(0)
  })
})
