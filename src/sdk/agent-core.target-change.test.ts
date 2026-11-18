/**
 * What a change of the live target does inside a run (`sdk/target-change.ts`):
 * a retry or quota wait ends with no turn abort, the system prompt is built
 * again, and thinking from before the change is discarded. The same steps
 * apply to `switchTarget`, `setModel` and `setEffort`.
 *
 * @module sdk/agent-core.target-change.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { ContentBlock, Message } from "../llm/messages.ts"
import { clearModelRegistry, clearProviderRegistry } from "../llm/model-registry.ts"
import { clearProviderPlugins, registerProviderPlugin } from "../llm/provider-plugin.ts"
import { registerTestProvider } from "../llm/test-fixtures.ts"
import type { RetryClock } from "../llm/transport/retry-policy.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"

import { AgentCore, type TurnResult } from "./agent-core.ts"
import type { AgentEvent } from "./events.ts"
import type { AgentCoreConfig, SessionPersistence } from "./ports.ts"
import { discardThinking, type TargetSwitchEntry } from "./target-change.ts"
import type { TargetSwitch } from "./target-switch.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const P1 = "tc-provider-one"
const P2 = "tc-provider-two"
const EFFORT = { levels: ["low", "high"], default: "low" } as const

/** Two providers. Each one owns its system prompt: `SYS <provider> <model>`. */
function registerProviders(): void {
  for (const [id, models] of [
    [P1, ["model-a", "model-b"]],
    [P2, ["model-x"]],
  ] as const) {
    const handle = registerTestProvider({
      id,
      displayName: id,
      models: models.map((m) => ({ id: m, capabilities: { effort: { ...EFFORT } } })),
    })
    registerProviderPlugin({
      ...handle.plugin,
      resolveSystemPrompt: (ctx) => [{ type: "text", text: `SYS ${id} ${ctx.modelId}` }],
    })
  }
}

/** One recorded request: the target and a deep copy of what was sent. */
interface Sent {
  model: string | undefined
  providerId: string | undefined
  credentialName: string | undefined
  system: string
  messages: Message[]
}

function record(opts: SendOptions): Sent {
  return {
    model: opts.model,
    providerId: opts.selectedProviderId,
    credentialName: opts.credentialName,
    system: (opts.system ?? []).map((b) => b.text).join("|"),
    messages: structuredClone(opts.messages),
  }
}

const text = (t: string): StreamedResponse => ({
  blocks: [{ type: "text", text: t }],
  text: t,
  stopReason: "end_turn",
})

const quotaError = (resetAt: number): Error =>
  Object.assign(new Error("quota"), {
    errorClass: "recoverable",
    recovery: "wait_for_quota",
    resetAt,
    streamErrorType: "rate_limit_error",
  })

/**
 * A clock whose sleep never ends by itself: only its signal ends it, as a
 * quota wait of hours does. `sleeping()` resolves when a sleep starts.
 */
function blockingClock(): RetryClock & { sleeping(): Promise<void>; sleeps: number } {
  let started: (() => void) | null = null
  const clock = {
    sleeps: 0,
    now: () => 1_000_000,
    sleep: (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((_resolve, reject) => {
        clock.sleeps++
        if (signal?.aborted) return reject(signal.reason)
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true })
        started?.()
        started = null
      }),
    sleeping: () =>
      new Promise<void>((resolve) => {
        started = resolve
      }),
  }
  return clock
}

function build(overrides: Partial<AgentCoreConfig>): { core: AgentCore; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const core = new AgentCore({
    auth: AUTH,
    model: "model-a",
    providerId: P1,
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "tool output", isError: false }) },
    eventSink: { emit: (e) => events.push(e) },
    retry: { random: () => 0.5 },
    ...overrides,
  })
  return { core, events }
}

async function drain(gen: AsyncGenerator<string, TurnResult, undefined>): Promise<TurnResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

afterEach(() => {
  clearModelRegistry()
  clearProviderRegistry()
  clearProviderPlugins()
})

