/**
 * End-to-end dispatch disambiguation (opencode vs wafer) through the REAL
 * discovery + `run()` path.
 *
 * Live catalogs no longer share bare model ids across OpenCode and Wafer
 * (each gateway uses its own SKU spelling). Shared-id routing is still the
 * host contract, so this suite:
 *
 * 1. Discovers both real plugins (adapter error paths, short codes).
 * 2. Registers a synthetic bare id under BOTH providers to exercise
 *    `CanonicalRequest.providerId` scoped dispatch.
 *
 * Wave G: both providers live in the sibling `../minimal-agent-plugins/`
 * repo. On a bare host checkout without the sibling, the suite skips cleanly.
 */

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { userText } from "@minimal-agent/plugin-api/llm/canonical-messages"
import type { RunContext } from "@minimal-agent/plugin-api/llm/provider-auth"

import { resolveSiblingPluginRoots } from "../plugins/loader/helpers.ts"
import { siblingPluginPresent } from "../test-utils/sibling-repo.ts"

import type { CanonicalRequest } from "./canonical-request.ts"
import { defaultCapabilities } from "./capabilities.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
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
import { run } from "./run.ts"
import { makeCharRatioEstimator } from "./token-estimate.ts"

const EMBEDDED_DIR = join(import.meta.dir, "../..")
const PLUGIN_ROOTS = [join(EMBEDDED_DIR, "plugins"), ...resolveSiblingPluginRoots(EMBEDDED_DIR)]

const HAVE_BOTH =
  siblingPluginPresent("ma-llm-opencode-plugin") && siblingPluginPresent("ma-llm-wafer-plugin")

/** Bare id registered under both providers so scoped dispatch can be asserted. */
const SHARED_ID = "dispatch-shared-model"

const TEST_RATE: MTokRate = {
  inputUSD: 1,
  outputUSD: 2,
  cacheWriteUSD: 1,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0,
}

/**
 * Discover + activate opencode and wafer from the sibling repo, then pin a
 * synthetic shared bare id under both providers (catalogs no longer overlap).
 */
async function discoverBothWithSharedModel(): Promise<void> {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
  await registerDiscoveredProviders(PLUGIN_ROOTS)
  activateDiscoveredProviders(buildProviderSetupContext())

  registerModel({
    id: SHARED_ID,
    providerId: "opencode",
    surfaceId: "surface-a",
    displayName: "Dispatch Shared (OpenCode)",
    tags: ["opencode", "dispatch-fixture"],
    capabilities: defaultCapabilities(),
    pricing: TEST_RATE,
    estimateTokens: makeCharRatioEstimator(3.5),
  })
  registerModel({
    id: SHARED_ID,
    providerId: "wafer",
    surfaceId: "surface-b",
    displayName: "Dispatch Shared (Wafer)",
    tags: ["wafer", "dispatch-fixture"],
    capabilities: defaultCapabilities(),
    pricing: TEST_RATE,
    estimateTokens: makeCharRatioEstimator(3.5),
  })
}

/**
 * Fake network client that returns a 503 for ANY request. The test never hits
 * the network; the error message comes from the resolved adapter's own error
 * path, which carries the provider name.
 */
function fakeNet() {
  return {
    async request() {
      return {
        ok: false,
        status: 503,
        text: async () => '{"error":{"code":"server_error"}}',
        headers: new Headers(),
      }
    },
  } as unknown as import("../network/index.ts").NetworkClient
}

