/**
 * Edge cases of the `turn.willStop` and `session.willStart` seams on a real
 * `AgentCore`: a throwing port, a `failClosed` listener that throws or times
 * out (ends the turn), an abort while the stop hook runs (also a hook that
 * never resolves), a refusal end that skips the gate, a throwing `sessionWillStart` after a
 * compaction, and the capped notice end to end through
 * `LifecyclePortAdapter` + HookBus.
 */

import { describe, expect, it } from "bun:test"

import { LifecyclePortAdapter } from "../adapters/lifecycle-port-adapter.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"
import { Hooks } from "../plugins/hooks/hooks.ts"
import { COMPACT_TEST_TEXT } from "../test-utils/compact-test-text.ts"
import { fixtureSidebandOrNone, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"

import { AgentCore, type TurnResult } from "./agent-core.ts"
import type { AgentEvent } from "./events.ts"
import { allowDecision, denyDecision, type LifecyclePort } from "./lifecycle.ts"
import type { AgentCoreConfig } from "./ports.ts"

/** The real codec (sibling checkout), else `NO_SIDEBAND`: the policy tags render here. */
const SB = fixtureSidebandOrNone()
/** `describe` for the tests that pin the bytes of a policy tag. */
const describeSb = describe.skipIf(!sidebandFixturePresent())

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const PLUGIN = { caller: "plugin" as const, priority: 50, source: "test" }

function recorder(): { sendFn: TransportFn; requests: SendOptions[] } {
  const requests: SendOptions[] = []
  let n = 0
  const sendFn: TransportFn = async function* (opts) {
    requests.push(JSON.parse(JSON.stringify(opts)) as SendOptions)
    n++
    return {
      blocks: [{ type: "text", text: `text-${n}` }],
      text: `text-${n}`,
      stopReason: "end_turn",
    } as StreamedResponse
  }
  return { sendFn, requests }
}

function core(sendFn: TransportFn, over: Partial<AgentCoreConfig> = {}) {
  const events: AgentEvent[] = []
  const agent = new AgentCore({
    auth: AUTH,
    model: "test-model-1",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "", isError: false }) },
    eventSink: { emit: (e) => events.push(e) },
    sendFn,
    sideband: SB,
    ...over,
  })
  return { agent, events }
}