describe("a target change ends a retry or quota wait", () => {
  /** Request 1 fails with a quota error. Each later request answers. */
  function quotaThenOk(sent: Sent[]): TransportFn {
    return async function* (opts): AsyncGenerator<string, StreamedResponse, undefined> {
      sent.push(record(opts))
      if (sent.length === 1) throw quotaError(1_000_000 + 8_837_000)
      yield "done"
      return text("done")
    }
  }

  it("switchTarget during a quota wait sends the next attempt to the new target, with no abort", async () => {
    registerProviders()
    const clock = blockingClock()
    const sent: Sent[] = []
    const { core, events } = build({ sendFn: quotaThenOk(sent), retry: { clock } })

    const waiting = clock.sleeping()
    const run = drain(core.run("go"))
    await waiting
    expect(events.at(-1)).toMatchObject({ type: "status", phase: "waiting_for_quota" })

    core.switchTarget({ providerId: P2, model: "model-x", credentialName: "second" })
    const result = await run

    expect(result.outcome).toBe("completed")
    expect(sent.map((s) => [s.providerId, s.model, s.credentialName])).toEqual([
      [P1, "model-a", undefined],
      [P2, "model-x", "second"],
    ])
    expect(clock.sleeps).toBe(1)
    expect(events.some((e) => e.type === "error")).toBe(false)
    expect(events.at(-1)).toEqual({ type: "run_finished", outcome: "completed" })
  })

  it("setModel and setEffort end a wait the same way", async () => {
    for (const change of [
      (c: AgentCore) => c.setModel("model-b"),
      (c: AgentCore) => c.setEffort("high"),
    ]) {
      registerProviders()
      const clock = blockingClock()
      const sent: Sent[] = []
      const { core } = build({ sendFn: quotaThenOk(sent), retry: { clock } })
      const waiting = clock.sleeping()
      const run = drain(core.run("go"))
      await waiting
      change(core)
      expect((await run).outcome).toBe("completed")
      expect(sent).toHaveLength(2)
      clearModelRegistry()
      clearProviderRegistry()
      clearProviderPlugins()
    }
  })

  it("a change to the same target does not end the wait", async () => {
    registerProviders()
    const clock = blockingClock()
    const sent: Sent[] = []
    const controller = new AbortController()
    const { core } = build({ sendFn: quotaThenOk(sent), retry: { clock } })
    const waiting = clock.sleeping()
    const run = drain(core.run("go", { signal: controller.signal }))
    await waiting

    core.switchTarget({ model: "model-a" })
    core.setModel("model-a")
    core.setEffort(undefined)
    await new Promise((r) => setTimeout(r, 5))
    expect(sent).toHaveLength(1)

    // The turn abort still ends the wait, and the turn.
    controller.abort()
    await expect(run).rejects.toMatchObject({ name: "AbortError" })
    expect(sent).toHaveLength(1)
  })

  it("a change that comes before the wait starts ends it at once", async () => {
    registerProviders()
    const clock = blockingClock()
    const sent: Sent[] = []
    const built = build({
      sendFn: quotaThenOk(sent),
      retry: { clock },
      eventSink: {
        // The status event comes just before the sleep.
        emit: (e) => {
          if (e.type === "status" && e.phase === "waiting_for_quota") {
            built.core.switchTarget({ model: "model-b" })
          }
        },
      },
    })
    expect((await drain(built.core.run("go"))).outcome).toBe("completed")
    expect(sent.map((s) => s.model)).toEqual(["model-a", "model-b"])
  })

  it("an error of an attempt that the target change overtook is sent again with no wait", async () => {
    registerProviders()
    const clock = blockingClock()
    const sent: Sent[] = []
    const built = build({
      retry: { clock },
      sendFn: async function* (opts): AsyncGenerator<string, StreamedResponse, undefined> {
        sent.push(record(opts))
        if (sent.length === 1) {
          // The user switches while request 1 is in flight. Then it fails.
          built.core.switchTarget({ providerId: P2, model: "model-x" })
          throw quotaError(1_000_000 + 8_837_000)
        }
        yield "done"
        return text("done")
      },
    })
    expect((await drain(built.core.run("go"))).outcome).toBe("completed")
    expect(sent.map((s) => s.providerId)).toEqual([P1, P2])
    expect(clock.sleeps).toBe(0)
    expect(built.events.some((e) => e.type === "status")).toBe(false)
  })
})

