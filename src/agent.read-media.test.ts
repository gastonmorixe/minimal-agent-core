import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { Agent } from "./agent.ts"
import type { AuthResult } from "./auth.ts"
import type { ContentBlock, SendOptions, StreamedResponse } from "./client/types.ts"
import { defaultCapabilities } from "./llm/capabilities.ts"
import { clearModelRegistry, registerModel } from "./llm/model-registry.ts"

const auth: AuthResult = { type: "api-key", token: "test-token" }
const dir = mkdtempSync(join(tmpdir(), "agent-read-media-"))

afterEach(() => clearModelRegistry())

function registerVisionModel(id: string, image: boolean): void {
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

function writeImage(name: string): string {
  const p = join(dir, name)
  writeFileSync(p, png(12, 12))
  return p
}

/**
 * sendFn that emits one Read tool_use on round 1, then ends the turn on round
 * 2. Records each round's messages so the test can inspect the tool_result the
 * agent built.
 */
function readThenStop(imgPath: string, records: Array<Record<string, unknown>>) {
  let round = 0
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    records.push(JSON.parse(JSON.stringify({ messages: opts.messages })))
    round++
    if (round === 1) {
      return {
        blocks: [
          { type: "tool_use" as const, id: "call-1", name: "Read", input: { file_path: imgPath } },
        ],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    yield "done"
    return {
      blocks: [{ type: "text" as const, text: "done" }],
      text: "done",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

function lastToolResult(msgs: Array<Record<string, unknown>>): Record<string, unknown> | null {
  for (const msg of msgs) {
    if (msg.role !== "user") continue
    const blocks = msg.content as ContentBlock[]
    for (const b of blocks) {
      if (b.type === "tool_result") return b as unknown as Record<string, unknown>
    }
  }
  return null
}

describe("Agent — Read returns an image block for a vision model", () => {
  it("builds a tool_result with a text caption + image block", async () => {
    registerVisionModel("vision-model", true)
    const imgPath = writeImage("a.png")
    const records: Array<Record<string, unknown>> = []
    const agent = new Agent({ auth, model: "vision-model", sendFn: readThenStop(imgPath, records) })

    const gen = agent.run("what's in the image")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    // Round 2 history carries the tool_result the agent assembled.
    expect(records.length).toBe(2)
    const tr = lastToolResult(records[1]!.messages as Array<Record<string, unknown>>)
    expect(tr).not.toBeNull()
    const content = tr!.content
    expect(Array.isArray(content)).toBe(true)
    const blocks = content as ContentBlock[]
    const text = blocks.find((b) => b.type === "text")
    const image = blocks.find((b) => b.type === "image")
    expect(text).toBeDefined()
    expect(image).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    })
  })

  it("for a non-vision model, the tool_result is a plain string message (no image block)", async () => {
    registerVisionModel("text-model", false)
    const imgPath = writeImage("b.png")
    const records: Array<Record<string, unknown>> = []
    const agent = new Agent({ auth, model: "text-model", sendFn: readThenStop(imgPath, records) })

    const gen = agent.run("read the image")
    while (true) {
      const { done } = await gen.next()
      if (done) break
    }

    const tr = lastToolResult(records[1]!.messages as Array<Record<string, unknown>>)
    expect(tr).not.toBeNull()
    // No media blocks → content stays a plain string, with the honest message.
    expect(typeof tr!.content).toBe("string")
    expect(String(tr!.content)).toContain("doesn't accept image")
  })
})
