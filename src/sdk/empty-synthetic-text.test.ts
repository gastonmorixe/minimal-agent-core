/**
 * Bare core (no synthetic text provider, so every synthetic text is ""):
 * core must not send an empty text block or an empty message (follow-up
 * 15e.1c, audit items #3 #5 #6 #7). Anthropic rejects an empty text block
 * ("text content blocks must be non-empty").
 *
 * - #3 `mode.change`: no block, no extra model request, and the delivery
 *   listener still fires.
 * - #5 `runtime.hook_denied`: a `turn.willStop` halt with an empty reason.
 * - #6 `runtime.stream_interrupted`: the salvaged tool round note.
 * - #7 `runtime.reflection_checkpoint`: the checkpoint attachment.
 */

import { describe, expect, it } from "bun:test"

import { EMPTY_SYNTHETIC_TEXT, textBlockOrNull } from "../agent/synthetic-text.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { Message } from "../llm/messages.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"
import { ModeManager } from "../modes/modes.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

import { AgentCore } from "./agent-core.ts"
import { denyDecision, type LifecyclePort } from "./lifecycle.ts"
import { runTurnStopHook } from "./turn-stop-hook.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

const END: StreamedResponse = {
  blocks: [{ type: "text", text: "done" }],
  text: "done",
  stopReason: "end_turn",
} as StreamedResponse

/** A Glob call that matches nothing (a real tool, no side effect). */
const GLOB: StreamedResponse = {
  blocks: [{ type: "tool_use", id: "t1", name: "Glob", input: { pattern: "zz-no-such-*" } }],
  text: "",
  stopReason: "tool_use",
} as StreamedResponse

/** Record every request; answer with `replies[i]` (the last one repeats). */
function recorder(replies: StreamedResponse[], onSend?: (n: number) => void) {
  const requests: Message[][] = []
  const sendFn: TransportFn = async function* (opts: SendOptions) {
    requests.push(JSON.parse(JSON.stringify(opts.messages)) as Message[])
    onSend?.(requests.length)
    return replies[Math.min(requests.length - 1, replies.length - 1)] as StreamedResponse
  }
  return { sendFn, requests }
}

async function drain(core: AgentCore, text = "go"): Promise<void> {
  const gen = core.run(text)
  while (!(await gen.next()).done) {}
}

/** No empty message, and no text block with "" anywhere in the request. */
function expectNoEmpty(request: Message[]): void {
  for (const m of request) {
    expect(m.content.length).toBeGreaterThan(0)
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b.type === "text") expect(b.text).not.toBe("")
    }
  }
}

describe("textBlockOrNull (shared guard)", () => {
  it("returns null for an empty text, a block otherwise", () => {
    expect(textBlockOrNull("")).toBeNull()
    expect(textBlockOrNull("x")).toEqual({ type: "text", text: "x" })
  })
})

describe("bare core: no empty synthetic text block", () => {
  it("#3 mode.change before the turn: no empty block, listener fires", async () => {
    const modeManager = new ModeManager([{ id: "ask", label: "ASK" }], null)
    const delivered: Array<string | null> = []
    modeManager.onDeliver((e) => delivered.push(e.toId))
    modeManager.setMode("ask")
    const { sendFn, requests } = recorder([END])
    const core = await buildTestCore({ auth: AUTH, sendFn, modeManager })
    await drain(core)
    expect(requests.length).toBe(1)
    for (const r of requests) expectNoEmpty(r)
    expect(delivered).toEqual(["ask"])
    expect(modeManager.peekPendingAttachment()).toBeNull()
  })

  it("#3 mode.change during a final round: no extra request, listener fires", async () => {
    const modeManager = new ModeManager([{ id: "ask", label: "ASK" }], null)
    const delivered: Array<string | null> = []
    modeManager.onDeliver((e) => delivered.push(e.toId))
    // The user switches mode while the model answers the only round.
    const { sendFn, requests } = recorder([END], (n) => {
      if (n === 1) modeManager.setMode("ask")
    })
    const core = await buildTestCore({ auth: AUTH, sendFn, modeManager })
    await drain(core)
    // The normal count: one request for a plain end_turn reply.
    expect(requests.length).toBe(1)
    for (const r of requests) expectNoEmpty(r)
    expectNoEmpty(core.messages)
    expect(core.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(delivered).toEqual(["ask"])
  })

  it("#3 mode.change after a tool round: no empty block", async () => {
    const modeManager = new ModeManager([{ id: "ask", label: "ASK" }], null)
    const delivered: Array<string | null> = []
    modeManager.onDeliver((e) => delivered.push(e.toId))
    const { sendFn, requests } = recorder([GLOB, END], (n) => {
      if (n === 1) modeManager.setMode("ask")
    })
    const core = await buildTestCore({ auth: AUTH, sendFn, modeManager })
    await drain(core)
    expect(requests.length).toBe(2)
    for (const r of requests) expectNoEmpty(r)
    expect(delivered).toEqual(["ask"])
  })

  it("#5 turn.willStop halt with an empty reason: no empty block", async () => {
    let halts = 0
    const lifecycle: LifecyclePort = {
      async beforeTurnStop(p) {
        halts++
        return halts === 1 ? denyDecision("", p) : { action: "allow", payload: p }
      },
    }
    const { sendFn, requests } = recorder([END])
    const core = new AgentCore({
      auth: AUTH,
      model: "test-model",
      systemPrompt: "",
      maxTokens: 4096,
      toolRegistry: { list: () => [] },
      toolExecutor: { execute: async () => ({ content: "", isError: false }) },
      sendFn,
      lifecycle,
    })
    await drain(core)
    // The halt is still honored (decided by `decision.action`, not the text):
    // one more round runs, with no user message added for the empty note.
    expect(requests.length).toBe(2)
    expect(requests[1]?.map((m) => m.role)).toEqual(["user", "assistant"])
    for (const r of requests) expectNoEmpty(r)
    expectNoEmpty(core.messages)
  })

  it("#5 runTurnStopHook: an empty halt note gives no block", async () => {
    const step = await runTurnStopHook(
      async (p) => denyDecision("  ", p),
      END,
      0,
      8,
      {},
      undefined,
      EMPTY_SYNTHETIC_TEXT,
    )
    expect(step).toEqual({ kind: "continue", content: [] })
  })

  it("#6 salvaged tool round (stream interrupted): no empty block", async () => {
    const salvaged = {
      ...GLOB,
      stopDetails: { type: "stream_closed_without_terminal", message: "cut" },
    } as StreamedResponse
    const { sendFn, requests } = recorder([salvaged, END])
    const core = await buildTestCore({ auth: AUTH, sendFn })
    await drain(core)
    expect(requests.length).toBe(2)
    for (const r of requests) expectNoEmpty(r)
  })

  it("#7 reflection checkpoint: no empty block", async () => {
    const { sendFn, requests } = recorder([GLOB, END])
    const core = await buildTestCore({
      auth: AUTH,
      sendFn,
      reflectionInterval: 1,
      reflectionCooldownMs: 0,
    })
    await drain(core)
    expect(requests.length).toBe(2)
    for (const r of requests) expectNoEmpty(r)
  })
})
