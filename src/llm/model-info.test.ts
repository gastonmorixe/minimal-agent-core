import { afterEach, describe, expect, it } from "bun:test"

import { defaultCapabilities } from "./capabilities.ts"
import { buildModelInfoSnapshot } from "./model-info.ts"
import { clearModelRegistry, type ModelEntry, registerModel } from "./model-registry.ts"

afterEach(() => clearModelRegistry())

function registerVisionModel(over: Partial<ModelEntry> = {}): void {
  registerModel({
    id: "test-vision",
    providerId: "testprov",
    surfaceId: "anthropic-messages",
    displayName: "Test Vision",
    knowledgeCutoff: "2025-01",
    capabilities: {
      ...defaultCapabilities(),
      contextWindow: 200_000,
      maxOutputTokens: 8192,
      modalities: { image: true, audio: false, pdf: true, video: false },
      effort: { levels: ["low", "high"], default: "high" },
    },
    pricing: {
      inputUSD: 3,
      outputUSD: 15,
      cacheWriteUSD: 3.75,
      cacheReadUSD: 0.3,
      webSearchPerCallUSD: 0,
    },
    ...over,
  })
}

describe("buildModelInfoSnapshot", () => {
  it("maps a registered vision model's capabilities", () => {
    registerVisionModel()
    const s = buildModelInfoSnapshot("test-vision")
    expect(s.resolved).toBe(true)
    expect(s.providerId).toBe("testprov")
    expect(s.modalities).toEqual({ image: true, audio: false, pdf: true, video: false })
    expect(s.acceptedInput.images).toEqual(["jpeg", "png", "gif", "webp"])
    expect(s.acceptedInput.documents).toEqual(["pdf", "txt"])
    expect(s.contextWindow).toBe(200_000)
    expect(s.effort).toEqual({ levels: ["low", "high"], default: "high" })
    expect(s.pricing.inputPerMTok).toBe(3)
  })

  it("omits acceptedInput entries for modalities the model lacks", () => {
    registerModel({
      id: "text-only",
      providerId: "testprov",
      surfaceId: "openai-chat-completions",
      displayName: "Text Only",
      capabilities: { ...defaultCapabilities() }, // all modalities false
      pricing: {
        inputUSD: 1,
        outputUSD: 2,
        cacheWriteUSD: 0,
        cacheReadUSD: 0,
        webSearchPerCallUSD: 0,
      },
    })
    const s = buildModelInfoSnapshot("text-only")
    expect(s.modalities.image).toBe(false)
    expect(s.acceptedInput.images).toBeUndefined()
    expect(s.acceptedInput.documents).toBeUndefined()
  })

  it("resolves aliases to the canonical entry", () => {
    registerVisionModel({ aliases: ["tv-alias"] })
    expect(buildModelInfoSnapshot("tv-alias").modelId).toBe("test-vision")
  })

  it("returns a resolved=false default for unknown ids", () => {
    const s = buildModelInfoSnapshot("not-a-model")
    expect(s.resolved).toBe(false)
    expect(s.providerId).toBe("unknown")
    expect(s.modalities.image).toBe(false)
    expect(s.contextWindow).toBe(0)
  })
})
