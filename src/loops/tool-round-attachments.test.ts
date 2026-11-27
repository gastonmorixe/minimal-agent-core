/**
 * Plugin tool attachments through `executeToolRound`: a plugin `tool_result`
 * with a PNG attachment gives a `tool_result` block of `[text, image]` for a
 * vision model, the same wire shape as a `Read` of a screenshot. The PNG is
 * saved in the session blob dir.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"

import { afterAll, afterEach, describe, expect, test } from "bun:test"

import { defaultCapabilities } from "../llm/capabilities.ts"
import type { ContentBlock, ToolUseBlock } from "../llm/messages.ts"
import { clearModelRegistry, registerModel } from "../llm/model-registry.ts"
import type { PluginLoader } from "../plugins/loader.ts"
import { NOOP_LIFECYCLE } from "../sdk/lifecycle.ts"
import { BlobStore } from "../session/blob-store.ts"
import { loadSession } from "../session/session-restore.ts"
import { SessionStore } from "../session/session-store.ts"
import { fixtureSidebandOrNone, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"
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

  test("is_error: true with an attachment keeps is_error and still sends the image", async () => {
    registerTestModel("vision-model", true)
    const blobDir = join(ROOT, "e", "sid.blobs")
    const result = {
      kind: "tool_result",
      content: "Page failed, last frame attached.",
      is_error: true,
      attachments: [{ bytes: png(10, 10) }],
    }
    const block = await executeToolRound(
      shotTool("toolu_e"),
      ctxFor("vision-model", result, blobDir),
    )
    expect(block.is_error).toBe(true)
    const parts = block.content as ContentBlock[]
    expect(parts.map((p) => p.type)).toEqual(["text", "image"])
    expect(existsSync(join(blobDir, "toolu_e-1.png"))).toBe(true)
  })

  test("a tool on blobSkipTools still gets the attachment file and the image", async () => {
    registerTestModel("vision-model", true)
    const blobDir = join(ROOT, "f", "sid.blobs")
    const result = { kind: "tool_result", content: "ok", attachments: [{ bytes: png(10, 10) }] }
    const ctx = { ...ctxFor("vision-model", result, blobDir), blobSkipTools: new Set(["Shot"]) }
    const block = await executeToolRound(shotTool("toolu_f"), ctx)
    expect((block.content as ContentBlock[]).map((p) => p.type)).toEqual(["text", "image"])
    // The attachment file is not the raw blob of the skip list.
    expect(readdirSync(blobDir)).toEqual(["toolu_f-1.png"])
  })

  test("a blob store with enabled: false writes no file, and the image still goes", async () => {
    registerTestModel("vision-model", true)
    const blobDir = join(ROOT, "g", "sid.blobs")
    const result = { kind: "tool_result", content: "ok", attachments: [{ bytes: png(10, 10) }] }
    const store = new BlobStore({ sid: "sid", dir: blobDir, config: { enabled: false } })
    const ctx = { ...ctxFor("vision-model", result, blobDir), blobStore: store }
    const block = await executeToolRound(shotTool("toolu_g"), ctx)
    const parts = block.content as ContentBlock[]
    expect(parts.map((p) => p.type)).toEqual(["text", "image"])
    expect((parts[0] as { text: string }).text).not.toContain("path=")
    expect(existsSync(blobDir)).toBe(false)
  })

  test.skipIf(!sidebandFixturePresent())(
    "a data URI in the plugin body is scrubbed, and the image block stays",
    async () => {
      registerTestModel("vision-model", true)
      const svg = `data:image/svg+xml;base64,${"A".repeat(600)}`
      const result = {
        kind: "tool_result",
        content: `logo ![x](${svg}) end`,
        attachments: [{ bytes: png(10, 10) }],
      }
      const ctx = ctxFor("vision-model", result, join(ROOT, "h", "sid.blobs"))
      const block = await executeToolRound(shotTool("toolu_h"), ctx)
      const parts = block.content as ContentBlock[]
      expect(parts.map((p) => p.type)).toEqual(["text", "image"])
      const text = (parts[0] as { text: string }).text
      expect(text).not.toContain(";base64,")
      expect(text).toContain("redacted-asset")
      expect(text).toContain("binary-result")
    },
  )

  test("a plugin image block goes to the session JSONL and comes back on resume", async () => {
    registerTestModel("vision-model", true)
    const dir = join(ROOT, "i")
    mkdirSync(dir, { recursive: true })
    const sid = "attach-rt"
    const store = SessionStore.open({
      sid,
      dir,
      model: "vision-model",
      cwd: dir,
      systemHash: "h",
      toolsHash: "h",
      agentVersion: "test",
    })
    const tool = shotTool("toolu_i")
    store.appendUser("go")
    store.appendAssistant([tool], "tool_use")
    const result = { kind: "tool_result", content: "shot", attachments: [{ bytes: png(10, 10) }] }
    const ctx = { ...ctxFor("vision-model", result, join(dir, `${sid}.blobs`)), store }
    const live = await executeToolRound(tool, ctx)
    store.appendAssistant([{ type: "text", text: "done" }], "end_turn")
    const loaded = loadSession(sid, dir)
    const restored = loaded.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b.type === "tool_result")
    // A plugin result with no is_error gives `undefined` live. The record keeps `false`.
    expect(restored).toEqual({ ...live, is_error: live.is_error ?? false })
    const parts = (restored?.content ?? []) as ContentBlock[]
    expect(parts.map((p) => p.type)).toEqual(["text", "image"])
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
