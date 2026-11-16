/**
 * N1: a model-queued compact request that fails never fails the turn. The
 * real drain runs (no `agent.compact` mock): history stays unchanged and one
 * `compact.pending_failed` warning carries `{mode, errorKind}`.
 *
 * N5: `AgentCore.compact` forwards `signal`, so an abort stops a local
 * summary that retries a persistent rate limit.
 *
 * @module sdk/drain-pending-compact.test
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import { type LogEvent, Severity } from "../bus/diagnostic-bus.ts"
import { createDiagnostics } from "../diagnostics/hub.ts"
import type { Message } from "../llm/messages.ts"
import { clearModelRegistry, clearProviderRegistry } from "../llm/model-registry.ts"
import { clearProviderPlugins } from "../llm/provider-plugin.ts"
import { registerTestProvider } from "../llm/test-fixtures.ts"
import type { StreamedResponse, TransportFn } from "../llm/transport/types.ts"
import { NetworkClient, type NetworkTransport } from "../network/index.ts"
import { COMPACT_TEST_TEXT } from "../test-utils/compact-test-text.ts"

import { AgentCore, type TurnResult } from "./agent-core.ts"
import { compactErrorKind } from "./drain-pending-compact.ts"
import type { PendingCompact } from "./host-ports.ts"
import { denyDecision, type LifecyclePort, NOOP_LIFECYCLE } from "./lifecycle.ts"

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

function core(
  pending: PendingCompact,
  lifecycle: LifecyclePort = NOOP_LIFECYCLE,
  text: typeof COMPACT_TEST_TEXT | null = COMPACT_TEST_TEXT,
) {
  const warnings: LogEvent[] = []
  const diagnostics = createDiagnostics({
    emit: (e) => {
      if (e.source === "compact.pending_failed") warnings.push(e)
    },
  })
  let queued: PendingCompact | null = pending
  const seen: Message[][] = []
  const sendFn: TransportFn = async function* (opts) {
    seen.push(opts.messages.slice() as Message[])
    yield "done"
    return ok
  }
  const agent = new AgentCore({
    ...(text ? { syntheticTextResolver: text } : {}),
    auth: AUTH,
    model: "test-model-1",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: { execute: async () => ({ content: "", isError: false }) },
    eventSink: { emit: () => {} },
    sendFn,
    diagnostics,
    lifecycle,
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
  return { agent, warnings, seen }
}

async function drain(gen: AsyncGenerator<string, TurnResult, undefined>): Promise<TurnResult> {
  while (true) {
    const step = await gen.next()
    if (step.done) return step.value
  }
}

describe("drainPendingCompact (N1): a failed queued compact never fails the turn", () => {
  it("a queued {mode: fork} ends the turn completed with one warning", async () => {
    const { agent, warnings, seen } = core({ reason: "manual", mode: "fork" })
    const before = agent.messages.slice()
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.severity).toBe(Severity.Warning)
    expect(warnings[0]?.structuredData).toEqual({ mode: "fork", errorKind: "Error" })
    // The send saw the full prior history: the fork stub changed nothing.
    expect(seen[0]?.slice(0, before.length)).toEqual(before)
    expect(agent.messages.slice(0, before.length)).toEqual(before)
  })

  it("a compact.willRun deny ends the turn completed with one warning", async () => {
    const lifecycle: LifecyclePort = {
      ...NOOP_LIFECYCLE,
      beforeCompact: async () => denyDecision("no compaction now"),
    }
    const { agent, warnings, seen } = core({ reason: "manual", mode: "tail" }, lifecycle)
    const before = agent.messages.slice()
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.structuredData).toEqual({ mode: "tail", errorKind: "Error" })
    expect(seen[0]?.slice(0, before.length)).toEqual(before)
    expect(agent.messages.slice(0, before.length)).toEqual(before)
  })

  it("a queued {mode: local} with no compaction text (bare core) ends the turn completed (Q2)", async () => {
    const { agent, warnings, seen } = core(
      { reason: "manual", mode: "local" },
      NOOP_LIFECYCLE,
      null,
    )
    const before = agent.messages.slice()
    const result = await drain(agent.run("go"))
    expect(result.outcome).toBe("completed")
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.structuredData).toEqual({
      mode: "local",
      errorKind: "CompactNoProviderError",
    })
    expect(seen[0]?.slice(0, before.length)).toEqual(before)
    expect(agent.messages.slice(0, before.length)).toEqual(before)
  })

  it("errorKind is the CoreError kind, else the Error name", () => {
    expect(compactErrorKind(Object.assign(new Error("x"), { kind: "SomeCoreError" }))).toBe(
      "SomeCoreError",
    )
    expect(compactErrorKind(new RangeError("x"))).toBe("RangeError")
    expect(compactErrorKind("boom")).toBe("string")
  })
})

describe("AgentCore.compact (N5): signal stops a retrying local summary", () => {
  beforeEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
  })
  afterEach(() => {
    clearModelRegistry()
    clearProviderRegistry()
    clearProviderPlugins()
  })

  it("an abort ends a rate-limited /compact local summary", async () => {
    registerTestProvider({
      id: "n5-prov",
      displayName: "N5 Prov",
      shortCode: "n5p",
      models: [{ id: "n5-model" }],
    })
    const controller = new AbortController()
    let calls = 0
    // Always a retryable rate limit. Abort during the second attempt.
    const transport: NetworkTransport = {
      id: "fake",
      request: async () => {
        calls += 1
        if (calls === 2) controller.abort()
        const err = new Error(
          `provider API 429: ${JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "Error" },
          })}`,
        ) as Error & { streamErrorType?: string }
        err.streamErrorType = "rate_limit_error"
        throw err
      },
    }
    const agent = new AgentCore({
      syntheticTextResolver: COMPACT_TEST_TEXT,
      auth: AUTH,
      model: "n5-model",
      providerId: "n5-prov",
      systemPrompt: "",
      maxTokens: 4096,
      toolRegistry: { list: () => [] },
      toolExecutor: { execute: async () => ({ content: "", isError: false }) },
      eventSink: { emit: () => {} },
      networkClient: new NetworkClient({ primary: transport }),
    })
    for (const m of history()) agent.messages.push(m)
    const before = agent.messages.slice()
    // First retry backoff is real (abortable): abort it early from outside too.
    const timer = setTimeout(() => controller.abort(), 200)
    try {
      await expect(
        agent.compact({ reason: "manual", mode: "local", signal: controller.signal }),
      ).rejects.toThrow()
    } finally {
      clearTimeout(timer)
    }
    expect(controller.signal.aborted).toBe(true)
    expect(calls).toBeLessThanOrEqual(2)
    // A cancelled compaction leaves history unchanged (no stub checkpoint).
    expect(agent.messages).toEqual(before)
  }, 5000)
})
