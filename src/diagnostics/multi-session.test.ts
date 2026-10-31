/**
 * S20 check: two sessions (two `AgentCore`s with their own scopes) run in
 * one runtime, and each diagnostic carries the right `sessionId`.
 *
 * Drives a real retry through `AgentCore.run` for each session (a transient
 * error, then success), so the diagnostic is the one the transport layer
 * emits via the injected handle — the same path `withRetry` / `run-recovery`
 * use in production — not a diagnostic raised directly by the test.
 */

import { describe, expect, it } from "bun:test"

import type { AuthResult } from "../auth/auth.ts"
import { type LogEvent, Severity } from "../bus/diagnostic-bus.ts"
import type { StreamedResponse } from "../llm/transport/types.ts"
import { AgentCore } from "../sdk/agent-core.ts"
import type { AgentCoreConfig, ToolExecResult, ToolExecutor } from "../sdk/ports.ts"

import { createDiagnosticsHub } from "./hub.ts"

const AUTH: AuthResult = { type: "api-key", token: "test-token" }

class StubExecutor implements ToolExecutor {
  async execute(): Promise<ToolExecResult> {
    return { content: "ok", isError: false }
  }
}

/** A transport that throws one `transient` error, then succeeds, with a zero-delay clock. */
function flakySendFn(): AgentCoreConfig["sendFn"] {
  let attempts = 0
  return async function* (): AsyncGenerator<string, StreamedResponse, undefined> {
    attempts++
    if (attempts === 1) {
      throw Object.assign(new Error("upstream overloaded"), { errorClass: "transient" })
    }
    yield "done"
    return { blocks: [{ type: "text", text: "done" }], text: "done", stopReason: "end_turn" }
  }
}

function coreForSession(sessionId: string, diagnostics: AgentCoreConfig["diagnostics"]): AgentCore {
  return new AgentCore({
    auth: AUTH,
    model: "test-model",
    systemPrompt: "",
    maxTokens: 4096,
    toolRegistry: { list: () => [] },
    toolExecutor: new StubExecutor(),
    transcriptSink: { write: () => {} },
    sendFn: flakySendFn(),
    diagnostics,
    retry: { clock: { now: () => 0, sleep: async () => {} } },
  })
}

async function drain(gen: AsyncGenerator<string, StreamedResponse, undefined>): Promise<void> {
  while (!(await gen.next()).done) {
    // Drain text deltas; the result is read from the returned value.
  }
}

describe("S20: two sessions in one runtime, each diagnostic carries the right sessionId", () => {
  it("attributes transport retry diagnostics to the correct session", async () => {
    const hub = createDiagnosticsHub()
    const sessionA = hub.session("session-a")
    const sessionB = hub.session("session-b")

    const seenByHub: LogEvent[] = []
    const seenByA: LogEvent[] = []
    const seenByB: LogEvent[] = []
    hub.on("*", (e) => seenByHub.push(e))
    sessionA.on("*", (e) => seenByA.push(e))
    sessionB.on("*", (e) => seenByB.push(e))

    const coreA = coreForSession("session-a", sessionA)
    const coreB = coreForSession("session-b", sessionB)

    // Interleave the two runs so neither core's state can leak into the
    // other's: this is the "two AgentCores with their own scopes" check.
    await Promise.all([drain(coreA.run("hello from a")), drain(coreB.run("hello from b"))])

    // Both sessions hit exactly one transient retry: the pre-retry `warn`
    // (one wait) and the post-recovery `notice` (`noteRetryRecovered`),
    // each correctly attributed.
    const retryEventsA = seenByA.filter((e) => e.source === "api.retry")
    const retryEventsB = seenByB.filter((e) => e.source === "api.retry")
    expect(retryEventsA.map((e) => e.severity)).toEqual([Severity.Warning, Severity.Notice])
    expect(retryEventsB.map((e) => e.severity)).toEqual([Severity.Warning, Severity.Notice])
    expect(retryEventsA.every((e) => e.sessionId === "session-a")).toBe(true)
    expect(retryEventsB.every((e) => e.sessionId === "session-b")).toBe(true)

    // Session A's scope never saw session B's diagnostic, and vice versa.
    expect(seenByA.every((e) => e.sessionId === "session-a")).toBe(true)
    expect(seenByB.every((e) => e.sessionId === "session-b")).toBe(true)

    // The hub-level view sees every retry diagnostic of the runtime, each
    // still carrying its own session id.
    const hubRetryEvents = seenByHub.filter((e) => e.source === "api.retry")
    expect(hubRetryEvents).toHaveLength(4)
    expect(hubRetryEvents.filter((e) => e.sessionId === "session-a")).toHaveLength(2)
    expect(hubRetryEvents.filter((e) => e.sessionId === "session-b")).toHaveLength(2)
  })
})
