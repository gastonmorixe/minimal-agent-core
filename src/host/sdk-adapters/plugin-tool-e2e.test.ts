/**
 * G4 — Plugin/tool end-to-end on the NEW path.
 *
 * A fixture plugin (an in-repo loader STUB — Wave G deleted on-disk `./plugins`)
 * contributes a real tool AND a prompt fragment. A turn that calls that tool
 * runs THROUGH {@link buildAgentCore} + the Tier-1 adapters (not the legacy
 * Agent). We assert, on the emitted {@link AgentEvent} stream + the captured
 * request:
 *   - the tool actually executed (its dispatch ran, its output came back),
 *   - the `tool_result` appears in the event stream,
 *   - the id-join holds (`tool_result.id === item_started.id`),
 *   - the plugin prompt fragment is present in the request's system prompt,
 *   - the plugin tool is advertised in the request's tool list.
 *
 * This is the explicit "works with plugins and tools" gate for the headless
 * `--output-format json` path.
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../../auth/auth.ts"
import type { SendOptions, StreamedResponse } from "../../llm/transport/types.ts"
import type { PluginLoader } from "../../plugins/loader.ts"
import type { AgentEvent, EventSink } from "../../sdk/events.ts"

import { buildAgentCore } from "./build-agent-core.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

/** Collects every emitted AgentEvent. */
class CaptureEventSink implements EventSink {
  events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

/**
 * A fixture "plugin" as an in-repo loader stub: one real tool (`Weather`) with
 * an executable dispatch, plus a system-prompt fragment. Records whether its
 * dispatch actually ran.
 */
function makeFixturePlugin(): { loader: PluginLoader; dispatched: () => boolean } {
  let ran = false
  const stub = {
    hasTool: (name: string) => name === "Weather",
    dispatch: async (trigger: { input?: { city?: string } }) => {
      ran = true
      const city = trigger?.input?.city ?? "nowhere"
      return { kind: "tool_result" as const, content: `Weather in ${city}: sunny`, is_error: false }
    },
    getExtraTools: () => [
      {
        name: "Weather",
        description: "look up the weather",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    ],
    getPromptBlockAsync: async () =>
      '<ma::sys::tool name="Weather">Use Weather to look up conditions.</ma::sys::tool>',
    getPromptBlock: () => null,
    getToolAliases: () => new Map<string, string>(),
  }
  return { loader: stub as unknown as PluginLoader, dispatched: () => ran }
}

describe("G4 — plugin tool end-to-end through AgentCore + adapters", () => {
  it("runs a plugin tool, emits its tool_result with the id-join intact, and advertises the plugin's tool + prompt fragment", async () => {
    const fixture = makeFixturePlugin()

    let capturedSystem: unknown
    let capturedTools: Array<{ name: string }> = []
    let round = 0
    const sendFn = async function* (
      opts: SendOptions,
    ): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        // Capture the request on the FIRST round (prompt fragment + tools).
        capturedSystem = opts.system
        capturedTools = (opts.tools ?? []) as Array<{ name: string }>
        return {
          blocks: [
            {
              type: "tool_use" as const,
              id: "toolu_weather_1",
              name: "Weather",
              input: { city: "Paris" },
            },
          ],
          text: "",
          stopReason: "tool_use",
        } as StreamedResponse
      }
      yield "It is sunny in Paris."
      return {
        blocks: [{ type: "text" as const, text: "It is sunny in Paris." }],
        text: "It is sunny in Paris.",
        stopReason: "end_turn",
      } as StreamedResponse
    }

    const sink = new CaptureEventSink()
    const core = await buildAgentCore({
      auth: AUTH,
      model: "test-model",
      sendFn,
      eventSink: sink,
      loader: fixture.loader,
      modeManager: null,
      store: null,
      blobStore: null,
      saveEcho: null,
      turnAttachments: [],
    })

    let finalText = ""
    const gen = core.run("what's the weather in Paris?")
    while (true) {
      const { done, value } = await gen.next()
      if (done) break
      finalText += value
    }

    // 1. The plugin tool actually executed.
    expect(fixture.dispatched()).toBe(true)

    // 2. The tool_result appears in the event stream, joined on the tool_use id.
    const itemStarted = sink.events.find(
      (e) => e.type === "item_started" && e.itemType === "tool_use",
    )
    const toolResult = sink.events.find((e) => e.type === "tool_result")
    if (itemStarted?.type !== "item_started") throw new Error("no tool_use item_started")
    if (toolResult?.type !== "tool_result") throw new Error("no tool_result")
    expect(toolResult.id).toBe(itemStarted.id)
    expect(toolResult.id).toBe("toolu_weather_1")
    expect(toolResult.name).toBe("Weather")
    expect(toolResult.isError).toBe(false)

    // 3. The tool's output flowed back into the conversation (round 2 saw it).
    //    We prove it indirectly: the run reached its final answer after the
    //    tool round, and the tool_result content is in history.
    expect(finalText).toBe("It is sunny in Paris.")
    const history = core.history()
    const toolResultInHistory = history
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b.type === "tool_result")
    expect(toolResultInHistory).toBeDefined()
    if (toolResultInHistory?.type === "tool_result") {
      expect(toolResultInHistory.tool_use_id).toBe("toolu_weather_1")
      expect(JSON.stringify(toolResultInHistory.content)).toContain("Weather in Paris: sunny")
    }

    // 4. The plugin's prompt fragment reached the request's system prompt.
    expect(JSON.stringify(capturedSystem)).toContain("Use Weather to look up conditions.")

    // 5. The plugin's tool was advertised on the request.
    expect(capturedTools.map((t) => t.name)).toContain("Weather")
  })
})
