/**
 * Plugin tool attachments through `executeToolRound`: a plugin `tool_result`
 * with a PNG attachment gives a `tool_result` block of `[text, image]` for a
 * vision model, the same wire shape as a `Read` of a screenshot. The PNG is
 * saved in the session blob dir.
 */
import { existsSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import { defaultCapabilities } from "../llm/capabilities.ts"
import type { ContentBlock, ToolUseBlock } from "../llm/messages.ts"
import { clearModelRegistry, registerModel } from "../llm/model-registry.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { BlobStore } from "../session/blob-store.ts"
import { fixtureSidebandOrNone } from "../test-utils/sideband-fixture.ts"
import {
  fixtureSyntheticTextResolver,
  textFixturesPresent,
} from "../test-utils/text-fixture-providers.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { executeToolRound, type ToolRoundContext } from "./tool-round.ts"

const ROOT = join(import.meta.dirname, "..", "..", "tmp", `tool-round-attach-${process.pid}`)
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))
afterEach(() => clearModelRegistry())

function registerTestModel(id: string, image: boolean): void {
  registerModel({
    id,
    providerId: "testprov",
    surfaceId: "test-surface",
    displayName: id,
    capabilities: {
      ...defaultCapabilities(),
      contextWindow: 200_000,
      maxOutputTokens: 8_000,
      modalities: { image, audio: false, pdf: false, video: false },
    },
    pricing: {
      inputUSD: 1,
      outputUSD: 1,
      cacheWriteUSD: 1,
      cacheReadUSD: 1,
      webSearchPerCallUSD: 0,
    },
  })
}

function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(24)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  b[19] = w
  b[23] = h
  return b
}

const shotTool = (id: string): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "Shot",
  input: {},
})

function loaderStub(result: unknown): PluginLoader {
  return {
    hasTool: (name: string) => name === "Shot",
    dispatch: async () => result,
  } as unknown as PluginLoader
}

function ctxFor(model: string, result: unknown, blobDir: string): ToolRoundContext {
  return {
    sidebandApi: fixtureSidebandOrNone(),
    loader: loaderStub(result),
    modeManager: null,
    blobStore: new BlobStore({ sid: "sid", dir: blobDir }),
    blobSkipTools: new Set(),
    feedbackTracker: new ToolFeedbackTracker(),
    model,
    store: null,
    lifecycle: NOOP_LIFECYCLE,
    text: fixtureSyntheticTextResolver(),
  }
}

describe.skipIf(!textFixturesPresent())("plugin tool attachments in the tool round", () => {
  test("a PNG attachment gives a tool_result of [text, image] for a vision model", async () => {
    registerTestModel("vision-model", true)
    const blobDir = join(ROOT, "a", "sid.blobs")
    const result = {
      kind: "tool_result",
      content: "Screenshot taken.",
      attachments: [{ bytes: png(10, 10), mimeType: "image/png", label: "screenshot" }],
    }
    const block = await executeToolRound(
      shotTool("toolu_a"),
      ctxFor("vision-model", result, blobDir),
    )
    expect(Array.isArray(block.content)).toBe(true)
    const parts = block.content as ContentBlock[]
    expect(parts[0]?.type).toBe("text")
    expect((parts[0] as { text: string }).text.startsWith("Screenshot taken.")).toBe(true)
    expect((parts[0] as { text: string }).text).toContain("shown to the model")
    expect(parts[1]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    })
    expect(parts).toHaveLength(2)
    expect(existsSync(join(blobDir, "toolu_a-1.png"))).toBe(true)
  })

  test("a model with no image modality gets a plain text tool_result", async () => {
    registerTestModel("text-model", false)
    const blobDir = join(ROOT, "b", "sid.blobs")
    const result = {
      kind: "tool_result",
      content: "Screenshot taken.",
      attachments: [{ bytes: png(10, 10) }],
    }
    const block = await executeToolRound(shotTool("toolu_b"), ctxFor("text-model", result, blobDir))
    expect(typeof block.content).toBe("string")
    expect(block.content as string).toContain("does not accept image")
    expect(existsSync(join(blobDir, "toolu_b-1.png"))).toBe(true)
  })

  test("a result with no attachments keeps the plain string content", async () => {
    registerTestModel("vision-model", true)
    const result = { kind: "tool_result", content: "plain" }
    const block = await executeToolRound(
      shotTool("toolu_c"),
      ctxFor("vision-model", result, join(ROOT, "c", "sid.blobs")),
    )
    expect(block.content).toBe("plain")
  })
})
