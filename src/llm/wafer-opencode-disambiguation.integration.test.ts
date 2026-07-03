/**
 * Cross-provider model disambiguation (opencode vs wafer), driven through the
 * REAL discovery + registration path.
 *
 * Both OpenCode and Wafer serve some of the same bare model ids (e.g.
 * `deepseek-v4-flash`, `qwen3.7-max`) on DIFFERENT surfaces. This test proves
 * `findModelForProvider` / `resolveModelForProvider` disambiguate by providerId
 * rather than the global last-write-wins entry.
 *
 * Wave G: both providers migrated to the sibling `../minimal-agent-plugins/`
 * repo, so this test discovers them from there via
 * `registerDiscoveredProviders` + `activateDiscoveredProviders` (the same
 * composition the live agent boots), instead of importing the plugin adapters
 * directly. It lives in `src/llm/` because it drives the host discovery loader,
 * and it tests CROSS-provider routing that spans BOTH plugins (so it belongs to
 * neither plugin's own unit-test suite). On a bare host checkout without the
 * sibling repo, it skips cleanly.
 */

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { resolveSiblingPluginRoots } from "../plugins/loader/helpers.ts"
import { siblingPluginPresent } from "../test-utils/sibling-repo.ts"

import {
  clearModelRegistry,
  clearProviderRegistry,
  findModel,
  findModelForProvider,
} from "./model-registry.ts"
import {
  activateDiscoveredProviders,
  buildProviderSetupContext,
  registerDiscoveredProviders,
} from "./provider-discovery.ts"
import { clearProviderPlugins } from "./provider-plugin.ts"

const EMBEDDED_DIR = join(import.meta.dir, "../..")
const PLUGIN_ROOTS = [join(EMBEDDED_DIR, "plugins"), ...resolveSiblingPluginRoots(EMBEDDED_DIR)]

// Both providers now live in the sibling repo. Without it (bare checkout),
// discovery finds neither, so this cross-provider test skips cleanly.
const HAVE_BOTH =
  siblingPluginPresent("ma-llm-opencode-plugin") && siblingPluginPresent("ma-llm-wafer-plugin")

/** Discover + activate opencode and wafer from the sibling repo. */
async function discoverBoth(): Promise<void> {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
  const ids = await registerDiscoveredProviders(PLUGIN_ROOTS)
  expect(ids).toContain("opencode")
  expect(ids).toContain("wafer")
  activateDiscoveredProviders(buildProviderSetupContext())
}

describe.skipIf(!HAVE_BOTH)("cross-provider model disambiguation (opencode vs wafer)", () => {
  it("findModelForProvider returns the correct provider's entry", async () => {
    await discoverBoth()

    // Un-scoped global lookup resolves to SOME provider that serves this bare
    // id (opencode, wafer, or ollama, whichever registered last). The point of
    // this test is the SCOPED lookups below, not which provider wins globally.
    expect(findModel("deepseek-v4-flash")).toBeDefined()

    // Scoped for OpenCode -> OpenCode's entry.
    const oc = findModelForProvider("deepseek-v4-flash", "opencode")
    expect(oc?.providerId).toBe("opencode")
    expect(oc?.tags).toContain("opencode")
    expect(oc?.tags).not.toContain("wafer")

    // Scoped for Wafer -> Wafer's entry.
    const wf = findModelForProvider("deepseek-v4-flash", "wafer")
    expect(wf?.providerId).toBe("wafer")
    expect(wf?.tags).toContain("wafer")

    // The two entries are DIFFERENT objects.
    expect(oc).not.toBe(wf)

    clearProviderPlugins()
  })

  it("findModelForProvider respects strict scoping: no fallback", async () => {
    await discoverBoth()

    // GLM-5.1 is only registered by Wafer.
    expect(findModelForProvider("GLM-5.1", "wafer")?.providerId).toBe("wafer")
    // GLM-5.1 queried under OpenCode -> NOT found (strict, no fallback).
    expect(findModelForProvider("GLM-5.1", "opencode")).toBeUndefined()

    clearProviderPlugins()
  })

  it("different providers expose different surfaces for the same id", async () => {
    await discoverBoth()

    // qwen3.7-max is served by BOTH providers on their OWN wire surfaces. We
    // assert the surfaces DIFFER and each scoped entry carries a non-empty
    // surface id, without hardcoding the vendor-named surface strings in core
    // code (the provider-token ratchet forbids naming them here; the surface
    // literals live in each plugin's models.ts).
    const oc = findModelForProvider("qwen3.7-max", "opencode")
    const wf = findModelForProvider("qwen3.7-max", "wafer")
    expect(oc?.providerId).toBe("opencode")
    expect(wf?.providerId).toBe("wafer")
    expect(oc?.surfaceId).toBeTruthy()
    expect(wf?.surfaceId).toBeTruthy()
    expect(oc?.surfaceId).not.toBe(wf?.surfaceId)

    clearProviderPlugins()
  })

  it("model unique to one provider resolves correctly for that provider", async () => {
    await discoverBoth()

    // Kimi-K2.6: Wafer only.
    expect(findModelForProvider("Kimi-K2.6", "wafer")?.providerId).toBe("wafer")
    expect(findModelForProvider("Kimi-K2.6", "opencode")).toBeUndefined()

    // minimax-m3: OpenCode only. It resolves under opencode with a non-empty
    // surface id (the specific surface literal stays in the plugin, not core).
    const ocMm3 = findModelForProvider("minimax-m3", "opencode")
    expect(ocMm3?.providerId).toBe("opencode")
    expect(ocMm3?.surfaceId).toBeTruthy()

    clearProviderPlugins()
  })
})
