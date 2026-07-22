/**
 * Cross-provider model disambiguation (opencode vs wafer), driven through the
 * REAL discovery + registration path.
 *
 * Live catalogs no longer share bare model ids across OpenCode and Wafer
 * (each gateway uses its own SKU spelling: `glm-5.1` vs `GLM-5.1`,
 * `minimax-m3` vs `MiniMax-M3`, etc.). The host still must disambiguate when
 * two providers DO register the same bare id, so this suite:
 *
 * 1. Discovers both real plugins (unique-to-one-provider SKUs stay live).
 * 2. Registers a synthetic bare id under BOTH providers to prove
 *    `findModelForProvider` / surface scoping still work.
 *
 * Wave G: both providers live in the sibling `../minimal-agent-plugins/`
 * repo. On a bare host checkout without the sibling, the suite skips cleanly.
 */

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { resolveSiblingPluginRoots } from "../plugins/loader/helpers.ts"
import { siblingPluginPresent } from "../test-utils/sibling-repo.ts"

import { defaultCapabilities } from "./capabilities.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  findModel,
  findModelForProvider,
  registerModel,
} from "./model-registry.ts"
import type { MTokRate } from "./pricing.ts"
import {
  activateDiscoveredProviders,
  buildProviderSetupContext,
  registerDiscoveredProviders,
} from "./provider-discovery.ts"
import { clearProviderPlugins } from "./provider-plugin.ts"
import { makeCharRatioEstimator } from "./token-estimate.ts"

const EMBEDDED_DIR = join(import.meta.dir, "../..")
const PLUGIN_ROOTS = [join(EMBEDDED_DIR, "plugins"), ...resolveSiblingPluginRoots(EMBEDDED_DIR)]

// Both providers now live in the sibling repo. Without it (bare checkout),
// discovery finds neither, so this cross-provider test skips cleanly.
const HAVE_BOTH =
  siblingPluginPresent("ma-llm-opencode-plugin") && siblingPluginPresent("ma-llm-wafer-plugin")

/** Bare id registered under both providers so scoped lookup can be asserted. */
const SHARED_ID = "disambiguation-shared-model"

const TEST_RATE: MTokRate = {
  inputUSD: 1,
  outputUSD: 2,
  cacheWriteUSD: 1,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
}

/**
 * Discover + activate opencode and wafer from the sibling repo, then pin a
 * synthetic shared bare id under both providers with DIFFERENT surfaces.
 */
async function discoverBoth(): Promise<void> {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
  const ids = await registerDiscoveredProviders(PLUGIN_ROOTS)
  expect(ids).toContain("opencode")
  expect(ids).toContain("wafer")
  activateDiscoveredProviders(buildProviderSetupContext())

  registerModel({
    id: SHARED_ID,
    providerId: "opencode",
    surfaceId: "surface-a",
    displayName: "Disambiguation Shared (OpenCode)",
    tags: ["opencode", "disambiguation-fixture"],
    capabilities: defaultCapabilities(),
    pricing: TEST_RATE,
    estimateTokens: makeCharRatioEstimator(3.5),
  })
  registerModel({
    id: SHARED_ID,
    providerId: "wafer",
    surfaceId: "surface-b",
    displayName: "Disambiguation Shared (Wafer)",
    tags: ["wafer", "disambiguation-fixture"],
    capabilities: defaultCapabilities(),
    pricing: TEST_RATE,
    estimateTokens: makeCharRatioEstimator(3.5),
  })
}

describe.skipIf(!HAVE_BOTH)("cross-provider model disambiguation (opencode vs wafer)", () => {
  it("findModelForProvider returns the correct provider's entry", async () => {
    await discoverBoth()

    // Un-scoped global lookup resolves to SOME provider that serves this bare
    // id (last write wins — wafer above). The point of this test is the SCOPED
    // lookups below, not which provider wins globally.
    expect(findModel(SHARED_ID)).toBeDefined()

    // Scoped for OpenCode -> OpenCode's entry.
    const oc = findModelForProvider(SHARED_ID, "opencode")
    expect(oc?.providerId).toBe("opencode")
    expect(oc?.tags).toContain("opencode")
    expect(oc?.tags).not.toContain("wafer")

    // Scoped for Wafer -> Wafer's entry.
    const wf = findModelForProvider(SHARED_ID, "wafer")
    expect(wf?.providerId).toBe("wafer")
    expect(wf?.tags).toContain("wafer")

    // The two entries are DIFFERENT objects.
    expect(oc).not.toBe(wf)

    clearProviderPlugins()
  })

  it("findModelForProvider respects strict scoping: no fallback", async () => {
    await discoverBoth()

    // GLM-5.1 is only registered by Wafer (OpenCode uses lowercase glm-5.1).
    expect(findModelForProvider("GLM-5.1", "wafer")?.providerId).toBe("wafer")
    // GLM-5.1 queried under OpenCode -> NOT found (strict, no fallback).
    expect(findModelForProvider("GLM-5.1", "opencode")).toBeUndefined()

    clearProviderPlugins()
  })

  it("different providers expose different surfaces for the same id", async () => {
    await discoverBoth()

    // SHARED_ID is registered under BOTH providers on DIFFERENT wire surfaces
    // (see discoverBoth). Assert the surfaces DIFFER and each scoped entry
    // carries a non-empty surface id, without hardcoding vendor-named surface
    // strings beyond the fixture itself.
    const oc = findModelForProvider(SHARED_ID, "opencode")
    const wf = findModelForProvider(SHARED_ID, "wafer")
    expect(oc?.providerId).toBe("opencode")
    expect(wf?.providerId).toBe("wafer")
    expect(oc?.surfaceId).toBeTruthy()
    expect(wf?.surfaceId).toBeTruthy()
    expect(oc?.surfaceId).not.toBe(wf?.surfaceId)

    clearProviderPlugins()
  })

  it("model unique to one provider resolves correctly for that provider", async () => {
    await discoverBoth()

    // Kimi-K2.6: Wafer only (OpenCode uses lowercase kimi-k2.6).
    expect(findModelForProvider("Kimi-K2.6", "wafer")?.providerId).toBe("wafer")
    expect(findModelForProvider("Kimi-K2.6", "opencode")).toBeUndefined()

    // minimax-m3: OpenCode only (Wafer uses MiniMax-M3). It resolves under
    // opencode with a non-empty surface id (the specific surface literal stays
    // in the plugin, not core).
    const ocMm3 = findModelForProvider("minimax-m3", "opencode")
    expect(ocMm3?.providerId).toBe("opencode")
    expect(ocMm3?.surfaceId).toBeTruthy()

    clearProviderPlugins()
  })
})
