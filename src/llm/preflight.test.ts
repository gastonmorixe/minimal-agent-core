/**
 * Tests for `src/llm/preflight.ts` — the provider-neutral preflight
 * wrapper the agent calls.
 *
 * Covers:
 *  - clean request (no provider, missing model) returns []
 *  - provider without preflight() returns []
 *  - provider with preflight() returns its issues
 *  - throwing provider preflight returns [] (defensive)
 *  - applyResolution dispatches to the provider correctly
 *  - applyResolution throws when provider has no applyResolution
 */

import { afterEach, describe, expect, it } from "bun:test"

import type { CanonicalEvent } from "./canonical-events.ts"
import type { CanonicalRequest } from "./canonical-request.ts"
import { defaultCapabilities } from "./capabilities.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  type ModelEntry,
  registerModel,
  registerProvider,
} from "./model-registry.ts"
import { applyPreflightResolution, runPreflight } from "./preflight.ts"
import { ANTHROPIC_OPUS_4X_STANDARD } from "./pricing.ts"
import {
  type PreflightIssue,
  type PreflightResolution,
  type ProviderAdapter,
  type RunContext,
} from "./provider.ts"

function makeModel(): ModelEntry {
  return {
    id: "pf-model",
    providerId: "pf-prov",
    surfaceId: "custom",
    displayName: "Preflight Test Model",
    capabilities: defaultCapabilities(),
    pricing: ANTHROPIC_OPUS_4X_STANDARD,
  }
}

function makeReq(modelId = "pf-model"): CanonicalRequest {
  return {
    modelId,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  }
}

function makeAdapter(opts: {
  preflight?: ProviderAdapter["preflight"]
  applyResolution?: ProviderAdapter["applyResolution"]
}): ProviderAdapter {
  return {
    id: "pf-prov",
    displayName: "Preflight Provider",
    surfaces: ["custom"],
    validate: () => ({ ok: true, errors: [] }),
    async *run(_req, _model, _ctx: RunContext): AsyncIterable<CanonicalEvent> {
      // not exercised in these tests
      return
    },
    ...opts,
  }
}

describe("runPreflight", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
  })

  it("returns [] when the model can't be resolved", () => {
    expect(runPreflight(makeReq("nope"))).toEqual([])
  })

  it("returns [] when the provider has no preflight()", () => {
    registerModel(makeModel())
    registerProvider(makeAdapter({}))
    expect(runPreflight(makeReq())).toEqual([])
  })

  it("returns [] when the provider's preflight returns undefined", () => {
    registerModel(makeModel())
    registerProvider(makeAdapter({ preflight: () => undefined as unknown as PreflightIssue[] }))
    expect(runPreflight(makeReq())).toEqual([])
  })

  it("returns the provider's issues verbatim", () => {
    const issues: PreflightIssue[] = [
      {
        code: "x.test-issue",
        title: "Test issue",
        detail: "Body",
        options: [
          { id: "a", label: "Option A", isDefault: true },
          { id: "b", label: "Option B" },
        ],
      },
    ]
    registerModel(makeModel())
    registerProvider(makeAdapter({ preflight: () => issues }))
    expect(runPreflight(makeReq())).toEqual(issues)
  })

  it("catches exceptions from preflight() and returns []", () => {
    registerModel(makeModel())
    registerProvider(
      makeAdapter({
        preflight: () => {
          throw new Error("adapter bug")
        },
      }),
    )
    expect(runPreflight(makeReq())).toEqual([])
  })
})

describe("applyPreflightResolution", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
  })

  it("dispatches to the provider's applyResolution()", () => {
    const modifiedReq: CanonicalRequest = {
      modelId: "pf-model",
      messages: [{ role: "user", content: [{ type: "text", text: "rewritten" }] }],
    }
    registerModel(makeModel())
    registerProvider(
      makeAdapter({
        applyResolution: (_req, code, option): PreflightResolution => {
          expect(code).toBe("x.test-issue")
          expect(option).toBe("a")
          return { kind: "modify-request", request: modifiedReq }
        },
      }),
    )
    const result = applyPreflightResolution(makeReq(), "x.test-issue", "a")
    expect(result.kind).toBe("modify-request")
    if (result.kind === "modify-request") {
      expect(result.request).toBe(modifiedReq)
    }
  })

  it("supports cancel resolutions", () => {
    registerModel(makeModel())
    registerProvider(
      makeAdapter({
        applyResolution: (): PreflightResolution => ({ kind: "cancel" }),
      }),
    )
    const result = applyPreflightResolution(makeReq(), "x.test-issue", "cancel")
    expect(result.kind).toBe("cancel")
  })

  it("supports adoptModelId in modify-request", () => {
    const newId = "pf-model-original"
    registerModel(makeModel())
    registerProvider(
      makeAdapter({
        applyResolution: (req): PreflightResolution => ({
          kind: "modify-request",
          request: req,
          adoptModelId: newId,
        }),
      }),
    )
    const result = applyPreflightResolution(makeReq(), "x.test-issue", "switch")
    expect(result.kind).toBe("modify-request")
    if (result.kind === "modify-request") {
      expect(result.adoptModelId).toBe(newId)
    }
  })

  it("throws when the provider has no applyResolution()", () => {
    registerModel(makeModel())
    registerProvider(makeAdapter({}))
    expect(() => applyPreflightResolution(makeReq(), "x.test-issue", "a")).toThrow(
      /no applyResolution/,
    )
  })

  it("throws when the model is unresolvable", () => {
    expect(() => applyPreflightResolution(makeReq("nope"), "x", "a")).toThrow()
  })
})
