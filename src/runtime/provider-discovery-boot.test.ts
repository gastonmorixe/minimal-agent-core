/**
 * Tests for early provider-plugin discovery boot.
 *
 * Covers the `bootProviderDiscovery` integration against a synthetic
 * fixture tree (fake provider plugins), so it exercises the mechanism
 * without naming real vendors. The host computes the roots (S40).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"

import {
  clearModelRegistry,
  clearProviderRegistry,
  resolveModel,
  resolveProvider,
} from "../llm/index.ts"
import { clearProviderPlugins } from "../llm/provider-plugin.ts"

import { bootProviderDiscovery } from "./provider-discovery-boot.ts"

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Write a minimal provider-plugin package (provider.json + an entry module). */
function writeFakeProvider(root: string, id: string, shortCode: string, modelId: string): void {
  const dir = join(root, `llm-${id}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "provider.json"),
    JSON.stringify({ id, entry: "./index.ts", export: "providerPlugin" }),
  )
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

/** The provider roots a host computes: `<embedded>/plugins`, then `<user>/plugins`. */
function rootsOf(embeddedDir: string, userDir?: string): string[] {
  return [join(embeddedDir, "plugins"), ...(userDir ? [join(userDir, "plugins")] : [])]
}

// ---------------------------------------------------------------------------
// bootProviderDiscovery integration
// ---------------------------------------------------------------------------

describe("bootProviderDiscovery", () => {
  let embeddedDir: string
  let userDir: string

  beforeAll(() => {
    embeddedDir = mkdtempSync(join(tmpdir(), "ma-boot-embedded-"))
    userDir = mkdtempSync(join(tmpdir(), "ma-boot-user-"))
    // Providers live under a `plugins/` subdirectory. The test passes that
    // subdirectory as the root, like a host does.
    writeFakeProvider(join(embeddedDir, "plugins"), "vendora", "va", "vendora-model-1")
    writeFakeProvider(join(userDir, "plugins"), "vendorb", "vb", "vendorb-model-1")
  })

  afterAll(() => {
    rmSync(embeddedDir, { recursive: true, force: true })
    rmSync(userDir, { recursive: true, force: true })
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
  })

  beforeEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
  })

  it("discovers providers from embedded + user roots", async () => {
    await bootProviderDiscovery({ roots: rootsOf(embeddedDir, userDir) })

    // Both providers should be registered.
    expect(resolveProvider("vendora").id).toBe("vendora")
    expect(resolveProvider("vendorb").id).toBe("vendorb")
    // Models from both roots.
    expect(resolveModel("vendora-model-1").providerId).toBe("vendora")
    expect(resolveModel("vendorb-model-1").providerId).toBe("vendorb")
  })

  it("discovers providers from the given roots only", async () => {
    await bootProviderDiscovery({ roots: rootsOf(embeddedDir) })

    expect(resolveProvider("vendora").id).toBe("vendora")
    // vendorb lives in userDir only, so it should NOT be registered.
    expect(() => resolveProvider("vendorb")).toThrow()
  })

  it("embedded root wins on id collision with user root", async () => {
    // Write a vendora into userDir too (simulating a stale clone).
    writeFakeProvider(join(userDir, "plugins"), "vendora", "va", "vendora-model-1")
    try {
      clearModelRegistry()
      clearProviderRegistry()
      clearProviderPlugins()

      await bootProviderDiscovery({ roots: rootsOf(embeddedDir, userDir) })

      // vendora should be registered exactly once (embedded wins).
      expect(resolveProvider("vendora").id).toBe("vendora")
      // The model from the embedded vendora should be the one registered.
      expect(resolveModel("vendora-model-1").providerId).toBe("vendora")
    } finally {
      // Clean up the duplicate we wrote.
      rmSync(join(userDir, "plugins", "llm-vendora"), { recursive: true, force: true })
    }
  })

  it("discovers providers from user root when embedded has none", async () => {
    const emptyEmbedded = mkdtempSync(join(tmpdir(), "ma-boot-empty-"))
    try {
      await bootProviderDiscovery({ roots: rootsOf(emptyEmbedded, userDir) })

      // Only vendorb (from userDir) should be registered.
      expect(() => resolveProvider("vendora")).toThrow()
      expect(resolveProvider("vendorb").id).toBe("vendorb")
    } finally {
      rmSync(emptyEmbedded, { recursive: true, force: true })
    }
  })

  it("is idempotent: calling twice does not duplicate registrations", async () => {
    await bootProviderDiscovery({ roots: rootsOf(embeddedDir, userDir) })
    await bootProviderDiscovery({ roots: rootsOf(embeddedDir, userDir) })

    // Still exactly one registration per provider.
    expect(resolveProvider("vendora").id).toBe("vendora")
    expect(resolveProvider("vendorb").id).toBe("vendorb")
  })
})
