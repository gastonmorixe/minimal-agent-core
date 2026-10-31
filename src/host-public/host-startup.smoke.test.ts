/**
 * Smoke test: the `src/host/startup/*` cluster of `./host/*` subpaths
 * resolves and works through the package name. Note: this cluster's real
 * implementation currently sits under the closure-forbidden `src/host/`
 * root (see `public-closure-scan.ts`'s `PUBLIC_CLOSURE_BASELINE`), pending
 * the S34 physical move.
 *
 * @module host-public/host-startup.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { providerAuthToAuthResult } from "@minimal-agent/core/host/provider-auth"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { resolveProviderPluginRoots } from "@minimal-agent/core/host/provider-discovery-boot"

describe("./host/* host/startup cluster (public subpaths)", () => {
  it("./host/provider-auth: maps a stored api-key auth to AuthResult", () => {
    expect(providerAuthToAuthResult({ kind: "api-key", key: "sk-test" })).toEqual({
      type: "api-key",
      token: "sk-test",
    })
  })

  it("./host/provider-discovery-boot: orders embedded, sibling, and user plugin roots", () => {
    const roots = resolveProviderPluginRoots("/repo")
    expect(roots[0]).toBe("/repo/plugins")
  })
})
