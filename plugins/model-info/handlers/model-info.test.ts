import { describe, expect, it } from "bun:test"

import type { ModelInfoSnapshot, TUIContext } from "../../../src/plugins/types.ts"

import handler from "./model-info.ts"

function snapshot(over: Partial<ModelInfoSnapshot> = {}): ModelInfoSnapshot {
  return {
    modelId: "claude-opus-4-8",
    displayName: "Opus 4.8",
    providerId: "anthropic",
    surfaceId: "anthropic-messages",
    knowledgeCutoff: "2025-03",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    modalities: { image: true, audio: false, pdf: true, video: false },
    acceptedInput: { images: ["jpeg", "png", "gif", "webp"], documents: ["pdf", "txt"] },
    thinking: { adaptive: true, extended: false, visible: true, interleaved: true },
    effort: { levels: ["low", "high", "max"], default: "high" },
    caching: { explicit: true, automatic: false, ttls: ["5m", "1h"], reportsCacheHits: true },
    tools: { userDefined: true, parallel: true },
    serverTools: ["web_search"],
    pricing: { inputPerMTok: 5, outputPerMTok: 25, cacheWritePerMTok: 6.25, cacheReadPerMTok: 0.5 },
    resolved: true,
    ...over,
  }
}

function ctx(query: (() => ModelInfoSnapshot | undefined) | undefined): TUIContext {
  return {
    cwd: "/tmp/proj",
    agent: { sessionId: "sid-123", pid: 9, model: "claude-opus-4-8", version: "0.1.0" },
    queryModelInfo: query,
  } as unknown as TUIContext
}

describe("ModelInfo handler", () => {
  it("reports image + document acceptance for a vision model", async () => {
    const r = await handler(ctx(() => snapshot()))
    expect(r.kind).toBe("tool_result")
    if (r.kind !== "tool_result") return
    expect(r.content).toContain("images (jpeg, png, gif, webp)")
    expect(r.content).toContain("documents (pdf, txt)")
    expect(r.content).toContain("Context window: 1,000,000 tokens")
    expect(r.content).toContain("Provider: anthropic")
    expect(r.content).toContain("Session: sid-123")
    expect(r.is_error).toBeFalsy()
  })

  it("lists the modalities NOT accepted", async () => {
    const r = await handler(ctx(() => snapshot()))
    if (r.kind !== "tool_result") throw new Error("expected tool_result")
    expect(r.content).toContain("Input NOT accepted: audio, video")
  })

  it("flags an unregistered model and uses defaults", async () => {
    const r = await handler(ctx(() => snapshot({ resolved: false, providerId: "unknown" })))
    if (r.kind !== "tool_result") throw new Error("expected tool_result")
    expect(r.content).toContain("not registered")
  })

  it("errors gracefully when no model-info provider is wired", async () => {
    const r = await handler(ctx(undefined))
    expect(r.kind).toBe("tool_result")
    if (r.kind !== "tool_result") return
    expect(r.is_error).toBe(true)
  })
})
