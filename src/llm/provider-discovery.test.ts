import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import {
  clearModelRegistry,
  clearProviderRegistry,
  resolveModel,
  resolveProvider,
} from "./index.ts"
import {
  activateDiscoveredProviders,
  discoverProviderPlugins,
  findProviderPluginDirs,
  registerDiscoveredProviders,
} from "./provider-discovery.ts"
import { clearProviderPlugins } from "./provider-plugin.ts"
import { clearSurfaceCodecs, findSurfaceCodec } from "./surface-codec-registry.ts"

// Discovery is tested against a SYNTHETIC fixture tree built at runtime (two
// fake provider plugins with neutral ids), so it exercises the mechanism
// (read provider.json → dynamic import → register) without naming any real
// vendor. Each real provider's own registration is covered in its plugin suite.

let pluginsDir: string

/** Write a minimal provider-plugin package (provider.json + an entry module). */
function writeFakeProvider(root: string, id: string, shortCode: string, modelId: string): void {
  const dir = join(root, `llm-${id}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "provider.json"),
    JSON.stringify({ id, entry: "./index.ts", export: "providerPlugin" }),
  )
  // A tiny ProviderPlugin whose register() registers one model + a stub adapter.
  writeFileSync(
    join(dir, "index.ts"),
    `
export const providerPlugin = {
  id: ${JSON.stringify(id)},
  displayName: ${JSON.stringify(`${id} provider`)},
  shortCode: ${JSON.stringify(shortCode)},
  register(ctx) {
    const adapter = {
      id: ${JSON.stringify(id)},
      displayName: ${JSON.stringify(id)},
      surfaces: ["test-surface"],
      validate: () => ({ ok: true, errors: [] }),
      async *run() {},
    }
    ctx.providers.register(adapter)
    ctx.surfaceCodecs?.register({
      surfaceId: ${JSON.stringify(`${id}-surface`)},
      displayName: ${JSON.stringify(`${id} surface`)},
      defaultPath: "/v1/chat/completions",
      defaultCapabilities: { contextWindow: 1000, maxOutputTokens: 100 },
      defaultPricing: { inputUSD: 0, outputUSD: 0, cacheWriteUSD: 0, cacheReadUSD: 0, webSearchPerCallUSD: 0 },
      validate: () => ({ ok: true, errors: [] }),
      buildRequest: (i) => ({ label: "t", method: "POST", url: i.endpoint }),
      async *translateStream() {},
    })
    ctx.models.register({
      id: ${JSON.stringify(modelId)},
      providerId: ${JSON.stringify(id)},
      surfaceId: "test-surface",
      displayName: ${JSON.stringify(modelId)},
      capabilities: { contextWindow: 1000, maxOutputTokens: 100 },
    })
  },
}
`,
  )
}

beforeAll(() => {
  pluginsDir = mkdtempSync(join(tmpdir(), "minimal-agent-discovery-"))
  writeFakeProvider(pluginsDir, "vendora", "va", "vendora-model-1")
  writeFakeProvider(pluginsDir, "vendorb", "vb", "vendorb-model-1")
})

afterAll(() => {
  rmSync(pluginsDir, { recursive: true, force: true })
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
})

describe("provider discovery", () => {
  it("finds the llm-* provider descriptors via provider.json", () => {
    const ids = findProviderPluginDirs(pluginsDir).map((d) => d.descriptor.id)
    expect(ids).toEqual(expect.arrayContaining(["vendora", "vendorb"]))
  })

  it("dynamically imports each declared ProviderPlugin", async () => {
    const plugins = await discoverProviderPlugins(pluginsDir)
    const ids = plugins.map((p) => p.id)
    expect(ids).toContain("vendora")
    expect(ids).toContain("vendorb")
    for (const p of plugins) {
      expect(typeof p.register).toBe("function")
      expect(typeof p.shortCode).toBe("string")
    }
  })

  it("registers + activates discovered providers into the canonical registries", async () => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()

    const ids = await registerDiscoveredProviders(pluginsDir)
    expect(ids).toEqual(expect.arrayContaining(["vendora", "vendorb"]))
    activateDiscoveredProviders()

    expect(resolveProvider("vendora").id).toBe("vendora")
    expect(resolveProvider("vendorb").id).toBe("vendorb")
    expect(resolveModel("vendora-model-1").providerId).toBe("vendora")
    expect(resolveModel("vendorb-model-1").providerId).toBe("vendorb")

    clearProviderPlugins()
  })

  it("activation threads a surface-codec registrar so plugins register codecs", async () => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    clearSurfaceCodecs()

    await registerDiscoveredProviders(pluginsDir)
    activateDiscoveredProviders()

    expect(findSurfaceCodec("vendora-surface")?.surfaceId).toBe("vendora-surface")
    expect(findSurfaceCodec("vendorb-surface")?.surfaceId).toBe("vendorb-surface")

    clearProviderPlugins()
    clearSurfaceCodecs()
  })

  it("returns empty for a non-existent dir", () => {
    expect(findProviderPluginDirs(join(tmpdir(), "minimal-agent-does-not-exist"))).toEqual([])
  })

  it("registers providers across MULTIPLE roots (Wave G sibling repo)", async () => {
    // A second root standing in for the sibling ../minimal-agent-plugins repo,
    // holding a provider not present in the embedded root.
    const siblingDir = mkdtempSync(join(tmpdir(), "minimal-agent-discovery-sibling-"))
    writeFakeProvider(siblingDir, "vendorc", "vc", "vendorc-model-1")
    try {
      clearModelRegistry()
      clearProviderRegistry()
      clearProviderPlugins()

      const ids = await registerDiscoveredProviders([pluginsDir, siblingDir])
      expect(ids).toEqual(expect.arrayContaining(["vendora", "vendorb", "vendorc"]))
      activateDiscoveredProviders()
      // The sibling-root provider resolves like any embedded one.
      expect(resolveProvider("vendorc").id).toBe("vendorc")
      expect(resolveModel("vendorc-model-1").providerId).toBe("vendorc")
    } finally {
      rmSync(siblingDir, { recursive: true, force: true })
      clearProviderPlugins()
    }
  })

  it("dedupes by provider id across roots (first root wins, mid-migration window)", async () => {
    // Same id in both roots (a provider mid-move: present in embedded AND
    // sibling for one commit). The FIRST root's copy must win exactly once,
    // no double-registration.
    const siblingDir = mkdtempSync(join(tmpdir(), "minimal-agent-discovery-dup-"))
    writeFakeProvider(siblingDir, "vendora", "va", "vendora-model-1")
    try {
      clearModelRegistry()
      clearProviderRegistry()
      clearProviderPlugins()

      const ids = await registerDiscoveredProviders([pluginsDir, siblingDir])
      expect(ids.filter((id) => id === "vendora")).toEqual(["vendora"])
    } finally {
      rmSync(siblingDir, { recursive: true, force: true })
      clearProviderPlugins()
    }
  })

  it("accepts a single dir string (back-compat)", async () => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    const ids = await registerDiscoveredProviders(pluginsDir)
    expect(ids).toEqual(expect.arrayContaining(["vendora", "vendorb"]))
    clearProviderPlugins()
  })
})
