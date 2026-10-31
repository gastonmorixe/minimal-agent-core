/**
 * `Session`-specific contract tests for the additions this task made on
 * top of agent M's S47 design (the CLI engine-integration migration):
 * per-run `askUser` / `drainQueuedUserText` / `onQueueInject` /
 * `beforeReflectionCheckpoint` overrides, the `askUserFallback: "none"`
 * construction option, `run()`'s `result` promise, the `agentCore()`
 * escape hatch, and the `lifecycle` passthrough. `runtime.test.ts` covers
 * `createRuntime` / `openSession` / `resumeSession` orchestration; this
 * file is scoped to `Session.run()`'s own per-run port contract.
 *
 * @module runtime/session.test
 */

import { afterEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import type { CanonicalRequest } from "../llm/canonical-request.ts"
import { defaultCapabilities } from "../llm/capabilities.ts"
import type { Message } from "../llm/messages.ts"
import {
  clearModelRegistry,
  clearProviderRegistry,
  type ModelEntry,
  registerModel,
  registerProvider,
} from "../llm/model-registry.ts"
import type {
  PreflightIssue,
  PreflightResolution,
  ProviderAdapter,
  ValidationResult,
} from "../llm/provider.ts"
import type { SendOptions, StreamedResponse } from "../llm/transport/types.ts"
import type { LifecyclePort } from "../sdk/lifecycle.ts"
import type { SessionEntry } from "../session/event-log.ts"

import { createRuntime } from "./runtime.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

const textOk = (text: string): StreamedResponse => ({
  blocks: [{ type: "text", text }],
  text,
  stopReason: "end_turn",
})

function staticTransport(text: string) {
  return async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    return textOk(text)
  }
}

/** Drain an `AsyncIterable<SessionEntry>` to an array. Rethrows a run failure after collecting. */
async function collect(entries: AsyncIterable<SessionEntry>): Promise<SessionEntry[]> {
  const out: SessionEntry[] = []
  for await (const entry of entries) out.push(entry)
  return out
}

// ---------------------------------------------------------------------------
// A synthetic preflight provider (neutral, I1/I2-clean — same shape as
// `src/agent/agent.preflight.test.ts`'s): flags a stale thinking-block
// signature so `askUserFallback` and the per-run `askUser` override have a
// real preflight issue to exercise, not just the registry's own
// resolve/decline plumbing in isolation.
// ---------------------------------------------------------------------------

const ISSUE_STALE_SIGNATURE = "test.session-thinking-signature-mismatch"
const OPTION_STRIP = "strip"
const OPTION_CANCEL = "cancel"
const STALE_SIGNATURE = "sig-from-another-model-session-test"

function fakeModel(id: string): ModelEntry {
  return {
    id,
    providerId: "session-test-prov",
    surfaceId: "custom",
    displayName: id,
    capabilities: defaultCapabilities(),
    pricing: {
      inputUSD: 1,
      outputUSD: 1,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
  }
}

function registerFakePreflightProvider(): void {
  registerModel(fakeModel("session-test-model"))
  const adapter: ProviderAdapter = {
    id: "session-test-prov",
    displayName: "Session Test Provider",
    surfaces: ["custom"],
    validate(): ValidationResult {
      return { ok: true, errors: [] }
    },
    async *run() {
      throw new Error("fake preflight provider: run() is not exercised by these tests")
    },
    preflight(req: CanonicalRequest): PreflightIssue[] {
      const stale = req.messages.some(
        (m) =>
          m.role === "assistant" &&
          Array.isArray(m.content) &&
          m.content.some((b) => b.type === "thinking" && b.signature === STALE_SIGNATURE),
      )
      if (!stale) return []
      return [
        {
          code: ISSUE_STALE_SIGNATURE,
          title: "Stale reasoning from a different model",
          detail: "History contains thinking signed by another model.",
          options: [
            { id: OPTION_STRIP, label: "Strip" },
            { id: OPTION_CANCEL, label: "Cancel" },
          ],
        },
      ]
    },
    applyResolution(
      req: CanonicalRequest,
      issueCode: string,
      optionId: string,
    ): PreflightResolution {
      if (issueCode !== ISSUE_STALE_SIGNATURE) throw new Error(`unknown issue code: ${issueCode}`)
      if (optionId === OPTION_CANCEL) return { kind: "cancel" }
      if (optionId === OPTION_STRIP) {
        const messages = req.messages.map((m) =>
          m.role === "assistant" && Array.isArray(m.content)
            ? { ...m, content: m.content.filter((b) => b.type !== "thinking") }
            : m,
        )
        return { kind: "modify-request", request: { ...req, messages } }
      }
      throw new Error(`unknown option id: ${optionId}`)
    },
  }
  registerProvider(adapter)
}

function staleAssistant(): Message {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "old thoughts", signature: STALE_SIGNATURE },
      { type: "text", text: "old reply" },
    ],
  }
}

