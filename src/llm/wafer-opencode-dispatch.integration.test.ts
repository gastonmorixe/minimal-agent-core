/**
 * End-to-end dispatch disambiguation (opencode vs wafer) through the REAL
 * discovery + `run()` path.
 *
 * When both OpenCode and Wafer register the same bare model id
 * (`deepseek-v4-flash`), the dispatch path must resolve the correct provider's
 * adapter when `CanonicalRequest.providerId` is set, and fall back to the
 * global (last-registered) entry when it is not. A fake NetworkClient forces a
 * pre-stream error so the assertion reads which provider's error path ran.
 *
 * Wave G: both providers migrated to the sibling `../minimal-agent-plugins/`
 * repo, so this test discovers them from there via `registerDiscoveredProviders`
 * + `activateDiscoveredProviders` instead of importing the plugin adapters. It
 * lives in `src/llm/` because it drives the host orchestrator (`run`,
 * `model-info`, `model-label`) and tests CROSS-provider routing spanning BOTH
 * plugins. On a bare host checkout without the sibling, it skips cleanly.
 */

import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { userText } from "@minimal-agent/plugin-api/llm/canonical-messages"
import type { RunContext } from "@minimal-agent/plugin-api/llm/provider-auth"

import { resolveSiblingPluginRoots } from "../plugins/loader/helpers.ts"
import { siblingPluginPresent } from "../test-utils/sibling-repo.ts"

import type { CanonicalRequest } from "./canonical-request.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  findModelForProvider,
} from "./model-registry.ts"
import {
  activateDiscoveredProviders,
  buildProviderSetupContext,
  registerDiscoveredProviders,
} from "./provider-discovery.ts"
import { clearProviderPlugins } from "./provider-plugin.ts"
import { run } from "./run.ts"

const EMBEDDED_DIR = join(import.meta.dir, "../..")
const PLUGIN_ROOTS = [join(EMBEDDED_DIR, "plugins"), ...resolveSiblingPluginRoots(EMBEDDED_DIR)]

const HAVE_BOTH =
  siblingPluginPresent("ma-llm-opencode-plugin") && siblingPluginPresent("ma-llm-wafer-plugin")

/** Discover + activate opencode and wafer from the sibling repo. */
async function discoverBoth(): Promise<void> {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
  await registerDiscoveredProviders(PLUGIN_ROOTS)
  activateDiscoveredProviders(buildProviderSetupContext())
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
    await discoverBoth()

    const ocModel = findModelForProvider("deepseek-v4-flash", "opencode")
    const wfModel = findModelForProvider("deepseek-v4-flash", "wafer")
    expect(ocModel?.providerId).toBe("opencode")
    expect(wfModel?.providerId).toBe("wafer")

    const req: CanonicalRequest = {
      modelId: "deepseek-v4-flash",
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

    clearProviderPlugins()
  })

  it("run() with providerId:'wafer' routes to Wafer, not OpenCode", async () => {
    await discoverBoth()

    const req: CanonicalRequest = {
      modelId: "deepseek-v4-flash",
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
    await discoverBoth()

    // `deepseek-v4-flash` is served by several discovered providers (opencode,
    // wafer, ollama). Without a providerId, dispatch resolves the global
    // last-write-wins entry. We don't pin WHICH provider wins (that depends on
    // the full discovered set's registration order), only that dispatch routes
    // to one real provider's error path rather than failing to resolve.
    const req: CanonicalRequest = {
      modelId: "deepseek-v4-flash",
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
    await discoverBoth()

    const { buildModelInfoSnapshot } = await import("./model-info.ts")

    const ocSnapshot = buildModelInfoSnapshot("deepseek-v4-flash", "opencode")
    expect(ocSnapshot.providerId).toBe("opencode")
    expect(ocSnapshot.resolved).toBe(true)

    const wfSnapshot = buildModelInfoSnapshot("deepseek-v4-flash", "wafer")
    expect(wfSnapshot.providerId).toBe("wafer")
    expect(wfSnapshot.resolved).toBe(true)

    // Without providerId: falls back to the global entry, which resolves to
    // one of the discovered providers that serves this id (not pinned here).
    const unScoped = buildModelInfoSnapshot("deepseek-v4-flash")
    expect(unScoped.resolved).toBe(true)

    clearProviderPlugins()
  })

  it("modelShortLabel resolves correct provider via scoped lookup", async () => {
    await discoverBoth()

    const { modelShortLabel } = await import("./model-label.ts")

    // Scoped for OpenCode -> label uses OpenCode's short code ("og").
    const ocLabel = modelShortLabel("deepseek-v4-flash", "opencode")
    expect(ocLabel).toMatch(/^og/i)
    expect(ocLabel).not.toMatch(/^wf/i)

    // Scoped for Wafer -> label uses Wafer's short code ("wf"), not OpenCode's.
    const wfLabel = modelShortLabel("deepseek-v4-flash", "wafer")
    expect(wfLabel).not.toMatch(/^og/i)
    expect(wfLabel).toMatch(/^wf/i)

    clearProviderPlugins()
  })
})
