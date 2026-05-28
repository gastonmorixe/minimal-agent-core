import { beforeAll, describe, expect, it } from "bun:test"

import { clearModelRegistry, clearProviderRegistry } from "./index.ts"
import { modelShortLabel } from "./model-label.ts"
import { clearProviderPlugins } from "./provider-plugin.ts"
import { activateBuiltinProviders } from "./providers/index.ts"

describe("modelShortLabel", () => {
  beforeAll(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
    activateBuiltinProviders()
  })

  it("tags registered Anthropic models as anth-<maj>.<min>", () => {
    expect(modelShortLabel("claude-opus-4-8")).toBe("anth-4.8")
    expect(modelShortLabel("claude-opus-4-7")).toBe("anth-4.7")
    expect(modelShortLabel("claude-sonnet-4-6")).toBe("anth-4.6")
    expect(modelShortLabel("claude-haiku-4-5-20251001")).toBe("anth-4.5")
    expect(modelShortLabel("claude-opus-4-8[1m]")).toBe("anth-4.8")
  })

  it("tags registered OpenAI models as oai-<version>", () => {
    expect(modelShortLabel("gpt-5.5")).toBe("oai-5.5")
    expect(modelShortLabel("gpt-5.5-chat")).toBe("oai-5.5")
    expect(modelShortLabel("gpt-4o")).toBe("oai-4o")
    expect(modelShortLabel("o3")).toBe("oai-o3")
  })

  it("falls back to a prefix heuristic for unregistered ids", () => {
    // Not in the registry → heuristic path (no release needed for new ids).
    expect(modelShortLabel("claude-opus-9-9")).toBe("anth-9.9")
    expect(modelShortLabel("gpt-99")).toBe("oai-99")
  })

  it("returns empty string for empty input", () => {
    expect(modelShortLabel("")).toBe("")
  })
})
