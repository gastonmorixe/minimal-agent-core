/**
 * 15e.2 safety: a lifecycle deny with no reason still denies. The decision
 * is the `action`, never the reason text. The host gets a typed
 * `LifecycleDeniedError` with the hook name.
 */

import { describe, expect, it } from "bun:test"

import { checkToolDidBatch } from "../agent/tool-batch-gate.ts"
import type { AuthResult } from "../auth/auth.ts"
import { LifecycleDeniedError } from "../errors/lifecycle.ts"
import { recoveryErrorText } from "../llm/transport/retry.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"

import { AgentCore } from "./agent-core.ts"
import type { AgentEvent } from "./events.ts"
import { type LifecyclePort, NOOP_LIFECYCLE } from "./lifecycle.ts"
import { compactWithLifecycle } from "./lifecycle-compact.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

const GLOB: StreamedResponse = {
  blocks: [{ type: "tool_use", id: "t1", name: "Glob", input: { pattern: "zz-no-such-*" } }],
  text: "",
  stopReason: "tool_use",
} as StreamedResponse

const END: StreamedResponse = {
  blocks: [{ type: "text", text: "done" }],
  text: "done",
  stopReason: "end_turn",
} as StreamedResponse

describe("a deny with no reason still denies", () => {
  it("compact.willRun: throws LifecycleDeniedError with the hook, no reason", async () => {
    let caught: unknown
    try {
      await compactWithLifecycle({
        messages: [],
        model: "m",
        auth: AUTH,
        lifecycle: {
          ...NOOP_LIFECYCLE,
          beforeCompact: async () => ({ action: "deny", reason: "" }),
        },
      })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LifecycleDeniedError)
    const err = caught as LifecycleDeniedError
    expect(err.message).toBe("")
    expect(err.hook).toBe("compact.willRun")
    expect(err.reason).toBeUndefined()
  })

  it("tool.didBatch gate: halts with reason '' and the typed error", async () => {
    const lifecycle: LifecyclePort = {
      afterToolBatch: async () => ({ action: "deny", reason: "" }),
    }
    const gate = await checkToolDidBatch(lifecycle, { toolBlocks: [], toolResults: [], round: 1 })
    expect(gate.halted).toBe(true)
    if (!gate.halted) throw new Error("unreachable")
    expect(gate.reason).toBe("")
    expect(gate.error.toJSON()).toEqual({
      kind: "LifecycleDeniedError",
      fields: { hook: "tool.didBatch", additionalContext: [] },
    })
  })

  it("AgentCore: a tool.didBatch deny with no reason ends the turn failed, error event typed", async () => {
    const events: AgentEvent[] = []
    let sends = 0
    const sendFn: TransportFn = async function* (_opts: SendOptions) {
      sends++
      return (sends === 1 ? GLOB : END) as StreamedResponse
    }
    const turnEnds: unknown[] = []
    const lifecycle: LifecyclePort = {
      afterToolBatch: async () => ({ action: "deny", reason: "" }),
      turnEnd: (p) => {
        turnEnds.push(p)
      },
    }
    const core = new AgentCore({
      auth: AUTH,
      model: "test-model",
      systemPrompt: "",
      maxTokens: 4096,
      toolRegistry: { list: () => [] },
      toolExecutor: { execute: async () => ({ content: "", isError: false }) },
      sendFn,
      lifecycle,
      eventSink: { emit: (e) => events.push(e) },
    })
    const gen = core.run("go")
    let r = await gen.next()
    while (!r.done) r = await gen.next()
    // Denied: no second model request, the run fails.
    expect(sends).toBe(1)
    expect(r.value.outcome).toBe("failed")
    const err = events.find((e) => e.type === "error")
    expect(err).toBeDefined()
    if (err?.type !== "error") throw new Error("unreachable")
    expect(err.error).toEqual({
      kind: "LifecycleDeniedError",
      fields: { hook: "tool.didBatch", additionalContext: [] },
    })
    expect(turnEnds[0]).toEqual({ ok: false, error: "tool.didBatch" })
  })

  it("recovery diagnostic: a CoreError gives its kind and fields, not only the class name", () => {
    const err = new LifecycleDeniedError({ hook: "compact.willRun", reason: "no" })
    expect(recoveryErrorText(err)).toBe(
      'LifecycleDeniedError {"hook":"compact.willRun","reason":"no","additionalContext":[]}',
    )
    expect(recoveryErrorText(new Error("boom"))).toBe("Error: boom")
  })
})
