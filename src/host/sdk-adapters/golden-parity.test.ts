/**
 * G1 — Golden final-answer parity (the load-bearing gate).
 *
 * For a fixed prompt + a fixed fake transport, the modern
 * {@link AgentCore} + the Tier-1 adapters must produce the BYTE-IDENTICAL final
 * answer to the legacy {@link Agent}. Two runners, one scripted transport, diff
 * the accumulated yielded text. This is THE guard against silent drift when the
 * non-interactive `--output-format json` / `stream-json` path swaps its engine.
 *
 * Covered scenarios:
 *   1. A plain multi-chunk text turn (no tools).
 *   2. A tool-using turn (round 1 = tool_use, round 2 = final text), which
 *      drives the ToolExecutorAdapter's verbatim `executeToolRound` reuse.
 *   3. A reflection-ack turn (the ack tag is stripped from the yielded text on
 *      both paths identically).
 *
 * The transport is scripted per-round and re-created fresh for each runner, so
 * both engines see the same responses regardless of how each assembles the
 * request. Parity is asserted on the ANSWER (yielded text), which is the
 * consumer-visible contract.
 */

import { describe, expect, it } from "bun:test"

import { Agent } from "../../agent/agent.ts"
import type { AuthResult } from "../../auth/auth.ts"
import type { StreamedResponse } from "../../llm/transport/types.ts"
import type { PluginLoader } from "../../plugins/loader.ts"

import { buildAgentCore } from "./build-agent-core.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const MODEL = "test-model"

type SendFn = () => AsyncGenerator<string, StreamedResponse, undefined>

/** Drain a run generator, returning the concatenated yielded text. */
async function drainText(
  gen: AsyncGenerator<string, StreamedResponse, undefined>,
): Promise<string> {
  let text = ""
  while (true) {
    const { done, value } = await gen.next()
    if (done) return text
    text += value
  }
}

/** Run the legacy Agent and return its final answer text. */
async function runLegacy(
  sendFn: SendFn,
  loader: PluginLoader | null,
  prompt: string,
): Promise<string> {
  const agent = new Agent({ auth: AUTH, model: MODEL, sendFn, loader })
  return drainText(agent.run(prompt))
}

/** Run AgentCore + adapters and return its final answer text. */
async function runCore(
  sendFn: SendFn,
  loader: PluginLoader | null,
  prompt: string,
): Promise<string> {
  const core = await buildAgentCore({
    auth: AUTH,
    model: MODEL,
    sendFn,
    loader,
    modeManager: null,
    store: null,
    blobStore: null,
    saveEcho: null,
    turnAttachments: [],
  })
  return drainText(core.run(prompt))
}

/** A loader stub exposing one plugin tool via dispatch (in-repo, no ./plugins). */
function widgetLoader(content: string): PluginLoader {
  const stub = {
    hasTool: (name: string) => name === "Widget",
    dispatch: async () => ({ kind: "tool_result" as const, content, is_error: false }),
    getExtraTools: () => [
      { name: "Widget", description: "a fixture tool", input_schema: { type: "object" } },
    ],
    getPromptBlockAsync: async () => null,
    getPromptBlock: () => null,
    getToolAliases: () => new Map<string, string>(),
  }
  return stub as unknown as PluginLoader
}

describe("G1 — golden final-answer parity (AgentCore+adapters === legacy Agent)", () => {
  it("plain multi-chunk text turn yields byte-identical answers", async () => {
    const script: SendFn = async function* () {
      yield "The quick "
      yield "brown fox "
      yield "jumps."
      return {
        blocks: [{ type: "text" as const, text: "The quick brown fox jumps." }],
        text: "The quick brown fox jumps.",
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const legacy = await runLegacy(script, null, "tell me a sentence")
    const core = await runCore(script, null, "tell me a sentence")
    expect(core).toBe(legacy)
    expect(core).toBe("The quick brown fox jumps.")
  })

  it("tool-using turn yields byte-identical final answers", async () => {
    // Round 1: a tool_use. Round 2: the final text. Fresh state per runner.
    const makeScript = (): SendFn => {
      let round = 0
      return async function* () {
        round++
        if (round === 1) {
          return {
            blocks: [{ type: "tool_use" as const, id: "toolu_1", name: "Widget", input: { q: 1 } }],
            text: "",
            stopReason: "tool_use",
          } as StreamedResponse
        }
        yield "Widget said hello."
        return {
          blocks: [{ type: "text" as const, text: "Widget said hello." }],
          text: "Widget said hello.",
          stopReason: "end_turn",
        } as StreamedResponse
      }
    }
    const legacy = await runLegacy(makeScript(), widgetLoader("hello"), "use the widget")
    const core = await runCore(makeScript(), widgetLoader("hello"), "use the widget")
    expect(core).toBe(legacy)
    expect(core).toBe("Widget said hello.")
  })

  it("reflection-ack text is stripped identically on both paths", async () => {
    const script: SendFn = async function* () {
      const body = 'Working. <ma::agent::reflection-ack silence-for="2" reason="batch" /> Done.'
      yield body
      return {
        blocks: [{ type: "text" as const, text: body }],
        text: body,
        stopReason: "end_turn",
      } as StreamedResponse
    }
    const legacy = await runLegacy(script, null, "go")
    const core = await runCore(script, null, "go")
    expect(core).toBe(legacy)
    // The ack tag is stripped from the yielded answer.
    expect(core).not.toContain("reflection-ack")
  })
})