function captureSendFn(captured: Message[][]) {
  return async function* (opts: SendOptions): AsyncGenerator<string, StreamedResponse, undefined> {
    captured.push(structuredClone(opts.messages) as Message[])
    yield "ok"
    return textOk("ok")
  }
}

describe("Session.run — askUserFallback", () => {
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
  })

  it('"none": no per-run askUser → denies the preflight issue headlessly, sends unchanged', async () => {
    registerFakePreflightProvider()
    const captured: Message[][] = []
    const runtime = createRuntime()
    const session = runtime.openSession({
      auth: AUTH,
      model: "session-test-model",
      sendFn: captureSendFn(captured),
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "previous" }] },
        staleAssistant(),
      ],
      askUserFallback: "none",
    })

    const entries = await collect(session.run("hi"))

    // No ask_user event: the headless fallback short-circuits before the
    // port layer, exactly like `AgentCore`'s own "no port" path.
    expect(entries.some((e) => e.ch === "event" && e.data.type === "ask_user")).toBe(false)
    expect(captured).toHaveLength(1)
    const asst = captured[0]?.[1]
    const types = Array.isArray(asst?.content)
      ? asst.content.map((b: { type: string }) => b.type)
      : []
    expect(types).toContain("thinking")
    runtime.close()
  })

  it('"none" + a per-run askUser override still asks, and the chosen resolution applies', async () => {
    registerFakePreflightProvider()
    const captured: Message[][] = []
    const askCalls: PreflightIssue[] = []
    const runtime = createRuntime()
    const session = runtime.openSession({
      auth: AUTH,
      model: "session-test-model",
      sendFn: captureSendFn(captured),
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "previous" }] },
        staleAssistant(),
      ],
      askUserFallback: "none",
    })

    await collect(
      session.run("hi", {
        askUser: async (issue) => {
          askCalls.push(issue)
          return OPTION_STRIP
        },
      }),
    )

    expect(askCalls).toHaveLength(1)
    expect(askCalls[0]?.code).toBe(ISSUE_STALE_SIGNATURE)
    expect(captured).toHaveLength(1)
    const asst = captured[0]?.[1]
    const types = Array.isArray(asst?.content)
      ? asst.content.map((b: { type: string }) => b.type)
      : []
    expect(types).not.toContain("thinking")
    runtime.close()
  })

  it('default ("registry"): a real preflight ask resolves via session.answer()', async () => {
    registerFakePreflightProvider()
    const captured: Message[][] = []
    const runtime = createRuntime()
    const session = runtime.openSession({
      auth: AUTH,
      model: "session-test-model",
      sendFn: captureSendFn(captured),
      initialMessages: [
        { role: "user", content: [{ type: "text", text: "previous" }] },
        staleAssistant(),
      ],
      // askUserFallback omitted: defaults to "registry".
    })

    const run = session.run("hi")
    let askId: string | undefined
    const drain = (async () => {
      const out: SessionEntry[] = []
      for await (const entry of run) {
        out.push(entry)
        if (entry.ch === "event" && entry.data.type === "ask_user") askId = entry.data.askId
      }
      return out
    })()

    while (askId === undefined) await Promise.resolve()
    expect(session.answer(askId, OPTION_STRIP)).toBe(true)
    // A stale id is never pending.
    expect(session.answer("no-such-ask", OPTION_STRIP)).toBe(false)

    await drain
    expect(captured).toHaveLength(1)
    const asst = captured[0]?.[1]
    const types = Array.isArray(asst?.content)
      ? asst.content.map((b: { type: string }) => b.type)
      : []
    expect(types).not.toContain("thinking")
    runtime.close()
  })
})