describe("a target change rebuilds the system prompt and discards thinking", () => {
  const thinking: ContentBlock = { type: "thinking", thinking: "", signature: "sig-a" }
  const redacted: ContentBlock = { type: "redacted_thinking", data: "encrypted" }
  const toolUse: ContentBlock = { type: "tool_use", id: "call-1", name: "Probe", input: {} }

  /** Round 1: thinking + a tool call. Round 2: the answer. `between` runs in the tool. */
  function twoRounds(between: (core: AgentCore) => void) {
    const sent: Sent[] = []
    const built = build({
      toolExecutor: {
        execute: async () => {
          between(built.core)
          return { content: "tool output", isError: false }
        },
      },
      sendFn: async function* (opts): AsyncGenerator<string, StreamedResponse, undefined> {
        sent.push(record(opts))
        if (sent.length === 1) {
          return { blocks: [thinking, redacted, toolUse], text: "", stopReason: "tool_use" }
        }
        yield "done"
        return text("done")
      },
    })
    return { ...built, sent }
  }

  const types = (m: Message | undefined): string[] =>
    typeof m?.content === "string" ? ["string"] : (m?.content ?? []).map((b) => b.type)

  it("switchTarget between tool rounds: new system prompt, no thinking, the tool call and its result stay", async () => {
    registerProviders()
    const { core, sent } = twoRounds((c) => c.switchTarget({ providerId: P2, model: "model-x" }))

    expect((await drain(core.run("go"))).outcome).toBe("completed")

    expect(sent[0]?.system).toBe(`SYS ${P1} model-a`)
    expect(sent[1]?.system).toBe(`SYS ${P2} model-x`)
    const assistant = sent[1]?.messages.find((m) => m.role === "assistant")
    expect(types(assistant)).toEqual(["tool_use"])
    expect(JSON.stringify(sent[1]?.messages)).not.toContain("sig-a")
    expect(JSON.stringify(sent[1]?.messages)).not.toContain("encrypted")
    expect(types(sent[1]?.messages.at(-1))).toContain("tool_result")
    // The live history has no thinking after the run.
    expect(types(core.history().find((m) => m.role === "assistant"))).toEqual(["tool_use"])
  })

  it("setModel between tool rounds does the same (same provider)", async () => {
    registerProviders()
    const { core, sent } = twoRounds((c) => c.setModel("model-b"))
    await drain(core.run("go"))
    expect(sent[1]?.system).toBe(`SYS ${P1} model-b`)
    expect(types(sent[1]?.messages.find((m) => m.role === "assistant"))).toEqual(["tool_use"])
  })

  it("setEffort between tool rounds discards thinking too", async () => {
    registerProviders()
    const { core, sent } = twoRounds((c) => c.setEffort("high"))
    await drain(core.run("go"))
    expect(sent[1]?.system).toBe(`SYS ${P1} model-a`)
    expect(types(sent[1]?.messages.find((m) => m.role === "assistant"))).toEqual(["tool_use"])
  })

  it("with no target change, thinking goes back unchanged", async () => {
    registerProviders()
    const { core, sent } = twoRounds(() => {})
    await drain(core.run("go"))
    expect(sent[1]?.system).toBe(sent[0]?.system)
    expect(sent[1]?.messages.find((m) => m.role === "assistant")?.content).toEqual([
      thinking,
      redacted,
      toolUse,
    ])
  })

  it("a change while a request is in flight does not touch that request's history", async () => {
    registerProviders()
    let inFlight: Message[] = []
    const built = build({
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "earlier" }] },
        { role: "assistant", content: [thinking, { type: "text", text: "answer" }] },
      ],
      sendFn: async function* (opts): AsyncGenerator<string, StreamedResponse, undefined> {
        built.core.switchTarget({ model: "model-b" })
        // Still the history that this request was sent with.
        inFlight = structuredClone(built.core.history())
        void opts
        yield "done"
        return text("done")
      },
    })
    await drain(built.core.run("go"))
    expect(types(inFlight[1])).toEqual(["thinking", "text"])
    // After the run, the discard has run.
    expect(types(built.core.history()[1])).toEqual(["text"])
  })

  it("a change with no run active discards thinking at once", () => {
    registerProviders()
    const { core } = build({
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "earlier" }] },
        { role: "assistant", content: [thinking] },
        { role: "assistant", content: [redacted, { type: "text", text: "answer" }] },
      ],
    })
    core.switchTarget({ credentialName: "second" })
    // A message that had only thinking is removed completely.
    expect(core.history().map((m) => types(m))).toEqual([["text"], ["text"]])
  })
})

