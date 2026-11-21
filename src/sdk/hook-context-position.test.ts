/**
 * Hook context positions: a `{ text, position }` entry from `turn.willStart`
 * or `session.willStart` goes before or after the user text in the first
 * user message of a turn. Strings mean "after". Other channels ignore the
 * position. The system prompt bytes never change.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { LifecyclePortAdapter } from "../adapters/lifecycle-port-adapter.ts"
import type { AuthResult } from "../auth/auth.ts"
import type { Message } from "../llm/messages.ts"
import type { SendOptions, StreamedResponse, TransportFn } from "../llm/transport/types.ts"
import { executeToolRound } from "../loops/tool-round.ts"
import { Hooks } from "../plugins/hooks/hooks.ts"
import { NO_SIDEBAND } from "../sideband/api.ts"
import { COMPACT_TEST_TEXT } from "../test-utils/compact-test-text.ts"
import { fixtureSidebandOrNone, sidebandFixturePresent } from "../test-utils/sideband-fixture.ts"
import { ToolFeedbackTracker } from "../tools/feedback-tracker.ts"

import { AgentCore, type TurnResult } from "./agent-core.ts"
import {
  cleanHookContext,
  type HookContextEntry,
  isHookContextEntry,
  splitHookContext,
  wrapHookContext,
} from "./hook-context.ts"
import { allowDecision, denyDecision, type LifecyclePort } from "./lifecycle.ts"
import type { AgentCoreConfig } from "./ports.ts"

/** The real codec (sibling checkout), else `NO_SIDEBAND`: the policy tags render here. */
const SB = fixtureSidebandOrNone()
/** `describe` for the tests that pin the bytes of a policy tag. */
const describeSb = describe.skipIf(!sidebandFixturePresent())

const AUTH: AuthResult = { type: "api-key", token: "test-token" }
const PLUGIN = { caller: "plugin" as const, priority: 50, source: "test" }
const TMP_BASE = join(import.meta.dirname, "..", "..", "tmp")
mkdirSync(TMP_BASE, { recursive: true })
const w = (s: string): string => `<ma::agent::policy>${s}</ma::agent::policy>`

type Reply = Partial<StreamedResponse>

function recorder(replies: Reply[] = []): { sendFn: TransportFn; requests: SendOptions[] } {
  const requests: SendOptions[] = []
  const sendFn: TransportFn = async function* (opts) {
    requests.push(JSON.parse(JSON.stringify(opts)) as SendOptions)
    const r = replies[requests.length - 1]
    if (r) return r as StreamedResponse
    return {
      blocks: [{ type: "text", text: "ok" }],
      text: "ok",
      stopReason: "end_turn",
    } as StreamedResponse
  }
  return { sendFn, requests }
}

function core(sendFn: TransportFn, over: Partial<AgentCoreConfig> = {}): AgentCore {
  return new AgentCore({
    auth: AUTH,
    model: "test-model-1",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "", isError: false }) },
    sendFn,
    sideband: SB,
    ...over,
  })
}