describe("Session.run — per-run input-queue and reflection-gate overrides", () => {
  it("forwards drainQueuedUserText/onQueueInject for an unknown-tool continuation round", async () => {
    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round === 1) {
        return {
          blocks: [{ type: "tool_use", id: "t1", name: "NoSuchTool", input: {} }],
          text: "",
          stopReason: "tool_use",
        }
      }
      return textOk("done")
    }
    const runtime = createRuntime()
    const session = runtime.openSession({ auth: AUTH, model: "m", sendFn })

    const injected: string[] = []
    await collect(
      session.run("go", {
        drainQueuedUserText: () => "queued text",
        onQueueInject: (text) => injected.push(text),
      }),
    )

    expect(injected).toEqual(["queued text"])
    runtime.close()
  })

  it("forwards beforeReflectionCheckpoint on every round when reflectionInterval is 1", async () => {
    let round = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      round++
      if (round < 2) {
        return {
          blocks: [{ type: "tool_use", id: `t${round}`, name: "NoSuchTool", input: {} }],
          text: "",
          stopReason: "tool_use",
        }
      }
      return textOk("done")
    }
    const runtime = createRuntime()
    const session = runtime.openSession({ auth: AUTH, model: "m", sendFn, reflectionInterval: 1 })

    const checkpoints: number[] = []
    await collect(
      session.run("go", {
        beforeReflectionCheckpoint: (r) => {
          checkpoints.push(r)
        },
      }),
    )

    expect(checkpoints.length).toBeGreaterThan(0)
    runtime.close()
  })
})

describe("Session.run — the result promise", () => {
  it("resolves with the same TurnResult AgentCore.run returns, on a plain completed turn", async () => {
    const runtime = createRuntime()
    const session = runtime.openSession({ auth: AUTH, model: "m", sendFn: staticTransport("ok") })

    const run = session.run("go")
    await collect(run)
    const result = await run.result
    expect(result.outcome).toBe("completed")
    expect(result.text).toBe("ok")
    runtime.close()
  })

  it("carries the real pausing error through for outcome waiting", async () => {
    const permanent = Object.assign(new Error("fatal upstream failure"), {
      errorClass: "permanent",
    })
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      throw permanent
    }
    const runtime = createRuntime()
    const session = runtime.openSession({ auth: AUTH, model: "m", sendFn })

    const run = session.run("go")
    await collect(run)
    const result = await run.result
    expect(result.outcome).toBe("waiting")
    expect(result.error).toBe(permanent)
    runtime.close()
  })

  it("never raises an unhandled rejection when a failing run's result is never read", async () => {
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      throw new Error("boom")
    }
    const runtime = createRuntime()
    const session = runtime.openSession({ auth: AUTH, model: "m", sendFn })

    // Only drain the iterable (which throws); never touch `.result`.
    await expect(collect(session.run("go"))).rejects.toThrow("boom")
    // Give any unhandled-rejection reporting a tick to fire before closing —
    // the test harness fails the run on one, so simply reaching here is
    // the assertion.
    await Promise.resolve()
    runtime.close()
  })
})

describe("Session — agentCore() escape hatch and lifecycle passthrough", () => {
  afterEach(() => {
    clearModelRegistry()
  })

  it("agentCore() exposes the real underlying engine (model switch + history + replaceMessages)", async () => {
    registerModel(fakeModel("m2"))
    const runtime = createRuntime()
    const session = runtime.openSession({ auth: AUTH, model: "m1", sendFn: staticTransport("ok") })

    const core = session.agentCore()
    expect(core.getModel()).toBe("m1")
    core.setModel("m2")
    expect(core.getModel()).toBe("m2")

    await collect(session.run("hi"))
    expect(core.history().length).toBeGreaterThan(0)

    core.replaceMessages([])
    expect(core.history()).toEqual([])
    runtime.close()
  })

  it("threads a caller-supplied lifecycle port into the engine's beforeSend gate", async () => {
    // `AgentCore` applies `lifecycle.beforeSend` generically, through
    // `wrapTransportWithLifecycle` around every send — unlike `beforeTool`,
    // which only fires inside `executeToolRound` (the CLI's own
    // `ToolExecutorAdapter`, not the bare runtime's default executor). This
    // is the cleanest way to prove `RuntimeCoreDeps.lifecycle` actually
    // reaches `AgentCoreConfig.lifecycle` without needing the CLI's tool
    // pipeline.
    const seen: string[] = []
    const lifecycle: LifecyclePort = {
      beforeSend: async (snapshot) => {
        seen.push(snapshot.model)
        return { action: "deny", reason: "policy test deny" }
      },
    }
    let sendCalls = 0
    const sendFn = async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
      sendCalls++
      return textOk("should never be reached")
    }
    const runtime = createRuntime()
    const session = runtime.openSession({ auth: AUTH, model: "m", sendFn, lifecycle })

    await expect(collect(session.run("go"))).rejects.toThrow("policy test deny")
    expect(seen).toEqual(["m"])
    expect(sendCalls).toBe(0)
    runtime.close()
  })
})
