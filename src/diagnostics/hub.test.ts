/**
 * Tests for the diagnostics hub and its session scopes (S20).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  createDiagnosticBus,
  getDiagnosticBus,
  type LogEvent,
  resetDiagnosticBus,
  Severity,
} from "../bus/diagnostic-bus.ts"

import { createDiagnostics, createDiagnosticsHub, processDiagnostics } from "./hub.ts"

describe("createDiagnostics", () => {
  it("builds a severity method for each RFC 5424 level, with no session id", () => {
    const events: LogEvent[] = []
    const d = createDiagnostics({ emit: (e) => events.push(e) })
    expect(d.sessionId).toBeUndefined()
    d.emergency("a", "1")
    d.alert("a", "2")
    d.critical("a", "3")
    d.error("a", "4")
    d.warn("a", "5")
    d.notice("a", "6")
    d.info("a", "7")
    d.debug("a", "8")
    expect(events.map((e) => e.severity)).toEqual([
      Severity.Emergency,
      Severity.Alert,
      Severity.Critical,
      Severity.Error,
      Severity.Warning,
      Severity.Notice,
      Severity.Info,
      Severity.Debug,
    ])
    expect(events.every((e) => e.sessionId === undefined)).toBe(true)
    expect(events[0]).toMatchObject({ source: "a", message: "1" })
  })

  it("stamps sessionId on every event when constructed with one", () => {
    const events: LogEvent[] = []
    const d = createDiagnostics({ emit: (e) => events.push(e) }, { sessionId: "sess-1" })
    expect(d.sessionId).toBe("sess-1")
    d.warn("x", "y", { k: 1 })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ sessionId: "sess-1", source: "x", message: "y" })
    expect(events[0]?.structuredData).toEqual({ k: 1 })
  })

  it("never throws into the producer when the target throws", () => {
    const d = createDiagnostics({
      emit: () => {
        throw new Error("sink broken")
      },
    })
    expect(() => d.warn("a", "b")).not.toThrow()
  })

  it("uses the injected clock for ts", () => {
    const events: LogEvent[] = []
    const d = createDiagnostics({ emit: (e) => events.push(e) }, { now: () => 12345 })
    d.info("a", "b")
    expect(events[0]?.ts).toBe(12345)
  })
})

describe("createDiagnosticsHub", () => {
  it("the runtime handle carries no session id and fans out on hub.on", () => {
    const hub = createDiagnosticsHub({ bus: createDiagnosticBus() })
    const seen: LogEvent[] = []
    hub.on("*", (e) => seen.push(e))
    expect(hub.diagnostics.sessionId).toBeUndefined()
    hub.diagnostics.warn("startup", "booting")
    expect(seen).toHaveLength(1)
    expect(seen[0]?.sessionId).toBeUndefined()
  })

  it("a session scope stamps sessionId and reaches both scope.on and hub.on", () => {
    const hub = createDiagnosticsHub({ bus: createDiagnosticBus() })
    const scope = hub.session("sess-a")
    expect(scope.sessionId).toBe("sess-a")

    const onScope: LogEvent[] = []
    const onHub: LogEvent[] = []
    scope.on("*", (e) => onScope.push(e))
    hub.on("*", (e) => onHub.push(e))

    scope.error("api.retry", "retrying")
    expect(onScope).toHaveLength(1)
    expect(onScope[0]).toMatchObject({ sessionId: "sess-a", source: "api.retry" })
    expect(onHub).toHaveLength(1)
    expect(onHub[0]).toMatchObject({ sessionId: "sess-a" })
  })

  it("two sessions in one runtime: each diagnostic carries the right sessionId (S20 check)", () => {
    const hub = createDiagnosticsHub({ bus: createDiagnosticBus() })
    const a = hub.session("session-a")
    const b = hub.session("session-b")

    const seenByA: LogEvent[] = []
    const seenByB: LogEvent[] = []
    const seenByHub: LogEvent[] = []
    a.on("*", (e) => seenByA.push(e))
    b.on("*", (e) => seenByB.push(e))
    hub.on("*", (e) => seenByHub.push(e))

    a.warn("session-a.thing", "from a")
    b.warn("session-b.thing", "from b")
    a.info("session-a.thing2", "from a again")

    // Each session's own scope sees only its own diagnostics.
    expect(seenByA.map((e) => e.sessionId)).toEqual(["session-a", "session-a"])
    expect(seenByB.map((e) => e.sessionId)).toEqual(["session-b"])
    // The hub sees every diagnostic of the runtime, correctly attributed.
    expect(seenByHub.map((e) => e.sessionId)).toEqual(["session-a", "session-b", "session-a"])
  })

  it("rejects an empty session id", () => {
    const hub = createDiagnosticsHub({ bus: createDiagnosticBus() })
    expect(() => hub.session("")).toThrow(RangeError)
  })

  it("without an own bus, the hub fans out on the process bus (same sinks as the global diag helpers)", () => {
    resetDiagnosticBus()
    try {
      const hub = createDiagnosticsHub()
      const seenOnProcessBus: LogEvent[] = []
      const off = getDiagnosticBus().on("*", (e) => seenOnProcessBus.push(e))
      try {
        hub.diagnostics.notice("startup", "hello")
        const scope = hub.session("s1")
        scope.warn("x", "y")
      } finally {
        off()
      }
      expect(seenOnProcessBus.map((e) => e.source)).toEqual(["startup", "x"])
      expect(seenOnProcessBus[1]?.sessionId).toBe("s1")
    } finally {
      resetDiagnosticBus()
    }
  })
})

describe("processDiagnostics", () => {
  beforeEach(() => resetDiagnosticBus())
  afterEach(() => resetDiagnosticBus())

  it("is the global fallback: a component without an injected handle still reaches the process bus", () => {
    const seen: LogEvent[] = []
    const off = getDiagnosticBus().on("*", (e) => seen.push(e))
    try {
      processDiagnostics().error("some.engine.site", "not yet migrated")
    } finally {
      off()
    }
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ source: "some.engine.site" })
    expect(seen[0]?.sessionId).toBeUndefined()
  })
})
