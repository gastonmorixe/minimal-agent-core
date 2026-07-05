/**
 * Phase-3 gap closer: sacred id-join + byte-parity under DELTA streaming.
 *
 * The G1/G4 tests predate Phase 3 (`text_delta` / `thinking_delta` +
 * `emitDeltas`). None covered a TOOL-USING turn under `stream-json` with deltas
 * ON. This test closes that gap by driving a real {@link AgentCore} (built
 * through the Tier-1 adapters) with `emitDeltas: true` and a multi-chunk,
 * tool-using fake transport, then asserting:
 *
 *   (a) the sacred join survives — `tool_result.id === item_started.id` still
 *       holds with `text_delta` events interleaved into the stream;
 *   (b) the concatenated `text_delta` payloads for the answer turn equal that
 *       turn's `item_completed` text (deltas reconstruct the final text);
 *   (c) the final answer is BYTE-IDENTICAL to the `emitDeltas: false` run —
 *       deltas are an additive event channel and must never mutate `content`.
 *
 * Read-only against agent-core.ts / events.ts (Olivia's Phase-3 files). The
 * test lives entirely in the sdk-adapters lane.
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../../auth/auth.ts"
import type { StreamedResponse } from "../../llm/transport/types.ts"
import type { PluginLoader } from "../../plugins/loader.ts"
import type { AgentEvent, EventSink } from "../../sdk/events.ts"

import { buildAgentCore } from "./build-agent-core.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const MODEL = "test-model"

/** Collects every emitted AgentEvent. */
class CaptureEventSink implements EventSink {
  events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

/** A loader stub exposing one plugin tool (`Widget`) via dispatch. */
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

/**
 * A fresh tool-using transport: round 1 = a `Widget` tool_use, round 2 = the
 * final answer streamed as MULTIPLE chunks (so more than one text_delta fires).
 * Fresh per-runner so both engines see identical responses.
 */
function makeToolTurnTransport(): () => AsyncGenerator<string, StreamedResponse, undefined> {
  let round = 0
  return async function* () {
    round++
    if (round === 1) {
      return {
        blocks: [{ type: "tool_use" as const, id: "toolu_JOIN", name: "Widget", input: {} }],
        text: "",
        stopReason: "tool_use",
      } as StreamedResponse
    }
    // Multi-chunk answer: three yields concatenating to the final text.
    yield "The widget "
    yield "returned "
    yield "hello."
    return {
      blocks: [{ type: "text" as const, text: "The widget returned hello." }],
      text: "The widget returned hello.",
      stopReason: "end_turn",
    } as StreamedResponse
  }
}

async function buildCore(
  sink: EventSink,
  sendFn: () => AsyncGenerator<string, StreamedResponse, undefined>,
) {
  return buildAgentCore({
    auth: AUTH,
    model: MODEL,
    sendFn,
    eventSink: sink,
    loader: widgetLoader("hello"),
    modeManager: null,
    store: null,
    blobStore: null,
    saveEcho: null,
    turnAttachments: [],
  })
}

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

describe("stream-json parity — tool-using turn with deltas ON", () => {
  it("preserves tool_result.id === item_started.id with text_delta interleaved (a)", async () => {
    const sink = new CaptureEventSink()
    const core = await buildCore(sink, makeToolTurnTransport())
    await drainText(core.run("use the widget", { emitDeltas: true }))

    // Deltas were actually interleaved into the stream (otherwise the test is
    // vacuous — this is the whole point of emitDeltas).
    const deltas = sink.events.filter((e) => e.type === "text_delta")
    expect(deltas.length).toBeGreaterThan(1)

    const toolStart = sink.events.find(
      (e) => e.type === "item_started" && e.itemType === "tool_use",
    )
    const toolResult = sink.events.find((e) => e.type === "tool_result")
    if (toolStart?.type !== "item_started") throw new Error("no tool_use item_started")
    if (toolResult?.type !== "tool_result") throw new Error("no tool_result")
    expect(toolResult.id).toBe(toolStart.id)
    expect(toolResult.id).toBe("toolu_JOIN")
    expect(toolResult.isError).toBe(false)
  })

  it("concatenated text_delta payloads equal the answer turn's item_completed text (b)", async () => {
    const sink = new CaptureEventSink()
    const core = await buildCore(sink, makeToolTurnTransport())
    await drainText(core.run("use the widget", { emitDeltas: true }))

    const concatDeltas = sink.events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e.type === "text_delta" ? e.text : ""))
      .join("")

    // The single text item_completed (the answer turn) carries the final text.
    const textCompleted = sink.events.find(
      (e) => e.type === "item_completed" && e.itemType === "text",
    )
    if (textCompleted?.type !== "item_completed") throw new Error("no text item_completed")
    // `item_completed.text` is optional on the event; it must be present here.
    expect(textCompleted.text).toBeDefined()
    expect(concatDeltas).toBe(textCompleted.text ?? "")
    expect(concatDeltas).toBe("The widget returned hello.")
  })

