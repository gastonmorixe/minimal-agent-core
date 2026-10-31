/**
 * Smoke test: the plugins-leaf cluster of `./host/*` subpaths resolves and
 * works through the package name.
 *
 * @module host-public/plugins.smoke.test
 */

import { describe, expect, it } from "bun:test"

// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { agentContextToEnv, createAgentContext } from "@minimal-agent/core/host/agent-context"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { buildPluginCatalog } from "@minimal-agent/core/host/plugin-catalog"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { resolvePluginEnabledOverrides } from "@minimal-agent/core/host/plugin-enable-resolution"
// biome-ignore lint/correctness/noUndeclaredDependencies: self-reference, see AGENTS.md "Public package".
import { resolveEffectivePlatform } from "@minimal-agent/core/host/plugin-platform-resolution"

describe("./host/* plugins-leaf cluster (public subpaths)", () => {
  it("./host/agent-context: round-trips the frozen identity through env vars", () => {
    const ctx = createAgentContext({ sessionId: "sid-1", pid: 123, model: "m", version: "1.0.0" })
    const env = agentContextToEnv(ctx)
    expect(env.MINIMAL_AGENT_SESSION_ID).toBe("sid-1")
  })

  it("./host/plugin-catalog: scans no roots to an empty catalog", () => {
    expect(
      buildPluginCatalog({}, { config: { forceDisabled: new Set(), forceEnabled: new Set() } }),
    ).toEqual([])
  })

  it("./host/plugin-enable-resolution: config forms the base override set", () => {
    const resolved = resolvePluginEnabledOverrides({
      config: { forceDisabled: new Set(["x"]), forceEnabled: new Set() },
    })
    expect(resolved.forceDisabled.has("x")).toBe(true)
  })

  it("./host/plugin-platform-resolution: detected wins with no cli/env override", () => {
    expect(resolveEffectivePlatform({ detected: "linux" })).toEqual({
      platform: "linux",
      source: "detected",
    })
  })
})