describe("a target change writes one session record, after the last response of the old target", () => {
  /** A persistence port that records the order of the writes. */
  function recordingPersistence(log: string[], entries: TargetSwitchEntry[]): SessionPersistence {
    return {
      appendUser: () => {
        log.push("user")
        return "id"
      },
      appendAssistant: () => {
        log.push("assistant")
      },
      appendToolResult: () => {
        log.push("tool_result")
      },
      appendNote: () => {},
      appendRewind: () => {},
      appendTargetSwitch: (entry) => {
        log.push("target_switch")
        entries.push(entry)
      },
    }
  }

  it("a change during a request is written after that request's response", async () => {
    registerProviders()
    const log: string[] = []
    const entries: TargetSwitchEntry[] = []
    let calls = 0
    const built = build({
      sessionPersistence: recordingPersistence(log, entries),
      sendFn: async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
        calls++
        if (calls === 1) {
          built.core.switchTarget({ providerId: P2, model: "model-x", credentialName: "second" })
          return {
            blocks: [
              { type: "thinking", thinking: "", signature: "sig-a" },
              { type: "tool_use", id: "call-1", name: "Probe", input: {} },
            ],
            text: "",
            stopReason: "tool_use",
          }
        }
        yield "done"
        return text("done")
      },
    })
    await drain(built.core.run("go"))

    // The response with the old thinking comes before the record, so the
    // model fold of a resume discards that thinking too.
    expect(log.indexOf("target_switch")).toBeGreaterThan(log.indexOf("assistant"))
    expect(log.filter((k) => k === "target_switch")).toHaveLength(1)
    expect(entries).toEqual([
      {
        providerId: P2,
        credentialName: "second",
        model: "model-x",
        effort: undefined,
        discardedThinking: true,
      },
    ])
  })

  it("two changes before the next attempt give one record with the newest target", async () => {
    registerProviders()
    const log: string[] = []
    const entries: TargetSwitchEntry[] = []
    let calls = 0
    const built = build({
      sessionPersistence: recordingPersistence(log, entries),
      sendFn: async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
        calls++
        if (calls === 1) {
          built.core.setModel("model-b")
          built.core.setEffort("high")
        }
        yield "done"
        return text("done")
      },
    })
    await drain(built.core.run("go"))
    expect(entries).toEqual([
      { providerId: P1, model: "model-b", effort: "high", discardedThinking: true },
    ])
  })

  it("a change with no run active is written at once", () => {
    registerProviders()
    const entries: TargetSwitchEntry[] = []
    const { core } = build({ sessionPersistence: recordingPersistence([], entries) })
    core.setEffort("high")
    core.setEffort("high")
    expect(entries).toEqual([
      { providerId: P1, model: "model-a", effort: "high", discardedThinking: true },
    ])
  })
})