async function drain(gen: AsyncGenerator<string, TurnResult, undefined>): Promise<TurnResult> {
  for (;;) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

const texts = (m: Message | undefined): string[] => {
  const c = m?.content
  if (typeof c === "string") return [c]
  return (c ?? []).map((b) => (b.type === "text" ? b.text : b.type))
}
const lastTexts = (req: SendOptions | undefined): string[] => texts(req?.messages.at(-1))
const systemText = (req: SendOptions | undefined): string => JSON.stringify(req?.system ?? [])

describe("splitHookContext / cleanHookContext", () => {
  it("strings and a missing position count as after, order is kept", () => {
    const entries: HookContextEntry[] = [
      "a",
      { text: "b", position: "before" },
      { text: "c" },
      { text: "d", position: "after" },
      { text: "e", position: "before" },
      "  ",
    ]
    expect(splitHookContext(entries)).toEqual({ before: ["b", "e"], after: ["a", "c", "d"] })
    expect(cleanHookContext(entries)).toEqual(["a", "b", "c", "d", "e"])
  })

  it.skipIf(!sidebandFixturePresent())("wrapHookContext reads the entry text", () => {
    expect(wrapHookContext(SB, [{ text: "x", position: "before" }])).toBe(w("x"))
  })

  it("wrapHookContext with no codec (NO_SIDEBAND) gives the texts with no wrapper", () => {
    expect(wrapHookContext(NO_SIDEBAND, ["a", { text: "b", position: "before" }])).toBe("a\nb")
    expect(wrapHookContext(NO_SIDEBAND, [" ", ""])).toBe("")
  })

  it("drops malformed entries", () => {
    const bad: unknown[] = [
      { text: 1 },
      { position: "before" },
      { text: "x", position: "middle" },
      3,
      null,
    ]
    expect(bad.some(isHookContextEntry)).toBe(false)
    expect(splitHookContext(bad)).toEqual({ before: [], after: [] })
    expect(cleanHookContext(bad)).toEqual([])
  })
})

describeSb("first user message assembly", () => {
  it("turn context: before blocks, user text, after blocks", async () => {
    const { sendFn, requests } = recorder()
    const agent = core(sendFn)
    await drain(
      agent.run("prompt", {
        additionalContext: [
          { text: "b1", position: "before" },
          "a1",
          { text: "b2", position: "before" },
        ],
      }),
    )
    expect(lastTexts(requests[0])).toEqual([`${w("b1")}\n${w("b2")}`, "prompt", w("a1")])
  })

  it("only before: no empty after block", async () => {
    const { sendFn, requests } = recorder()
    const agent = core(sendFn)
    await drain(agent.run("p", { additionalContext: [{ text: "b", position: "before" }] }))
    expect(lastTexts(requests[0])).toEqual([w("b"), "p"])
  })

  it("session and turn groups: session before, turn before, text, session after, turn after", async () => {
    const { sendFn, requests } = recorder()
    let modeOnce = true
    const agent = core(sendFn, {
      modeProvider: {
        activeModeId: () => null,
        consumePendingAttachment: () => {
          if (!modeOnce) return null
          modeOnce = false
          return { type: "text", text: "MODE" }
        },
      },
    })
    agent.addSessionContext([{ text: "sb", position: "before" }, "sa"])
    await drain(agent.run("p", { additionalContext: ["ta", { text: "tb", position: "before" }] }))
    expect(lastTexts(requests[0])).toEqual(["MODE", w("sb"), w("tb"), "p", w("sa"), w("ta")])
  })

  it("system prompt bytes are the same with and without before/after context", async () => {
    const plain = recorder()
    await drain(core(plain.sendFn).run("p"))
    const ctx = recorder()
    const agent = core(ctx.sendFn)
    agent.addSessionContext([{ text: "sb", position: "before" }, "sa"])
    await drain(agent.run("p", { additionalContext: [{ text: "tb", position: "before" }, "ta"] }))
    expect(systemText(ctx.requests[0])).toBe(systemText(plain.requests[0]))
    expect(systemText(ctx.requests[0])).not.toContain("sb")
  })

  it("resume dedupe: a known before block and a known after block are not added again", async () => {
    const history: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: w("sb") },
          { type: "text", text: "hi" },
          { type: "text", text: w("sa") },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    const { sendFn, requests } = recorder()
    const agent = core(sendFn, { initialMessages: structuredClone(history) })
    agent.addSessionContext([{ text: "sb", position: "before" }, "sa"])
    await drain(agent.run("go"))
    expect(lastTexts(requests[0])).toEqual(["go"])
    agent.addSessionContext([{ text: "new", position: "before" }, "sa"])
    await drain(agent.run("again"))
    expect(lastTexts(requests[1])).toEqual([w("new"), "again"])
  })

  it("resume dedupe (D1): a string session block after the user text is not added again", async () => {
    const history: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "text", text: w("s") },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    const { sendFn, requests } = recorder()
    const agent = core(sendFn, { initialMessages: structuredClone(history) })
    agent.addSessionContext(["s"])
    await drain(agent.run("go"))
    expect(lastTexts(requests[0])).toEqual(["go"])
  })

  it("resume dedupe (F7): a pre-P1 block before the user text still dedupes string entries", async () => {
    const history: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: `${w("s1")}\n${w("s2")}` },
          { type: "text", text: "hi" },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    const { sendFn, requests } = recorder()
    const agent = core(sendFn, { initialMessages: structuredClone(history) })
    agent.addSessionContext(["s1", "s2"])
    await drain(agent.run("go"))
    expect(lastTexts(requests[0])).toEqual(["go"])
  })

  it("dedupe across groups (F2): one take lands a shared text only in the before group", async () => {
    const { sendFn, requests } = recorder()
    const agent = core(sendFn)
    agent.addSessionContext(["x", { text: "x", position: "before" }, "y"])
    await drain(agent.run("p"))
    expect(lastTexts(requests[0])).toEqual([w("x"), "p", w("y")])
  })

  it("dedupe across groups (F2): a before group equal to an old after block is not added again", async () => {
    const history: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          { type: "text", text: w("s") },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ]
    const { sendFn, requests } = recorder()
    const agent = core(sendFn, { initialMessages: structuredClone(history) })
    agent.addSessionContext([{ text: "s", position: "before" }])
    await drain(agent.run("go"))
    expect(lastTexts(requests[0])).toEqual(["go"])
  })

  it("compaction (F7): session.willStart object entries keep their position", async () => {
    const lifecycle: LifecyclePort = {
      async beforeSend(p) {
        return p.compact ? denyDecision("no network in tests") : allowDecision(p)
      },
      async sessionWillStart() {
        return { additionalContext: [{ text: "cb", position: "before" }, "ca"] }
      },
    }
    const { sendFn, requests } = recorder()
    const agent = core(sendFn, { lifecycle, syntheticTextResolver: COMPACT_TEST_TEXT })
    for (let i = 0; i < 8; i++) {
      agent.messages.push({ role: "user", content: `u${i}` })
      agent.messages.push({ role: "assistant", content: `a${i}` })
    }
    await agent.compact({ reason: "manual", mode: "local" })
    await drain(agent.run("go"))
    expect(lastTexts(requests[0])).toEqual([w("cb"), "go", w("ca")])
  })

  it("mid-turn session context: both groups go before the content, after tool results", async () => {
    let agent: AgentCore | undefined
    const { sendFn, requests } = recorder([
      {
        blocks: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
        text: "",
        stopReason: "tool_use",
      },
    ])
    agent = core(sendFn, {
      toolRegistry: { list: () => [{ name: "x", description: "x", input_schema: {} }] },
      toolExecutor: {
        execute: async () => {
          agent?.addSessionContext(["ma", { text: "mb", position: "before" }])
          return { content: "ok", isError: false }
        },
      },
    })
    await drain(agent.run("go"))
    const t = lastTexts(requests[1])
    expect(t.slice(0, 3)).toEqual(["tool_result", w("mb"), w("ma")])
  })
})

