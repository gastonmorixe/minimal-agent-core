import { describe, expect, it } from "bun:test"

import { createDiagnosticBus, Facility, type LogEvent, Severity } from "../bus/diagnostic-bus.ts"

import {
  createSinkGuard,
  reportSinkError,
  SINK_ERROR_CODE,
  type SinkFailure,
  sinkErrorMessage,
} from "./sink-guard.ts"

describe("createSinkGuard", () => {
  it("returns true and reports nothing when the listener returns", () => {
    const reports: SinkFailure[] = []
    const guard = createSinkGuard((f) => reports.push(f))
    let calls = 0
    expect(guard.call(() => calls++)).toBe(true)
    expect(calls).toBe(1)
    expect(guard.failures).toBe(0)
    expect(reports).toEqual([])
  })

  it("catches every throw, reports only the first, and counts all of them", () => {
    const reports: SinkFailure[] = []
    const guard = createSinkGuard((f) => reports.push(f))
    const boom = new Error("first")
    expect(
      guard.call(() => {
        throw boom
      }),
    ).toBe(false)
    expect(
      guard.call(() => {
        throw new Error("second")
      }),
    ).toBe(false)
    expect(guard.call(() => {})).toBe(true)
    expect(
      guard.call(() => {
        throw "third"
      }),
    ).toBe(false)
    expect(guard.failures).toBe(3)
    expect(reports).toHaveLength(1)
    expect(reports[0]?.error).toBe(boom)
    expect(reports[0]?.message).toBe("first")
  })

  it("swallows a throw from the reporter itself", () => {
    const guard = createSinkGuard(() => {
      throw new Error("reporter is broken")
    })
    expect(
      guard.call(() => {
        throw new Error("listener is broken")
      }),
    ).toBe(false)
    expect(guard.failures).toBe(1)
  })

  it("keeps guards independent of each other", () => {
    const a = createSinkGuard(() => {})
    const b = createSinkGuard(() => {})
    a.call(() => {
      throw new Error("x")
    })
    expect(a.failures).toBe(1)
    expect(b.failures).toBe(0)
  })
})

describe("sinkErrorMessage", () => {
  it("uses the Error message and folds line breaks", () => {
    expect(sinkErrorMessage(new Error("a\nb\r\nc"))).toBe("a b c")
    expect(sinkErrorMessage(42)).toBe("42")
  })
})

describe("reportSinkError", () => {
  it("emits one events.sink-error diagnostic on the given bus", () => {
    const bus = createDiagnosticBus()
    const seen: LogEvent[] = []
    bus.on("*", (e) => seen.push(e))
    reportSinkError("eventSink", { error: new Error("pipe closed"), message: "pipe closed" }, bus)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      severity: Severity.Error,
      facility: Facility.User,
      source: SINK_ERROR_CODE,
      structuredData: { listener: "eventSink", error: "pipe closed" },
    })
    expect(seen[0]?.message).toContain("pipe closed")
  })
})