describe("a switch while an output schema is set", () => {
  function registerPlain(): void {
    registerTestProvider({
      id: "tc-plain",
      displayName: "tc-plain",
      models: [
        { id: "no-so", capabilities: { structuredOutputs: false } },
        { id: "with-so", capabilities: { structuredOutputs: true } },
      ],
    })
  }

  it("refuses a model with no structured outputs, and changes nothing", () => {
    registerProviders()
    registerPlain()
    const { core } = build({ outputSchema: { type: "object" } })
    const before = core.getTarget()
    expect(() => core.switchTarget({ providerId: "tc-plain", model: "no-so" })).toThrow(
      /no structured outputs/,
    )
    expect(core.getTarget()).toEqual(before)
    core.switchTarget({ providerId: "tc-plain", model: "with-so" })
    expect(core.getModel()).toBe("with-so")
  })

  it("accepts the same model with no schema set", () => {
    registerProviders()
    registerPlain()
    const { core } = build({})
    core.switchTarget({ providerId: "tc-plain", model: "no-so" })
    expect(core.getModel()).toBe("no-so")
  })
})

describe("onTargetChange", () => {
  it("gets each change with the full from and to, and a listener that throws changes nothing", () => {
    registerProviders()
    const { core } = build({ effort: "low" })
    const seen: TargetSwitch[] = []
    core.onTargetChange(() => {
      throw new Error("listener bug")
    })
    const off = core.onTargetChange((change) => seen.push(change))

    core.setModel("model-b")
    core.setEffort("high")
    core.switchTarget({ providerId: P2, model: "model-x", credentialName: "second" })
    core.switchTarget({ model: "model-x" })
    off()
    core.setEffort("low")

    expect(seen.map((c) => c.to)).toEqual([
      { providerId: P1, model: "model-b", effort: "low" },
      { providerId: P1, model: "model-b", effort: "high" },
      { providerId: P2, credentialName: "second", model: "model-x", effort: "high" },
    ])
    expect(seen[2]?.from).toEqual({ providerId: P1, model: "model-b", effort: "high" })
    expect(core.getTarget()).toMatchObject({ providerId: P2, model: "model-x", effort: "low" })
  })
})

describe("the media resolver gets the live model", () => {
  it("each turn gives the resolver the model of that turn", async () => {
    registerProviders()
    const seen: (string | undefined)[] = []
    const { core } = build({
      sendFn: async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
        yield "done"
        return text("done")
      },
      mediaResolver: {
        resolveUserContent: async (userText, ctx) => {
          seen.push(ctx?.modelId)
          return [{ type: "text", text: userText }]
        },
      },
    })
    await drain(core.run("one"))
    core.setModel("model-b")
    await drain(core.run("two"))
    expect(seen).toEqual(["model-a", "model-b"])
  })
})

describe("switchTarget quiet", () => {
  it("sends no notice with quiet, and one notice without it", () => {
    registerProviders()
    const { core, events } = build({})
    core.switchTarget({ model: "model-b" }, { quiet: true })
    expect(core.getModel()).toBe("model-b")
    expect(events.filter((e) => e.type === "notice")).toHaveLength(0)
    core.switchTarget({ model: "model-a" })
    expect(events.filter((e) => e.type === "notice")).toHaveLength(1)
  })
})

describe("discardThinking", () => {
  it("removes thinking blocks from assistant messages only, and counts them", () => {
    const messages: Message[] = [
      { role: "user", content: "plain" },
      { role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "s" }] },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: "d" },
          { type: "text", text: "kept" },
        ],
      },
    ]
    expect(discardThinking(messages)).toBe(2)
    expect(messages).toEqual([
      { role: "user", content: "plain" },
      { role: "assistant", content: [{ type: "text", text: "kept" }] },
    ])
    expect(discardThinking(messages)).toBe(0)
  })

  it("joins the two user messages around an assistant message that had only thinking", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c", content: "out" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "s" }] },
      { role: "user", content: "continue" },
      { role: "assistant", content: [{ type: "text", text: "answer" }] },
    ]
    discardThinking(messages)
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(messages[0]?.content).toEqual([
      { type: "tool_result", tool_use_id: "c", content: "out" },
      { type: "text", text: "continue" },
    ])
  })
})
