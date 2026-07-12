/**
 * Unit tests for {@link PromptContributorAdapter}: plugin prompt block (awaited
 * once), per-turn attachments, and save-echoes.
 */

import { describe, expect, it } from "bun:test"

import type { ContentBlock } from "../../llm/messages.ts"
import type { PluginLoader } from "../../plugins/loader.ts"

import { PromptContributorAdapter } from "./prompt-contributor-adapter.ts"

/** A loader stub whose async prompt block resolves to `block`. */
function loaderStub(block: string | null, onCall?: () => void): PluginLoader {
  const stub = {
    getPromptBlockAsync: async () => {
      onCall?.()
      return block
    },
  }
  return stub as unknown as PluginLoader
}

describe("PromptContributorAdapter", () => {
  it("resolves the plugin prompt block once at create() and serves it synchronously", async () => {
    let calls = 0
    const loader = loaderStub('<ma::sys::tool name="X">body</ma::sys::tool>', () => {
      calls++
    })
    const adapter = await PromptContributorAdapter.create({ loader })
    // Awaited exactly once during create().
    expect(calls).toBe(1)
    const blocks = adapter.systemPromptBlocks()
    expect(blocks).toEqual([{ type: "text", text: '<ma::sys::tool name="X">body</ma::sys::tool>' }])
    // Repeated sync reads do not re-call the loader.
    adapter.systemPromptBlocks()
    expect(calls).toBe(1)
  })

  it("contributes no system block when the plugin block is null or empty", async () => {
    const nullAdapter = await PromptContributorAdapter.create({
      loader: loaderStub(null),
    })
    expect(nullAdapter.systemPromptBlocks()).toEqual([])
    const emptyAdapter = await PromptContributorAdapter.create({
      loader: loaderStub(""),
    })
    expect(emptyAdapter.systemPromptBlocks()).toEqual([])
  })

  it("contributes no system block when there is no loader", async () => {
    const adapter = await PromptContributorAdapter.create({})
    expect(adapter.systemPromptBlocks()).toEqual([])
  })

  it("collects per-turn attachments in producer order, dropping null-on-empty", async () => {
    const a: ContentBlock = { type: "text", text: "A" }
    const b: ContentBlock = { type: "text", text: "B" }
    const adapter = await PromptContributorAdapter.create({
      turnAttachments: [
        { toAttachment: () => a },
        { toAttachment: () => null },
        { toAttachment: () => b },
      ],
    })
    expect(adapter.turnAttachments()).toEqual([a, b])
  })

  it("drains save-echoes via consumeAll", async () => {
    const echoes: ContentBlock[] = [{ type: "text", text: '<ma::agent::memory-saved id="7" />' }]
    let consumed = 0
    const adapter = await PromptContributorAdapter.create({
      saveEcho: {
        consumeAll: () => {
          consumed++
          return echoes
        },
      },
    })
    expect(adapter.saveEchoes()).toEqual(echoes)
    expect(consumed).toBe(1)
  })

  it("returns [] save-echoes when no collector is wired", async () => {
    const adapter = await PromptContributorAdapter.create({})
    expect(adapter.saveEchoes()).toEqual([])
  })

  it("splits getPromptBlocksAsync into sessionContext + afterInstructions", async () => {
    let calls = 0
    const loader = {
      getPromptBlocksAsync: async () => {
        calls++
        return {
          afterInstructions: "PLAIN GUIDANCE",
          sessionContext: '<ma::sys::context name="env">ENV</ma::sys::context>',
        }
      },
    } as unknown as PluginLoader
    const adapter = await PromptContributorAdapter.create({ loader })
    expect(calls).toBe(1)
    expect(adapter.afterInstructionsBlocks()).toEqual([{ type: "text", text: "PLAIN GUIDANCE" }])
    expect(adapter.systemPromptBlocks()).toEqual([
      {
        type: "text",
        text: '<ma::sys::context name="env">ENV</ma::sys::context>',
      },
    ])
    adapter.afterInstructionsBlocks()
    expect(calls).toBe(1)
  })

  it("legacy getPromptBlockAsync stubs still work (afterInstructions empty)", async () => {
    const adapter = await PromptContributorAdapter.create({
      loader: loaderStub("SESSION ONLY"),
    })
    expect(adapter.systemPromptBlocks()).toEqual([{ type: "text", text: "SESSION ONLY" }])
    expect(adapter.afterInstructionsBlocks()).toEqual([])
  })
})