describeSb("position is ignored on other channels", () => {
  it("tool.willInvoke and tool.didInvoke: the text lands in the tool result", async () => {
    const hooks = new Hooks({ logger: () => {} })
    const before = { text: "WILL", position: "before" as const }
    hooks.on("tool.willInvoke", () => ({ additionalContext: [before] }), PLUGIN)
    hooks.on("tool.didInvoke", () => ({ additionalContext: [{ ...before, text: "DID" }] }), PLUGIN)
    const dir = mkdtempSync(join(TMP_BASE, "ma-hook-pos-"))
    try {
      const result = await executeToolRound(
        {
          type: "tool_use",
          id: "tu_pos",
          name: "Write",
          input: { file_path: join(dir, "a.txt"), content: "x\n" },
        },
        {
          sidebandApi: SB,
          loader: null,
          modeManager: null,
          blobStore: null,
          blobSkipTools: new Set(),
          feedbackTracker: new ToolFeedbackTracker(),
          model: "test-model",
          store: null,
          lifecycle: new LifecyclePortAdapter(hooks),
        },
      )
      const text = JSON.stringify(result.content)
      expect(text).toContain(w("WILL"))
      expect(text).toContain(w("DID"))
      expect(text.indexOf(w("WILL"))).toBeGreaterThan(0)
      expect(text).not.toContain("position")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("turn.willStop: the text joins the continuation note", async () => {
    let calls = 0
    const lifecycle: LifecyclePort = {
      async beforeTurnStop(p) {
        calls++
        return calls === 1
          ? denyDecision("more", p, [{ text: "STOPCTX", position: "before" }])
          : allowDecision(p)
      },
    }
    const { sendFn, requests } = recorder()
    const agent = core(sendFn, { lifecycle })
    await drain(agent.run("go"))
    expect(requests.length).toBe(2)
    const note = lastTexts(requests[1]).join("\n")
    expect(note).toContain(w("STOPCTX"))
    expect(note).not.toContain("position")
  })
})

/**
 * Turn context with AND without a codec (owner rule: the plugin content is
 * never dropped). With no codec each entry is its text with no wrapper, in
 * the same place as the tag. With the codec the bytes are the tags.
 */
const CONTEXT_MODES = [
  { name: "no codec (NO_SIDEBAND)", sb: NO_SIDEBAND, wrap: (s: string): string => s, skip: false },
  { name: "fixture codec", sb: SB, wrap: w, skip: !sidebandFixturePresent() },
]

for (const mode of CONTEXT_MODES) {
  describe.skipIf(mode.skip)(`plugin turn context reaches the model, ${mode.name}`, () => {
    const W = mode.wrap
    const run = (sendFn: TransportFn, over: Partial<AgentCoreConfig> = {}): AgentCore =>
      core(sendFn, { sideband: mode.sb, ...over })

    it("session.willStart and turn.willStart context: before and after the user text", async () => {
      const { sendFn, requests } = recorder()
      const agent = run(sendFn)
      agent.addSessionContext([{ text: "sb", position: "before" }, "sa"])
      await drain(agent.run("p", { additionalContext: ["ta", { text: "tb", position: "before" }] }))
      expect(lastTexts(requests[0])).toEqual([W("sb"), W("tb"), "p", W("sa"), W("ta")])
    })

    it("turn.willStop halt: the reason and context continue the turn", async () => {
      let calls = 0
      const lifecycle: LifecyclePort = {
        async beforeTurnStop(p) {
          calls++
          return calls === 1 ? denyDecision("more", p, ["STOPCTX"]) : allowDecision(p)
        },
      }
      const { sendFn, requests } = recorder()
      await drain(run(sendFn, { lifecycle }).run("go"))
      expect(requests.length).toBe(2)
      expect(lastTexts(requests[1])).toEqual([`${W("more")}\n${W("STOPCTX")}`])
    })

    it("tool.willInvoke and tool.didInvoke context: the text lands in the tool result", async () => {
      const hooks = new Hooks({ logger: () => {} })
      hooks.on("tool.willInvoke", () => ({ additionalContext: ["WILL"] }), PLUGIN)
      hooks.on("tool.didInvoke", () => ({ additionalContext: ["DID"] }), PLUGIN)
      const dir = mkdtempSync(join(TMP_BASE, "ma-hook-nocodec-"))
      try {
        const result = await executeToolRound(
          {
            type: "tool_use",
            id: "tu_nc",
            name: "Write",
            input: { file_path: join(dir, "a.txt"), content: "x\n" },
          },
          {
            sidebandApi: mode.sb,
            loader: null,
            modeManager: null,
            blobStore: null,
            blobSkipTools: new Set(),
            feedbackTracker: new ToolFeedbackTracker(),
            model: "test-model",
            store: null,
            lifecycle: new LifecyclePortAdapter(hooks),
          },
        )
        expect(String(result.content).endsWith(`\n${W("WILL")}\n${W("DID")}`)).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it("the system prompt bytes do not change with turn context", async () => {
      const plain = recorder()
      await drain(run(plain.sendFn).run("p"))
      const ctx = recorder()
      const agent = run(ctx.sendFn)
      agent.addSessionContext(["sa"])
      await drain(agent.run("p", { additionalContext: ["ta"] }))
      expect(systemText(ctx.requests[0])).toBe(systemText(plain.requests[0]))
    })
  })
}

describe("HookBus entries and malformed results", () => {
  it("collects entries as they are, in listener order", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on("turn.willStart", () => ({ additionalContext: ["s"] }), { ...PLUGIN, priority: 20 })
    hooks.on(
      "turn.willStart",
      () => ({ additionalContext: [{ text: "b", position: "before" as const }] }),
      {
        ...PLUGIN,
        priority: 10,
      },
    )
    const r = await hooks.emitChain("turn.willStart", { text: "hi" })
    expect(r.additionalContext).toEqual(["s", { text: "b", position: "before" }])
  })

  it("a failClosed listener with a malformed entry halts the chain", async () => {
    for (const bad of [{ text: 1 }, { text: "x", position: "middle" }]) {
      const hooks = new Hooks({ logger: () => {} })
      hooks.on("tool.willInvoke", () => ({ additionalContext: [bad] }) as never, {
        ...PLUGIN,
        failClosed: true,
      })
      const r = await hooks.emitChain("tool.willInvoke", {
        tool: "Bash",
        toolUseId: "1",
        input: {},
        cwd: "/",
      })
      expect(r.halted).toBe(true)
      expect(r.failed).toBe(true)
      expect(r.failure?.detail).toContain("malformed additionalContext")
    }
  })

  it("a valid object entry passes a failClosed listener", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on(
      "tool.willInvoke",
      () => ({ additionalContext: [{ text: "ok", position: "after" as const }] }),
      {
        ...PLUGIN,
        failClosed: true,
      },
    )
    const r = await hooks.emitChain("tool.willInvoke", {
      tool: "Bash",
      toolUseId: "1",
      input: {},
      cwd: "/",
    })
    expect(r.halted).toBe(false)
  })

  it("session.willStart keeps entries as they are", async () => {
    const hooks = new Hooks({ logger: () => {} })
    hooks.on(
      "session.willStart",
      () => ({ additionalContext: [{ text: "b", position: "before" as const }, "a"] }),
      PLUGIN,
    )
    const r = await new LifecyclePortAdapter(hooks).sessionWillStart({
      source: "startup",
      sid: "s",
      cwd: "/",
      model: "m",
    })
    expect(r.additionalContext).toEqual([{ text: "b", position: "before" }, "a"])
  })
})
