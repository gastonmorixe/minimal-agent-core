/**
 * `resolveUtilityModel` and `host.models.utilityFor` (SPEC §4.1-4.3, R11).
 * Fake providers and models only; no network.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { buildPluginHost } from "../plugins/host/factory.ts"
import type { UtilityModelRecommendation } from "../plugins/types.ts"

import { defaultCapabilities } from "./capabilities.ts"
import { resolveUtilityModel } from "./model-info.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  type ModelEntry,
  registerModel,
  registerProvider,
} from "./model-registry.ts"
import type { ProviderAdapter } from "./provider.ts"

function reset(): void {
  clearModelRegistry()
  clearProviderRegistry()
}

beforeEach(reset)
afterEach(reset)

function model(
  id: string,
  providerId: string,
  tags: string[],
  inputUSD: number | undefined,
  structured = true,
  outputUSD = 1,
): void {
  registerModel({
    id,
    providerId,
    surfaceId: "test-surface",
    displayName: id,
    tags,
    capabilities: { ...defaultCapabilities(), structuredOutputs: structured },
    pricing: {
      inputUSD,
      outputUSD,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    } as ModelEntry["pricing"],
  })
}

function provider(id: string, recommend?: () => UtilityModelRecommendation | undefined): void {
  registerProvider({
    id,
    displayName: id,
    surfaces: ["test-surface"],
    validate: () => ({ ok: true }),
    run: async function* () {},
    ...(recommend ? { recommendUtilityModel: recommend } : {}),
  } as unknown as ProviderAdapter)
}

describe("resolveUtilityModel (R11: provider recommendation only)", () => {
  it("the recommendation gives its model, effort and stream", () => {
    model("big-1", "prov-a", ["utility"], 0.2)
    model("small-1", "prov-a", [], 0.1)
    provider("prov-a", () => ({
      modelId: "small-1",
      structured: "json_schema",
      thinkingOff: true,
      effort: "low",
      stream: "off",
    }))
    const r = resolveUtilityModel("prov-a")
    expect(r).toEqual({
      modelId: "small-1",
      providerId: "prov-a",
      structured: "json_schema",
      thinkingOff: true,
      effort: "low",
      stream: "off",
      pricing: {
        inputUSD: 0.1,
        outputUSD: 1,
        cacheWriteUSD: 0,
        cacheReadUSD: 0,
        webSearchPerCallUSD: 0,
      },
    })
  })

  it("absent effort and stream stay absent; bad values are dropped", () => {
    model("small-1", "prov-a", [], 0.1)
    provider("prov-a", () => ({ modelId: "small-1", structured: "json_schema" }))
    const r = resolveUtilityModel("prov-a")
    expect(r?.effort).toBeUndefined()
    expect(r?.stream).toBeUndefined()
    provider(
      "prov-a",
      () =>
        ({
          modelId: "small-1",
          structured: "json_schema",
          effort: "max",
          stream: "maybe",
        }) as unknown as UtilityModelRecommendation,
    )
    const bad = resolveUtilityModel("prov-a")
    expect(bad?.modelId).toBe("small-1")
    expect(bad?.effort).toBeUndefined()
    expect(bad?.stream).toBeUndefined()
  })

  it("adapter structured none is kept", () => {
    model("small-1", "prov-a", [], 0.1)
    provider("prov-a", () => ({ modelId: "small-1", structured: "none" }))
    expect(resolveUtilityModel("prov-a")?.structured).toBe("none")
  })

  it("no recommendation: undefined, even when a model has the tag utility", () => {
    model("util-1", "prov-a", ["utility"], 0.1)
    model("fast-1", "prov-a", ["fast"], 0.1)
    provider("prov-a")
    expect(resolveUtilityModel("prov-a")).toBeUndefined()
    expect(resolveUtilityModel("prov-a", { maxUsdPerMTokIn: 10 })).toBeUndefined()
  })

  it("adapter throws, returns undefined or an unknown id: undefined (no tag fallback)", () => {
    model("util-1", "prov-a", ["utility"], 0.1)
    provider("prov-a", () => {
      throw new Error("boom")
    })
    expect(resolveUtilityModel("prov-a")).toBeUndefined()
    provider("prov-a", () => undefined)
    expect(resolveUtilityModel("prov-a")).toBeUndefined()
    provider("prov-a", () => ({ modelId: "not-registered", structured: "json_schema" }))
    expect(resolveUtilityModel("prov-a")).toBeUndefined()
  })

  it("the input ceiling still rejects the recommendation", () => {
    model("costly-1", "prov-a", [], 5)
    model("util-1", "prov-a", ["utility"], 0.1)
    provider("prov-a", () => ({ modelId: "costly-1", structured: "json_schema" }))
    expect(resolveUtilityModel("prov-a")).toBeUndefined()
    expect(resolveUtilityModel("prov-a", { maxUsdPerMTokIn: 6 })?.modelId).toBe("costly-1")
  })

  it("B6: the output price ceiling (default 5) still rejects the recommendation", () => {
    model("adapter-costly-out", "prov-b", [], 0.2, true, 20)
    provider("prov-b", () => ({ modelId: "adapter-costly-out", structured: "json_schema" }))
    expect(resolveUtilityModel("prov-b")).toBeUndefined()
    expect(resolveUtilityModel("prov-b", { maxUsdPerMTokOut: 25 })?.modelId).toBe(
      "adapter-costly-out",
    )
    model("at-ceiling", "prov-c", [], 1, true, 5)
    provider("prov-c", () => ({ modelId: "at-ceiling", structured: "json_schema" }))
    expect(resolveUtilityModel("prov-c")?.modelId).toBe("at-ceiling")
  })

  it("unknown price is rejected; a zero price passes", () => {
    model("no-price", "prov-a", [], undefined)
    provider("prov-a", () => ({ modelId: "no-price", structured: "json_schema" }))
    expect(resolveUtilityModel("prov-a")).toBeUndefined()
    model("local-1", "prov-a", [], 0)
    provider("prov-a", () => ({ modelId: "local-1", structured: "json_schema" }))
    expect(resolveUtilityModel("prov-a")?.modelId).toBe("local-1")
  })

  it("unknown provider or empty id: undefined", () => {
    expect(resolveUtilityModel("no-such-provider")).toBeUndefined()
    expect(resolveUtilityModel("")).toBeUndefined()
  })

  it("never the session model, unless allowSessionModel", () => {
    model("session-1", "prov-a", ["production"], 0.5)
    provider("prov-a")
    expect(resolveUtilityModel("prov-a", { sessionModelId: "session-1" })).toBeUndefined()
    expect(
      resolveUtilityModel("prov-a", { sessionModelId: "session-1", allowSessionModel: true })
        ?.modelId,
    ).toBe("session-1")
  })

  it("allowSessionModel still needs structured outputs and the ceiling", () => {
    model("plain-1", "prov-a", [], 0.5, false)
    model("costly-1", "prov-a", [], 5)
    provider("prov-a")
    const opts = { allowSessionModel: true }
    expect(resolveUtilityModel("prov-a", { ...opts, sessionModelId: "plain-1" })).toBeUndefined()
    expect(resolveUtilityModel("prov-a", { ...opts, sessionModelId: "costly-1" })).toBeUndefined()
  })

  it("same provider only: a recommendation of another provider's model is rejected", () => {
    model("util-a", "prov-a", ["utility"], 0.1)
    model("other-b", "prov-b", [], 0.1)
    provider("prov-a", () => ({ modelId: "other-b", structured: "json_schema" }))
    provider("prov-b", () => ({ modelId: "other-b", structured: "json_schema" }))
    expect(resolveUtilityModel("prov-a")).toBeUndefined()
    expect(resolveUtilityModel("prov-b")?.modelId).toBe("other-b")
    expect(resolveUtilityModel("prov-b")?.providerId).toBe("prov-b")
  })
})

describe("host.models.utilityFor", () => {
  it("is absent without models:read (capability gating)", () => {
    expect(buildPluginHost({ capabilities: [] }).models).toBeUndefined()
    expect(buildPluginHost({ capabilities: ["llm:complete"] }).models).toBeUndefined()
  })

  it("resolves the given provider, and the live provider by default", () => {
    model("util-a", "prov-a", [], 0.1)
    model("util-b", "prov-b", [], 0.1)
    provider("prov-a", () => ({ modelId: "util-a", structured: "json_schema" }))
    provider("prov-b", () => ({ modelId: "util-b", structured: "json_schema" }))
    const host = buildPluginHost({
      capabilities: ["models:read"],
      runMode: () => ({ mode: "repl", interactive: true, providerId: "prov-b" }),
    })
    const utilityFor = host.models?.utilityFor
    expect(typeof utilityFor).toBe("function")
    expect(utilityFor?.("prov-a")?.modelId).toBe("util-a")
    expect(utilityFor?.()?.modelId).toBe("util-b")
    expect(utilityFor?.("no-such-provider")).toBeUndefined()
  })

  it("llmSide.sessionProviderId overrides the run-mode provider", () => {
    model("util-a", "prov-a", [], 0.1)
    provider("prov-a", () => ({ modelId: "util-a", structured: "json_schema" }))
    const host = buildPluginHost({
      capabilities: ["models:read"],
      llmSide: { sessionProviderId: () => "prov-a" },
      runMode: () => ({ mode: "repl", interactive: true, providerId: "prov-b" }),
    })
    expect(host.models?.utilityFor?.()?.modelId).toBe("util-a")
  })

  it("the default never returns the session default model", () => {
    model("default-1", "prov-a", ["production"], 0.1)
    provider("prov-a")
    const host = buildPluginHost({
      capabilities: ["models:read"],
      runMode: () => ({ mode: "repl", interactive: true, providerId: "prov-a" }),
    })
    expect(host.models?.utilityFor?.()).toBeUndefined()
  })
})
