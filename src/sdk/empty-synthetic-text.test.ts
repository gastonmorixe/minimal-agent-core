/**
 * Bare core (no synthetic text provider, so every synthetic text is ""):
 * core must not send an empty text block or an empty message (follow-up
 * 15e.1c, audit items #3 #5 #6 #7). Anthropic rejects an empty text block
 * ("text content blocks must be non-empty").
 *
 * - #3 `mode.change`: no block, no extra model request, and the delivery
 *   listener still fires.
 * - #5 `runtime.hook_denied`: a `turn.willStop` halt with an empty note ends
 *   the turn (`turn_stop.no_text`), never a round with no new user turn.
 * - #6 `runtime.stream_interrupted`: the salvaged tool round note.
 * - #7 `runtime.reflection_checkpoint`: the checkpoint attachment.
 */

import { describe, expect, it } from "bun:test"

import { EMPTY_SYNTHETIC_TEXT, textBlockOrNull } from "../agent/synthetic-text.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { LogEvent } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import type { Message } from "../llm/messages.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"
import { ModeManager } from "../modes/modes.ts"
import { buildTestCore } from "../test-utils/test-core.ts"

import { AgentCore } from "./agent-core.ts"
import { denyDecision, type LifecyclePort } from "./lifecycle.ts"
import type { SessionPersistence } from "./ports.ts"
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

/** Bare `AgentCore` whose `turn.willStop` hook halts once with `reason`. */
async function runHalt(reason: string) {
  let hookCalls = 0
  const lifecycle: LifecyclePort = {
    async beforeTurnStop(p) {
      hookCalls++
      return hookCalls === 1 ? denyDecision(reason, p) : { action: "allow", payload: p }
    },
  }
  const diag: LogEvent[] = []
  const persisted: Array<[string, unknown]> = []
  const sessionPersistence = {
    appendUser: (content: unknown) => {
      persisted.push(["user", content])
      return `u${persisted.length}`
    },
    appendAssistant: (content: unknown) => {
      persisted.push(["assistant", content])
    },
    appendToolResult: () => {},
    appendNote: () => {},
    appendRewind: () => {},
  } as unknown as SessionPersistence
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
    diagnostics: createDiagnostics({ emit: (e) => diag.push(e) }),
    sessionPersistence,
  })
  await drain(core)
  return { requests, diag, persisted, messages: core.messages, hookCalls }
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

  it("#5 turn.willStop halt with an empty note: the turn ends, no extra request", async () => {
    const { requests, diag, persisted, messages, hookCalls } = await runHalt("")
    // No second round: it would end on the assistant reply (a prefill).
    expect(requests.length).toBe(1)
    expect(hookCalls).toBe(1)
    const warns = diag.filter((e) => e.source === "turn_stop.no_text")
    expect(warns).toHaveLength(1)
    expect(warns[0]?.structuredData).toEqual({ hook: "turn.willStop", halts: 0 })
    // Nothing empty persisted: the user text, then the reply.
    expect(persisted).toEqual([
      ["user", [{ type: "text", text: "go" }]],
      ["assistant", [{ type: "text", text: "done" }]],
    ])
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"])
    for (const r of requests) expectNoEmpty(r)
    expectNoEmpty(messages)
  })

  it("#5 turn.willStop halt with a reason: unchanged, the turn continues", async () => {
    const { requests, diag, hookCalls } = await runHalt("keep going")
    expect(requests.length).toBe(2)
    expect(hookCalls).toBe(2)
    expect(requests[1]?.map((m) => m.role)).toEqual(["user", "assistant", "user"])
    expect(JSON.stringify(requests[1]?.[2]?.content)).toContain("keep going")
    expect(diag.filter((e) => e.source === "turn_stop.no_text")).toEqual([])
    for (const r of requests) expectNoEmpty(r)
  })

  it("#5 runTurnStopHook: an empty halt note ends the turn", async () => {
    const step = await runTurnStopHook(
      async (p) => denyDecision("  ", p),
      END,
      0,
      8,
      {},
      undefined,
      EMPTY_SYNTHETIC_TEXT,
    )
    expect(step).toEqual({ kind: "end", noText: true })
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