describe.skipIf(!HAVE_BOTH)("dispatch disambiguation: providerId on CanonicalRequest", () => {
  it("run() with providerId:'opencode' routes to OpenCode, not Wafer", async () => {
    await discoverBothWithSharedModel()

    const ocModel = findModelForProvider(SHARED_ID, "opencode")
    const wfModel = findModelForProvider(SHARED_ID, "wafer")
    expect(ocModel?.providerId).toBe("opencode")
    expect(wfModel?.providerId).toBe("wafer")

    const req: CanonicalRequest = {
      modelId: SHARED_ID,
      providerId: "opencode",
      messages: [userText("hi")],
      generation: { maxOutputTokens: 1 },
    }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "test-key" },
      networkClient: fakeNet(),
      sessionId: "dispatch-test",
    }

    let errorMessage = ""
    try {
      for await (const _ of run(req, { context: ctx })) {
        /* drain */
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    }

    // OpenCode adapter must be used, NOT Wafer.
    expect(errorMessage).not.toMatch(/wafer/i)
    expect(errorMessage).toMatch(/opencode/i)

    clearProviderPlugins()
  })

  it("run() with providerId:'wafer' routes to Wafer, not OpenCode", async () => {
    await discoverBothWithSharedModel()

    const req: CanonicalRequest = {
      modelId: SHARED_ID,
      providerId: "wafer",
      messages: [userText("hi")],
      generation: { maxOutputTokens: 1 },
    }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "wfr_test" },
      networkClient: fakeNet(),
      sessionId: "dispatch-test-wf",
    }

    let errorMessage = ""
    try {
      for await (const _ of run(req, { context: ctx })) {
        /* drain */
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    }

    // Wafer adapter must be used, NOT OpenCode.
    expect(errorMessage).toMatch(/wafer/i)
    expect(errorMessage).not.toMatch(/opencode/i)

    clearProviderPlugins()
  })

  it("run() without providerId uses the global (last-registered) entry", async () => {
    await discoverBothWithSharedModel()

    // Without a providerId, dispatch resolves the global last-write-wins entry
    // for SHARED_ID (wafer registered last above). Assert that path runs.
    const req: CanonicalRequest = {
      modelId: SHARED_ID,
      // No providerId.
      messages: [userText("hi")],
      generation: { maxOutputTokens: 1 },
    }
    const ctx: RunContext = {
      auth: { kind: "api-key", key: "test" },
      networkClient: fakeNet(),
      sessionId: "dispatch-test-legacy",
    }

    let errorMessage = ""
    try {
      for await (const _ of run(req, { context: ctx })) {
        /* drain */
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err)
    }

    // A provider's error path ran (503 surfaced), proving the model resolved
    // and dispatched to a real adapter.
    expect(errorMessage).toMatch(/503/)

    clearProviderPlugins()
  })

  it("modelInfoSnapshot resolves correct provider via scoped lookup", async () => {
    await discoverBothWithSharedModel()

    const { buildModelInfoSnapshot } = await import("./model-info.ts")

    const ocSnapshot = buildModelInfoSnapshot(SHARED_ID, "opencode")
    expect(ocSnapshot.providerId).toBe("opencode")
    expect(ocSnapshot.resolved).toBe(true)

    const wfSnapshot = buildModelInfoSnapshot(SHARED_ID, "wafer")
    expect(wfSnapshot.providerId).toBe("wafer")
    expect(wfSnapshot.resolved).toBe(true)

    // Without providerId: falls back to the global entry, which resolves to
    // one of the providers that serves this id (not pinned here).
    const unScoped = buildModelInfoSnapshot(SHARED_ID)
    expect(unScoped.resolved).toBe(true)

    clearProviderPlugins()
  })

  it("modelShortLabel resolves correct provider via scoped lookup", async () => {
    await discoverBothWithSharedModel()

    const { modelShortLabel } = await import("./model-label.ts")

    // Scoped for OpenCode -> label uses OpenCode's short code ("og").
    const ocLabel = modelShortLabel(SHARED_ID, "opencode")
    expect(ocLabel).toMatch(/^og/i)
    expect(ocLabel).not.toMatch(/^wf/i)

    // Scoped for Wafer -> label uses Wafer's short code ("wf"), not OpenCode's.
    const wfLabel = modelShortLabel(SHARED_ID, "wafer")
    expect(wfLabel).not.toMatch(/^og/i)
    expect(wfLabel).toMatch(/^wf/i)

    clearProviderPlugins()
  })
})