  it("final answer is byte-identical with deltas ON vs OFF (c)", async () => {
    const sinkOn = new CaptureEventSink()
    const coreOn = await buildCore(sinkOn, makeToolTurnTransport())
    const answerOn = await drainText(coreOn.run("use the widget", { emitDeltas: true }))

    const sinkOff = new CaptureEventSink()
    const coreOff = await buildCore(sinkOff, makeToolTurnTransport())
    const answerOff = await drainText(coreOff.run("use the widget", { emitDeltas: false }))

    // Deltas must not mutate the yielded content.
    expect(answerOn).toBe(answerOff)
    expect(answerOn).toBe("The widget returned hello.")

    // And the deltas-OFF run emits NO text_delta (buffered mode stays clean).
    expect(sinkOff.events.some((e) => e.type === "text_delta")).toBe(false)
    expect(sinkOn.events.some((e) => e.type === "text_delta")).toBe(true)

    // The id-join holds identically on both paths.
    const joinOn = sinkOn.events.find((e) => e.type === "tool_result")
    const joinOff = sinkOff.events.find((e) => e.type === "tool_result")
    if (joinOn?.type !== "tool_result" || joinOff?.type !== "tool_result") {
      throw new Error("missing tool_result on one path")
    }
    expect(joinOn.id).toBe(joinOff.id)
    expect(joinOn.id).toBe("toolu_JOIN")
  })

  it("thinking_delta concatenates to the reasoning and stays distinct from text_delta ids (d)", async () => {
    // A transport that streams reasoning chunks (via onThinkingDelta) before
    // the answer, through the FULLY WIRED buildAgentCore stack. Olivia's unit
    // tests cover this at the AgentCore seam; this proves it survives the
    // adapters too.
    const thinkingTransport = (): (() => AsyncGenerator<string, StreamedResponse, undefined>) => {
      return async function* (
        opts: { onThinkingDelta?: (t: string) => void } = {},
      ): AsyncGenerator<string, StreamedResponse, undefined> {
        opts.onThinkingDelta?.("let me ")
        opts.onThinkingDelta?.("think.")
        yield "answer text"
        return {
          blocks: [{ type: "text" as const, text: "answer text" }],
          text: "answer text",
          stopReason: "end_turn",
        } as StreamedResponse
      }
    }

    const sink = new CaptureEventSink()
    const core = await buildCore(sink, thinkingTransport())
    await drainText(core.run("go", { emitDeltas: true }))

    // Reasoning deltas fired and concatenate to the full reasoning text.
    const thinkingDeltas = sink.events.filter((e) => e.type === "thinking_delta")
    expect(thinkingDeltas.length).toBeGreaterThan(1)
    const concatThinking = thinkingDeltas
      .map((e) => (e.type === "thinking_delta" ? e.text : ""))
      .join("")
    expect(concatThinking).toBe("let me think.")

    // Per-turn delta ids are distinct channels: thinking is "<turn>:thinking",
    // text is "<turn>:text". They must NOT collide (and are NOT item-join ids).
    const thinkingIds = new Set(
      thinkingDeltas.map((e) => (e.type === "thinking_delta" ? e.id : "")),
    )
    const textIds = new Set(
      sink.events
        .filter((e) => e.type === "text_delta")
        .map((e) => (e.type === "text_delta" ? e.id : "")),
    )
    for (const tid of thinkingIds) expect(textIds.has(tid)).toBe(false)
  })
})
