/**
 * 15d.3a: the core's one synthetic text resolver reaches `runCompact` on
 * every compaction entry path: `AgentCore.compact` (/compact),
 * the queued `CompactContext` drain, `compactWithLifecycle`, and the legacy
 * `agentCompact`. The resolver is plumbed only: the compaction texts still
 * come from core, so `runCompact` runs for real (spy calls through).
 *
 * @module sdk/compact-text-plumbing.test
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test"

import { agentCompact } from "../agent/agent-compact-methods.ts"
import type { RunCompactInput } from "../agent/run-compact.ts"
import * as runCompactModule from "../agent/run-compact.ts"
import { EMPTY_SYNTHETIC_TEXT } from "../agent/synthetic-text.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { Message } from "../llm/messages.ts"
import type { StreamedResponse, TransportFn } from "../llm/transport/types.ts"

import { AgentCore, type TurnResult } from "./agent-core.ts"
import type { PendingCompact } from "./host-ports.ts"
import { NOOP_LIFECYCLE } from "./lifecycle.ts"
import { compactWithLifecycle } from "./lifecycle-compact.ts"
import type { SyntheticTextResolverLike } from "./ports.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

const ok: StreamedResponse = {
  blocks: [{ type: "text", text: "done" }],
  text: "done",
  stopReason: "end_turn",
}

function history(): Message[] {
  const out: Message[] = []
  for (let i = 0; i < 4; i++) {
    out.push({ role: "user", content: `u${i}` })
    out.push({ role: "assistant", content: `a${i}` })
  }
  return out
}

/** A distinct resolver object, so identity proves which one arrived. */
function resolver(): SyntheticTextResolverLike {
  return { resolve: () => "" }
}

function spyRunCompact() {
  return spyOn(runCompactModule, "runCompact")
}

function inputs(spy: ReturnType<typeof spyRunCompact>): RunCompactInput[] {
  return spy.mock.calls.map((c) => c[0])
}

function core(text: SyntheticTextResolverLike, pending: PendingCompact | null = null) {
  let queued = pending
  const sendFn: TransportFn = async function* () {
    yield "done"
    return ok
  }
  const agent = new AgentCore({
    auth: AUTH,
    model: "test-model-1",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "", isError: false }) },
    eventSink: { emit: () => {} },
    sendFn,
    syntheticTextResolver: text,
    ports: {
      compactSource: {
        take: () => {
          const next = queued
          queued = null
          return next
        },
      },
    },
  })
  for (const m of history()) agent.messages.push(m)
  return agent
}

async function drain(gen: AsyncGenerator<string, TurnResult, undefined>): Promise<TurnResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

describe("15d.3a: the synthetic text resolver reaches runCompact", () => {
  let spy: ReturnType<typeof spyRunCompact> | null = null
  afterEach(() => {
    spy?.mockRestore()
    spy = null
  })

  it("AgentCore.compact (/compact) passes the core's resolver", async () => {
    const text = resolver()
    const agent = core(text)
    spy = spyRunCompact()
    const stats = await agent.compact({ reason: "manual", mode: "tail", keepTail: 2 })
    expect(stats.kind).toBe("local")
    expect(agent.syntheticText).toBe(text)
    expect(inputs(spy)).toHaveLength(1)
    expect(inputs(spy)[0]?.text).toBe(text)
  })

  it("the queued CompactContext drain passes the core's resolver", async () => {
    const text = resolver()
    const agent = core(text, { reason: "manual", mode: "tail", keepTail: 2 })
    spy = spyRunCompact()
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")
    expect(inputs(spy)).toHaveLength(1)
    expect(inputs(spy)[0]?.text).toBe(text)
  })

  it("compactWithLifecycle forwards text, and omits it when absent", async () => {
    const text = resolver()
    spy = spyRunCompact()
    const base = { model: "m", auth: AUTH, lifecycle: NOOP_LIFECYCLE, mode: "tail" as const }
    await compactWithLifecycle({ ...base, messages: history(), text })
    await compactWithLifecycle({ ...base, messages: history() })
    expect(inputs(spy)[0]?.text).toBe(text)
    expect("text" in (inputs(spy)[1] ?? {})).toBe(false)
  })

  it("agentCompact passes agent.text, else the empty resolver", async () => {
    const text = resolver()
    spy = spyRunCompact()
    const agent = (t?: SyntheticTextResolverLike) => ({
      messages: history(),
      model: "m",
      auth: AUTH,
      appendNote: () => {},
      store: null,
      ...(t ? { text: t } : {}),
    })
    await agentCompact(agent(text), { reason: "manual", mode: "tail" })
    await agentCompact(agent(), { reason: "manual", mode: "tail" })
    expect(inputs(spy)[0]?.text).toBe(text)
    expect(inputs(spy)[1]?.text).toBe(EMPTY_SYNTHETIC_TEXT)
  })
})
