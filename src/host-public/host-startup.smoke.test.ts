/**
 * Smoke test: the startup cluster of `./host/*` subpaths (provider auth,
 * provider discovery, and related) resolves and works through the package
 * name. S34 moved the real implementation out of `src/host/` into engine
 * folders.
 *
 * @module host-public/host-startup.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { providerAuthToAuthResult } from "@minimal-agent/core/host/provider-auth"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { bootProviderDiscovery } from "@minimal-agent/core/host/provider-discovery-boot"

describe("./host/* host/startup cluster (public subpaths)", () => {
  it("./host/provider-auth: maps a stored api-key auth to AuthResult", () => {
    expect(providerAuthToAuthResult({ kind: "api-key", key: "sk-test" })).toEqual({
      type: "api-key",
      token: "sk-test",
    })
  })

  it("./host/provider-discovery-boot: takes host-computed roots and accepts a missing root", async () => {
    await bootProviderDiscovery({ roots: ["/nonexistent-provider-root-for-smoke-test"] })
    expect(typeof bootProviderDiscovery).toBe("function")
  })
})
