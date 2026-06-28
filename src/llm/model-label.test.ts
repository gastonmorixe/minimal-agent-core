import { afterAll, beforeAll, describe, expect, it } from "bun:test"

import { clearModelRegistry, clearProviderRegistry } from "./index.ts"
import { modelShortLabel } from "./model-label.ts"
import { clearProviderPlugins } from "./provider-plugin.ts"
import { registerTestProvider } from "./test-fixtures.ts"

// modelShortLabel maps a model id to `<shortCode>-<versionToken>`, where the
// shortCode + version-token parser come from the OWNING provider plugin. These
// tests register SYNTHETIC providers (neutral ids + shortCodes) so they pin the
// core join/extraction algorithm without naming any real vendor; each real
// provider's actual shortCode + token scheme is covered in its own plugin suite.

describe("modelShortLabel", () => {
  beforeAll(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    // A provider whose version token is the major.minor pulled from a
    // `<family>-<maj>-<min>` id (e.g. "vendora-large-4-8" → "4.8").
    registerTestProvider({
      id: "vendor-a",
      shortCode: "va",
      models: [
        { id: "vendora-large-4-8" },
        { id: "vendora-large-4-8[1m]" },
        { id: "vendora-small-5" },
      ],
      modelVersionToken: (id) => {
        if (!id.startsWith("vendora-")) return undefined
        const m = id.replace(/\[1m\]$/, "").match(/-(\d+)(?:-(\d+))?$/)
        if (!m) return undefined
        return m[2] ? `${m[1]}.${m[2]}` : m[1]
      },
    })
    // A second provider with a different shortCode + a flat version scheme
    // (e.g. "vendorb-7" → "7", "vendorb-4o" → "4o").
    registerTestProvider({
      id: "vendor-b",
      shortCode: "vb",
      models: [{ id: "vendorb-7" }, { id: "vendorb-4o" }],
      modelVersionToken: (id) =>
        id.startsWith("vendorb-") ? id.match(/-([\dox.]+)$/i)?.[1] : undefined,
    })
  })

  afterAll(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
  })

  it("tags a registered model as <shortCode>-<major.minor>", () => {
    expect(modelShortLabel("vendora-large-4-8")).toBe("va-4.8")
    expect(modelShortLabel("vendora-large-4-8[1m]")).toBe("va-4.8")
    // Single-version-number family (no minor): "5" stays "5".
    expect(modelShortLabel("vendora-small-5")).toBe("va-5")
  })

  it("uses each provider's own shortCode + version scheme", () => {
    expect(modelShortLabel("vendorb-7")).toBe("vb-7")
    expect(modelShortLabel("vendorb-4o")).toBe("vb-4o")
  })

  it("falls back to a generic prefix heuristic for ids no provider claims", () => {
    // No registered provider's token parser matches → generic tag + token
    // (the major.minor join is a provider-specific scheme, not the generic
    // path, so the raw version token is kept).
    expect(modelShortLabel("widgetco-9-9")).toBe("widgetco-9-9")
  })

  it("returns empty string for empty input", () => {
    expect(modelShortLabel("")).toBe("")
  })
})
