/**
 * A plugin registers models through `ctx.models.register`, which takes
 * untyped data, so a model can arrive with no `capabilities.modalities`.
 * Before this fix, `resolveInputMimeTypes` threw on such a model, and a turn
 * failed at the first media resolution (for example a Read).
 */

import { afterEach, describe, expect, it } from "bun:test"

import { defaultMediaLimits } from "../media/default-limits.ts"
import { resolveModelMediaContext } from "../media/tool-context.ts"

import { resolveInputMimeTypes } from "./capabilities.ts"
import { modalityViolations, stripUnsupportedModalities } from "./modality-check.ts"
import { clearModelRegistry, findModel, type ModelEntry, registerModel } from "./model-registry.ts"

/** A plugin model with capabilities but no `modalities`, as the web stub registers it. */
function noModalitiesEntry(id: string): ModelEntry {
  return {
    id,
    providerId: "stub",
    capabilities: { contextWindow: 200_000, maxOutputTokens: 8192 },
  } as unknown as ModelEntry
}

describe("a model with no capabilities.modalities", () => {
  afterEach(() => clearModelRegistry())

  it("resolveInputMimeTypes accepts nothing from the provider default, and does not throw", () => {
    const caps = { inputMimeTypes: undefined } as unknown as Parameters<
      typeof resolveInputMimeTypes
    >[0]
    expect(resolveInputMimeTypes(caps, ["image/png", "application/pdf"])).toEqual([])
  })

  it("registerModel fills the all-false default modalities", () => {
    registerModel(noModalitiesEntry("no-mod-1"))
    const caps = findModel("no-mod-1")?.capabilities
    expect(caps?.modalities).toEqual({ image: false, audio: false, pdf: false, video: false })
    expect(caps?.contextWindow).toBe(200_000)
  })

  it("registerModel keeps the flags a plugin did set, and fills only the missing ones", () => {
    const entry = noModalitiesEntry("no-mod-2")
    ;(entry.capabilities as unknown as { modalities: object }).modalities = { image: true }
    registerModel(entry)
    expect(findModel("no-mod-2")?.capabilities.modalities).toEqual({
      image: true,
      audio: false,
      pdf: false,
      video: false,
    })
  })

  it("the media gate resolves for the model (the tool path no longer crashes)", () => {
    registerModel(noModalitiesEntry("no-mod-3"))
    const ctx = resolveModelMediaContext("no-mod-3")
    expect(ctx).toBeDefined()
    expect([...(ctx?.limits.acceptedMimeTypes ?? [])]).toEqual([])
    expect(ctx?.limits.maxBytesPerItem).toBe(defaultMediaLimits().maxBytesPerItem)
  })

  it("the older modality readers work on the registered model (an attached image)", () => {
    registerModel(noModalitiesEntry("no-mod-4"))
    const caps = findModel("no-mod-4")!.capabilities
    const messages = [
      {
        role: "user" as const,
        content: [
          { type: "text" as const, text: "see" },
          {
            type: "image" as const,
            source: { kind: "base64" as const, mediaType: "image/png", data: "iVBORw0KGgo=" },
          },
        ],
      },
    ]
    expect(modalityViolations(messages, caps, "no-mod-4")).toHaveLength(1)
    const stripped = stripUnsupportedModalities(messages, caps, "no-mod-4")
    expect(stripped[0]!.content.map((b) => b.type)).toEqual(["text", "text"])
  })
})
