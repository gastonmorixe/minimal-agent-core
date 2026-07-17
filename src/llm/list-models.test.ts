/**
 * Tests for the REPL picker live-model merger.
 *
 * Guards the cross-provider bare-id collision: two plugins advertising the
 * same slug (e.g. `kimi-k2.6`) must both survive the merge.
 */
import { afterEach, describe, expect, it } from "bun:test"

import { listLiveModelsForPicker } from "./list-models.ts"
import { clearProviderPlugins, registerProviderPlugin } from "./provider-plugin.ts"

describe("listLiveModelsForPicker", () => {
  afterEach(() => {
    clearProviderPlugins()
  })

  it("keeps the same bare id from two providers as two rows", async () => {
    registerProviderPlugin({
      id: "ollama",
      displayName: "Ollama Cloud",
      shortCode: "ol",
      register() {},
      publicModelList: true,
      async listLiveModels() {
        return [{ id: "kimi-k2.6", displayName: "Kimi (Ollama)", createdAt: "2026-07-01" }]
      },
    })
    registerProviderPlugin({
      id: "opencode",
      displayName: "OpenCode Go",
      shortCode: "oc",
      register() {},
      publicModelList: true,
      async listLiveModels() {
        return [
          { id: "kimi-k2.6", displayName: "Kimi (OpenCode)", createdAt: "2026-07-02" },
          { id: "kimi-k3", displayName: "Kimi K3", createdAt: "2026-07-16" },
        ]
      },
    })

    const rows = await listLiveModelsForPicker()
    const ids = rows.map((r) => r.id).sort()
    // Two kimi-k2.6 rows + one kimi-k3
    expect(ids.filter((id) => id === "kimi-k2.6")).toHaveLength(2)
    expect(ids).toContain("kimi-k3")
    expect(rows).toHaveLength(3)

    const names = rows.map((r) => r.display_name).sort()
    expect(names).toContain("Kimi (Ollama)")
    expect(names).toContain("Kimi (OpenCode)")
    expect(names).toContain("Kimi K3")
  })

  it("dedups bare id within a single provider", async () => {
    registerProviderPlugin({
      id: "ollama",
      displayName: "Ollama Cloud",
      shortCode: "ol",
      register() {},
      publicModelList: true,
      async listLiveModels() {
        return [
          { id: "dup", displayName: "First" },
          { id: "dup", displayName: "Second" },
        ]
      },
    })

    const rows = await listLiveModelsForPicker("ollama")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.display_name).toBe("Second")
  })

  it("isolates a failing provider without dropping others", async () => {
    registerProviderPlugin({
      id: "bad",
      displayName: "Bad",
      shortCode: "bd",
      register() {},
      publicModelList: true,
      async listLiveModels() {
        throw new Error("Models API 401: OAuth access token has been revoked.")
      },
    })
    registerProviderPlugin({
      id: "good",
      displayName: "Good",
      shortCode: "gd",
      register() {},
      publicModelList: true,
      async listLiveModels() {
        return [{ id: "good-model", displayName: "Good Model" }]
      },
    })

    const rows = await listLiveModelsForPicker()
    expect(rows.map((r) => r.id)).toEqual(["good-model"])
  })

  it("restricts to providerId when given", async () => {
    registerProviderPlugin({
      id: "a",
      displayName: "A",
      shortCode: "a",
      register() {},
      publicModelList: true,
      async listLiveModels() {
        return [{ id: "shared", displayName: "A shared" }]
      },
    })
    registerProviderPlugin({
      id: "b",
      displayName: "B",
      shortCode: "b",
      register() {},
      publicModelList: true,
      async listLiveModels() {
        return [{ id: "shared", displayName: "B shared" }]
      },
    })

    const rows = await listLiveModelsForPicker("a")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.display_name).toBe("A shared")
  })
})
