/**
 * Tests for the session diagnostics → event-log bridge (S21), against a
 * real {@link SessionEventLog} instance.
 */

import { describe, expect, it } from "bun:test"

import { Severity } from "../bus/diagnostic-bus.ts"
import { SessionEventLog } from "../session/event-log.ts"

import { bridgeDiagnosticsToEventLog } from "./event-log-bridge.ts"
import { createDiagnosticsHub } from "./hub.ts"

describe("bridgeDiagnosticsToEventLog", () => {
  it("appends a session's diagnostics to its SessionEventLog as ch: diag entries", () => {
    const hub = createDiagnosticsHub()
    const scope = hub.session("sess-1")
    const log = new SessionEventLog({ sessionId: "sess-1" })

    const stop = bridgeDiagnosticsToEventLog(scope, log)
    try {
      scope.warn("api.retry", "retrying", { attempt: 2 })
      scope.error("auth.refresh", "token stale")
    } finally {
      stop()
    }

    const collected: unknown[] = []
    log.subscribe((e) => collected.push(e), { fromSeq: 0 })
    expect(collected).toHaveLength(2)
    expect(collected[0]).toMatchObject({
      ch: "diag",
      sessionId: "sess-1",
      data: { severity: Severity.Warning, code: "api.retry", message: "retrying" },
    })
    expect(collected[1]).toMatchObject({
      ch: "diag",
      sessionId: "sess-1",
      data: { severity: Severity.Error, code: "auth.refresh" },
    })
  })

  it("stops delivering after the returned function runs", () => {
    const hub = createDiagnosticsHub()
    const scope = hub.session("sess-2")
    const log = new SessionEventLog({ sessionId: "sess-2" })
    const stop = bridgeDiagnosticsToEventLog(scope, log)

    scope.notice("a", "before stop")
    stop()
    scope.notice("b", "after stop")

    expect(log.stats().nextSeq).toBe(1)
  })

  it("filters by minSeverity (RFC 5424: lower number is more severe)", () => {
    const hub = createDiagnosticsHub()
    const scope = hub.session("sess-3")
    const log = new SessionEventLog({ sessionId: "sess-3" })
    bridgeDiagnosticsToEventLog(scope, log, { minSeverity: Severity.Warning })

    scope.info("a", "info is less severe than warning, dropped")
    scope.warn("b", "warning passes")
    scope.error("c", "error passes")

    const collected: unknown[] = []
    log.subscribe((e) => collected.push(e), { fromSeq: 0 })
    expect(collected).toHaveLength(2)
    expect(collected.map((e) => (e as { data: { code: string } }).data.code)).toEqual(["b", "c"])
  })

  it("throws when the scope and the log belong to different sessions", () => {
    const hub = createDiagnosticsHub()
    const scope = hub.session("sess-x")
    const log = new SessionEventLog({ sessionId: "sess-y" })
    expect(() => bridgeDiagnosticsToEventLog(scope, log)).toThrow(RangeError)
  })

  it("a bridged diagnostic and a normal event share one seq order on the same log", () => {
    const hub = createDiagnosticsHub()
    const scope = hub.session("sess-4")
    const log = new SessionEventLog({ sessionId: "sess-4" })
    bridgeDiagnosticsToEventLog(scope, log)

    log.appendEvent({ type: "turn_started", turn: 1 })
    scope.warn("x", "y")
    log.appendEvent({
      type: "turn_completed",
      turn: 1,
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0 },
    })

    const collected: unknown[] = []
    log.subscribe((e) => collected.push(e), { fromSeq: 0 })
    expect(collected.map((e) => (e as { ch: string; seq: number }).ch)).toEqual([
      "event",
      "diag",
      "event",
    ])
    expect(collected.map((e) => (e as { seq: number }).seq)).toEqual([0, 1, 2])
  })
})
