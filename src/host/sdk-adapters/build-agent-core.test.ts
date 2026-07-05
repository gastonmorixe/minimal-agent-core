/**
 * Unit tests for {@link buildAgentCore}: the async Tier-1 assembly seam.
 * Verifies it returns a runnable {@link AgentCore} that reflects the wired
 * adapters (tools listed, plugin prompt block folded into the system prompt,
 * no crash on the minimal null-collaborator config).
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../../auth/auth.ts"
import type { SendOptions, StreamedResponse } from "../../llm/transport/types.ts"
import type { PluginLoader } from "../../plugins/loader.ts"
import { TOOL_DEFINITIONS } from "../../tools/tools.ts"

import { buildAgentCore } from "./build-agent-core.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

async function drain(gen: AsyncGenerator<string, StreamedResponse, undefined>): Promise<string> {
  let text = ""
  while (true) {
    const { done, value } = await gen.next()
    if (done) return text
    text += value
  }
}

describe("buildAgentCore", () => {
  it("returns a runnable AgentCore with the minimal null-collaborator config", async () => {
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      yield "hi"
      return {
        blocks: [{ type: "text" as const, text: "hi" }],
        text: "hi",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const core = await buildAgentCore({
      auth: AUTH,
      model: "test-model",
      sendFn,
      loader: null,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    })
    expect(await drain(core.run("go"))).toBe("hi")
  })

  it("folds the plugin prompt block into the system prompt sent to the transport", async () => {
    let capturedSystem: unknown
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      capturedSystem = opts.system
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const loader = {
      getPromptBlockAsync: async () =>
        '<ma::sys::tool name="Widget">MAGIC_MARKER_TEXT</ma::sys::tool>',
      getExtraTools: () => [],
      getToolAliases: () => new Map<string, string>(),
      hasTool: () => false,
    } as unknown as PluginLoader

    const core = await buildAgentCore({
      auth: AUTH,
      model: "test-model",
      sendFn,
      loader,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    })
    await drain(core.run("go"))
    // The plugin block text must appear somewhere in the resolved system prompt.
    const systemStr = JSON.stringify(capturedSystem)
    expect(systemStr).toContain("MAGIC_MARKER_TEXT")
  })

  it("advertises core tools (and plugin tools) on the request", async () => {
    let capturedTools: Array<{ name: string }> = []
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      capturedTools = (opts.tools ?? []) as Array<{ name: string }>
      yield "ok"
      return {
        blocks: [{ type: "text" as const, text: "ok" }],
        text: "ok",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const loader = {
      getPromptBlockAsync: async () => null,
      getExtraTools: () => [{ name: "Widget", description: "w", input_schema: {} }],
      getToolAliases: () => new Map<string, string>(),
      hasTool: () => false,
    } as unknown as PluginLoader

    const core = await buildAgentCore({
      auth: AUTH,
      model: "test-model",
      sendFn,
      loader,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    })
    await drain(core.run("go"))
    const names = capturedTools.map((t) => t.name)
    // Core built-ins present, plugin tool appended.
    for (const t of TOOL_DEFINITIONS) expect(names).toContain(t.name)
    expect(names).toContain("Widget")
  })
})
