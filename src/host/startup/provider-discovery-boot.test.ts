/**
 * Tests for early provider-plugin discovery boot.
 *
 * Covers the root-resolution logic (`resolveProviderPluginRoots`) and the
 * full `bootProviderDiscovery` integration. The latter is tested against a
 * synthetic fixture tree (fake provider plugins) so it exercises the
 * mechanism without naming real vendors.
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
} from "../../llm/index.ts"
import { clearProviderPlugins } from "../../llm/provider-plugin.ts"

import { bootProviderDiscovery, resolveProviderPluginRoots } from "./provider-discovery-boot.ts"

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

// ---------------------------------------------------------------------------
// resolveProviderPluginRoots
// ---------------------------------------------------------------------------

describe("resolveProviderPluginRoots", () => {
  it("includes the embedded plugins dir and userDir when present", () => {
    const roots = resolveProviderPluginRoots("/repo", "/home/.minimal-agent")
    expect(roots).toContain("/repo/plugins")
    expect(roots).toContain("/home/.minimal-agent/plugins")
  })

  it("omits userDir when undefined", () => {
    const roots = resolveProviderPluginRoots("/repo")
    expect(roots).toContain("/repo/plugins")
    for (const r of roots) {
      expect(r).not.toContain(".minimal-agent")
    }
  })

  it("includes sibling roots (dev-time ../minimal-agent-plugins)", () => {
    // resolveSiblingPluginRoots checks existence, so we need a real dir.
    const siblingDir = mkdtempSync(join(tmpdir(), "ma-boot-sibling-"))
    try {
      const orig = process.env.MINIMAL_AGENT_PLUGIN_SIBLINGS
      process.env.MINIMAL_AGENT_PLUGIN_SIBLINGS = siblingDir
      try {
        const roots = resolveProviderPluginRoots("/repo", "/home/.minimal-agent")
        expect(roots).toContain(siblingDir)
      } finally {
        if (orig !== undefined) {
          process.env.MINIMAL_AGENT_PLUGIN_SIBLINGS = orig
        } else {
          delete process.env.MINIMAL_AGENT_PLUGIN_SIBLINGS
        }
      }
    } finally {
      rmSync(siblingDir, { recursive: true, force: true })
    }
  })

  it("returns embedded + sibling even without userDir", () => {
    const siblingDir = mkdtempSync(join(tmpdir(), "ma-boot-sibling-"))
    try {
      const orig = process.env.MINIMAL_AGENT_PLUGIN_SIBLINGS
      process.env.MINIMAL_AGENT_PLUGIN_SIBLINGS = siblingDir
      try {
        const roots = resolveProviderPluginRoots("/repo")
        expect(roots).toContain("/repo/plugins")
        expect(roots).toContain(siblingDir)
        // No userDir root.
        expect(roots.filter((r) => r.includes(".minimal-agent"))).toEqual([])
      } finally {
        if (orig !== undefined) {
          process.env.MINIMAL_AGENT_PLUGIN_SIBLINGS = orig
        } else {
          delete process.env.MINIMAL_AGENT_PLUGIN_SIBLINGS
        }
      }
    } finally {
      rmSync(siblingDir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// bootProviderDiscovery integration
// ---------------------------------------------------------------------------

describe("bootProviderDiscovery", () => {
  let embeddedDir: string
  let userDir: string

  beforeAll(() => {
    embeddedDir = mkdtempSync(join(tmpdir(), "ma-boot-embedded-"))
    userDir = mkdtempSync(join(tmpdir(), "ma-boot-user-"))
    // Providers live under a `plugins/` subdirectory, matching the real layout
    // (resolveProviderPluginRoots returns join(embeddedDir, "plugins")).
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
    await bootProviderDiscovery({ embeddedDir, userDir })

    // Both providers should be registered.
    expect(resolveProvider("vendora").id).toBe("vendora")
    expect(resolveProvider("vendorb").id).toBe("vendorb")
    // Models from both roots.
    expect(resolveModel("vendora-model-1").providerId).toBe("vendora")
    expect(resolveModel("vendorb-model-1").providerId).toBe("vendorb")
  })

  it("discovers providers from embedded root only when userDir is absent", async () => {
    await bootProviderDiscovery({ embeddedDir })

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

      await bootProviderDiscovery({ embeddedDir, userDir })

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
      await bootProviderDiscovery({ embeddedDir: emptyEmbedded, userDir })

      // Only vendorb (from userDir) should be registered.
      expect(() => resolveProvider("vendora")).toThrow()
      expect(resolveProvider("vendorb").id).toBe("vendorb")
    } finally {
      rmSync(emptyEmbedded, { recursive: true, force: true })
    }
  })

  it("is idempotent: calling twice does not duplicate registrations", async () => {
    await bootProviderDiscovery({ embeddedDir, userDir })
    await bootProviderDiscovery({ embeddedDir, userDir })

    // Still exactly one registration per provider.
    expect(resolveProvider("vendora").id).toBe("vendora")
    expect(resolveProvider("vendorb").id).toBe("vendorb")
  })
})