async function drain(gen: AsyncGenerator<string, TurnResult, undefined>): Promise<TurnResult> {
  for (;;) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

const cappedNotices = (events: AgentEvent[]) =>
  events.filter((e) => e.type === "notice" && e.notice.kind === "stop_hook_capped")

describeSb("turn.willStop edge cases", () => {
  it("a beforeTurnStop throw ends the turn normally", async () => {
    const lifecycle: LifecyclePort = {
      async beforeTurnStop() {
        throw new Error("port broke")
      },
    }
    const { sendFn, requests } = recorder()
    const { agent, events } = core(sendFn, { lifecycle })
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")
    expect(requests.length).toBe(1)
    expect(cappedNotices(events)).toEqual([])
  })

  it("a failClosed turn.willStop throw ends the turn and is not a halt", async () => {
    const hooks = new Hooks({ logger: () => {} })
    let calls = 0
    hooks.on(
      "turn.willStop",
      () => {
        calls++
        throw new Error("gate gone")
      },
      { ...PLUGIN, failClosed: true },
    )
    const { sendFn, requests } = recorder()
    const { agent, events } = core(sendFn, {
      lifecycle: new LifecyclePortAdapter(hooks),
      maxStopHookHalts: 2,
    })
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")
    // No continuation: one request, one hook call, no cap notice.
    expect(calls).toBe(1)
    expect(requests.length).toBe(1)
    expect(cappedNotices(events)).toEqual([])
    expect(agent.messages.filter((m) => m.role === "user").length).toBe(1)
  })

  it("a failClosed turn.willStop timeout ends the turn and is not a halt", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on("turn.willStop", () => new Promise<never>(() => {}), {
      ...PLUGIN,
      failClosed: true,
      timeoutMs: 20,
    })
    const { sendFn, requests } = recorder()
    const { agent, events } = core(sendFn, {
      lifecycle: new LifecyclePortAdapter(hooks),
      maxStopHookHalts: 2,
    })
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")
    expect(requests.length).toBe(1)
    expect(cappedNotices(events)).toEqual([])
  })

  it("a stop hook that never resolves does not delay an abort", async () => {
    const ac = new AbortController()
    let called = false
    const lifecycle: LifecyclePort = {
      beforeTurnStop() {
        called = true
        setTimeout(() => ac.abort(), 10)
        return new Promise<never>(() => {})
      },
    }
    const { sendFn, requests } = recorder()
    const { agent, events } = core(sendFn, { lifecycle })
    await expect(drain(agent.run("go", { signal: ac.signal }))).rejects.toThrow("aborted")
    expect(called).toBe(true)
    expect(requests.length).toBe(1)
    expect(events).toContainEqual({ type: "run_finished", outcome: "aborted" })
    expect(events.some((e) => e.type === "turn_completed")).toBe(false)
  })

  it("the stop hook gets the turn signal, so it can stop its own work", async () => {
    const ac = new AbortController()
    let hookSignal: AbortSignal | undefined
    const lifecycle: LifecyclePort = {
      beforeTurnStop(_p, signal) {
        hookSignal = signal
        setTimeout(() => ac.abort(), 10)
        return new Promise<never>(() => {})
      },
    }
    const { agent } = core(recorder().sendFn, { lifecycle })
    await expect(drain(agent.run("go", { signal: ac.signal }))).rejects.toThrow("aborted")
    expect(hookSignal?.aborted).toBe(true)
  })

  for (const stopReason of ["refusal", "content_filter"]) {
    it(`a ${stopReason} end skips the stop gate`, async () => {
      let calls = 0
      const lifecycle: LifecyclePort = {
        async beforeTurnStop(p) {
          calls++
          return denyDecision("keep going", p)
        },
      }
      const requests: SendOptions[] = []
      const sendFn: TransportFn = async function* (opts) {
        requests.push(opts)
        return { blocks: [], text: "", stopReason } as unknown as StreamedResponse
      }
      const { agent } = core(sendFn, { lifecycle })
      const result = await drain(agent.run("go"))
      expect(result.outcome).toBe("completed")
      expect(calls).toBe(0)
      expect(requests.length).toBe(1)
    })
  }

  it("an abort while the stop hook runs ends the turn as aborted", async () => {
    const ac = new AbortController()
    const lifecycle: LifecyclePort = {
      async beforeTurnStop(p) {
        ac.abort()
        return denyDecision("keep going", p)
      },
    }
    const { sendFn, requests } = recorder()
    const { agent, events } = core(sendFn, { lifecycle })
    let caught: unknown
    try {
      await drain(agent.run("go", { signal: ac.signal }))
    } catch (err) {
      caught = err
    }
    expect((caught as Error | undefined)?.name).toBe("AbortError")
    expect(requests.length).toBe(1)
    expect(events).toContainEqual({ type: "run_finished", outcome: "aborted" })
    expect(events.some((e) => e.type === "turn_completed")).toBe(false)
  })

  it("an abort during an allowing stop hook also ends the turn as aborted", async () => {
    const ac = new AbortController()
    const lifecycle: LifecyclePort = {
      async beforeTurnStop(p) {
        ac.abort()
        return allowDecision(p)
      },
    }
    const { agent, events } = core(recorder().sendFn, { lifecycle })
    await expect(drain(agent.run("go", { signal: ac.signal }))).rejects.toThrow("aborted")
    expect(events).toContainEqual({ type: "run_finished", outcome: "aborted" })
  })

  it("the capped notice goes end to end through LifecyclePortAdapter and HookBus", async () => {
    const hooks = new Hooks({ logger: () => {} })
    let calls = 0
    hooks.on(
      "turn.willStop",
      () => {
        calls++
        return { halt: true as const, reason: "" }
      },
      PLUGIN,
    )
    const { sendFn, requests } = recorder()
    const { agent, events } = core(sendFn, {
      lifecycle: new LifecyclePortAdapter(hooks),
      maxStopHookHalts: 1,
      syntheticTextResolver: { resolve: (kind, facts) => `[${kind} ${JSON.stringify(facts)}]` },
    })
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")
    expect(calls).toBe(2)
    expect(requests.length).toBe(2)
    expect(cappedNotices(events)).toEqual([
      { type: "notice", notice: { kind: "stop_hook_capped", severity: "warn", cap: 1 } },
    ])
    // A blank reason gets the runtime.hook_denied text.
    const user = agent.messages.filter((m) => m.role === "user")[1]
    const note = ((user?.content ?? []) as Array<{ type: string; text?: string }>)
      .map((b) => b.text ?? "")
      .join("\n")
    expect(note).toContain(
      `<ma::agent::policy>[runtime.hook_denied {"hook":"turn.willStop"}]</ma::agent::policy>`,
    )
  })
})

describe("session.willStart after compaction, edge cases", () => {
  it("a throw does not crash the compaction and adds no context", async () => {
    const lifecycle: LifecyclePort = {
      async beforeSend(p) {
        return p.compact ? denyDecision("no network in tests") : allowDecision(p)
      },
      async sessionWillStart() {
        throw new Error("listener broke")
      },
    }
    const { sendFn, requests } = recorder()
    const { agent } = core(sendFn, { lifecycle, syntheticTextResolver: COMPACT_TEST_TEXT })
    for (let i = 0; i < 8; i++) {
      agent.messages.push({ role: "user", content: `u${i}` })
      agent.messages.push({ role: "assistant", content: `a${i}` })
    }
    await agent.compact({ reason: "manual", mode: "local" })
    await drain(agent.run("go"))
    const last = requests[0]?.messages.at(-1)?.content
    const texts =
      typeof last === "string"
        ? [last]
        : (last ?? []).map((b) => (b.type === "text" ? b.text : b.type))
    expect(texts).toEqual(["go"])
  })

  it("with no sessionFacts, the compact payload has an empty sid and cwd", async () => {
    const started: unknown[] = []
    const lifecycle: LifecyclePort = {
      async beforeSend(p) {
        return p.compact ? denyDecision("no network in tests") : allowDecision(p)
      },
      async sessionWillStart(p) {
        started.push(p)
        return { additionalContext: [] }
      },
    }
    const { agent } = core(recorder().sendFn, {
      lifecycle,
      syntheticTextResolver: COMPACT_TEST_TEXT,
    })
    for (let i = 0; i < 8; i++) {
      agent.messages.push({ role: "user", content: `u${i}` })
      agent.messages.push({ role: "assistant", content: `a${i}` })
    }
    await agent.compact({ reason: "manual", mode: "local" })
    // `SessionWillStartPayload.sid` is required, so an unknown sid is "".
    expect(started).toEqual([expect.objectContaining({ source: "compact", sid: "", cwd: "" })])
  })
})
