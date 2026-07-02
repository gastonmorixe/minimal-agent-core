/**
 * `session-info:read` capability (Wave G).
 *
 * Verifies the host factory grants `ctx.host.sessionInfo` ONLY when the
 * capability is declared, that `providerInfo` routes to the live provider
 * resolver, and that `tokens()` projects the process-wide session counters
 * onto the neutral view. This is the seam that lets `quota-status` /
 * `session-info` read the provider + token snapshot without importing
 * `resolveProviderSessionInfo` / `getSessionTokens` from `src/`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { addSessionUsage, clearSessionTokens } from "../../session-tokens.ts"

import { buildPluginHost } from "./factory.ts"

beforeEach(() => clearSessionTokens())
afterEach(() => clearSessionTokens())

describe("plugin host: session-info capability", () => {
  it("is undefined when not granted (deny-by-default)", () => {
    const host = buildPluginHost({ capabilities: [] })
    expect(host.sessionInfo).toBeUndefined()
  })

  it("session-info:read populates host.sessionInfo", () => {
    const host = buildPluginHost({ capabilities: ["session-info:read"] })
    expect(host.sessionInfo).toBeDefined()
    expect(typeof host.sessionInfo?.providerInfo).toBe("function")
    expect(typeof host.sessionInfo?.tokens).toBe("function")
  })

  it("tokens() projects the live session counters onto the neutral view", () => {
    const host = buildPluginHost({ capabilities: ["session-info:read"] })
    // Zero-state before any usage.
    const zero = host.sessionInfo?.tokens()
    expect(zero).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
      total: 0,
      turns: 0,
      contextSize: 0,
    })

    // Record a turn; the capability reflects the live counters.
    addSessionUsage({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
    })
    const after = host.sessionInfo?.tokens()
    expect(after?.input).toBe(100)
    expect(after?.output).toBe(50)
    expect(after?.turns).toBe(1)
    // contextSize is the latest turn's input footprint (input + cacheRead + cacheCreate).
    expect(after?.contextSize).toBe(115)
  })

  it("providerInfo() resolves a context-only snapshot for an unknown model", async () => {
    const host = buildPluginHost({ capabilities: ["session-info:read"] })
    // No provider plugin registered for this fake id → the resolver returns a
    // neutral context-only snapshot (no throw), which is what the footer wants.
    const info = await host.sessionInfo?.providerInfo("no-such-model-xyz")
    expect(info).toBeDefined()
    // ProviderSessionInfo is all-optional; the shape resolves without a quota.
    expect(info?.quota).toBeUndefined()
  })
})
