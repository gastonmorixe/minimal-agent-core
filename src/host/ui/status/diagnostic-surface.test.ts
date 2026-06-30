/**
 * Unit tests for `TuiDiagnosticSurface`.
 *
 * The surface keeps two rolling slots — "last warning" and "last error
 * (or more severe)" — with a dedup counter for each. It pushes 0-2
 * styled lines into a `DiagnosticLinesSink`.
 *
 * State model:
 *   - Warning event:
 *       - Same (severity, source, message) as `lastWarn` → ++warnCount.
 *       - Else → replace lastWarn, count=1.
 *   - Error (or more severe) event:
 *       - Same tuple as lastErr → ++errCount.
 *       - Else → replace lastErr, count=1.
 *   - Notice with `recovery="true"` from same source → clear matching slot(s).
 *   - Info / Debug → ignored (file sink covers those).
 *
 * Render:
 *   - 0 lines when both slots empty.
 *   - 1 line when only one slot is filled.
 *   - 2 lines when both filled. Order: [warn, error].
 *   - Count suffix `(×N)` only when N is above 1.
 *
 * The surface is decoupled from the bus subscription wiring; tests
 * inject events directly via `surface.onEvent(e)` to keep the trail
 * deterministic.
 */

import { describe, expect, it } from "bun:test"

import { createDiagnosticBus, Facility, type LogEvent, Severity } from "../../../diagnostic-bus.ts"

import { type DiagnosticLinesSink, TuiDiagnosticSurface } from "./diagnostic-surface.ts"

function event(over: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: Date.UTC(2026, 4, 20, 11, 14, 37, 412),
    severity: Severity.Warning,
    facility: Facility.User,
    source: "live-area.timeout",
    message: "invoke did not resolve in time",
    ...over,
  }
}

function makeSink(): DiagnosticLinesSink & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    setDiagnosticLines(lines: string[]) {
      calls.push([...lines])
    },
  }
}

function strip(s: string): string {
  // Strip ANSI for content assertions; rendering tests assert ANSI separately.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: explicit ANSI strip
  return s.replace(/\x1b\[[\d;]*m/g, "")
}

describe("TuiDiagnosticSurface — empty state", () => {
  it("renders nothing when no events have been seen", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    expect(sink.calls).toEqual([[]]) // empty lines pushed on bind
  })

  it("snapshot() reports empty slots", () => {
    const surface = new TuiDiagnosticSurface()
    const snap = surface.snapshot()
    expect(snap.warn.event).toBeNull()
    expect(snap.warn.count).toBe(0)
    expect(snap.error.event).toBeNull()
    expect(snap.error.count).toBe(0)
  })
})

describe("TuiDiagnosticSurface — single warning", () => {
  it("renders one line with no count suffix on first occurrence", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    surface.onEvent(event())
    const last = sink.calls[sink.calls.length - 1]
    expect(last).toHaveLength(1)
    const text = strip(last[0])
    expect(text).toContain("live-area.timeout")
    expect(text).toContain("invoke did not resolve in time")
    expect(text).not.toContain("×") // no count suffix on first
  })

  it("ANSI: includes a gold (\\x1b[38;5;214m) icon for warnings", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    surface.onEvent(event())
    const last = sink.calls[sink.calls.length - 1]
    expect(last[0]).toContain("\x1b[38;5;214m") // gold open
  })
})

describe("TuiDiagnosticSurface — dedup", () => {
  it("identical consecutive warnings increment count, do not stack", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    for (let i = 0; i < 5; i++) surface.onEvent(event())
    const last = sink.calls[sink.calls.length - 1]
    expect(last).toHaveLength(1)
    expect(strip(last[0])).toContain("×5")
  })

  it("different (source, message) tuple replaces the slot, count resets", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    surface.onEvent(event({ source: "a", message: "msg-a" }))
    surface.onEvent(event({ source: "a", message: "msg-a" }))
    surface.onEvent(event({ source: "b", message: "msg-b" }))
    const last = sink.calls[sink.calls.length - 1]
    expect(strip(last[0])).toContain("b")
    expect(strip(last[0])).toContain("msg-b")
    expect(strip(last[0])).not.toContain("×") // count reset
  })

  it("same source different message also resets", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    surface.onEvent(event({ source: "x", message: "1" }))
    surface.onEvent(event({ source: "x", message: "1" }))
    surface.onEvent(event({ source: "x", message: "2" }))
    const last = sink.calls[sink.calls.length - 1]
    expect(strip(last[0])).toContain("2")
    expect(strip(last[0])).not.toContain("×")
  })
})

describe("TuiDiagnosticSurface — warn + error slots are independent", () => {
  it("error event goes to error slot, warning to warn slot", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    surface.onEvent(event({ severity: Severity.Warning, message: "WARN-MSG" }))
    surface.onEvent(event({ severity: Severity.Error, message: "ERR-MSG" }))
    const last = sink.calls[sink.calls.length - 1]
    expect(last).toHaveLength(2)
    expect(strip(last[0])).toContain("WARN-MSG")
    expect(strip(last[1])).toContain("ERR-MSG")
  })

  it("Critical / Alert / Emergency all go to the error slot", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    for (const sev of [Severity.Critical, Severity.Alert, Severity.Emergency]) {
      surface.onEvent(event({ severity: sev, source: "s", message: `m-${sev}` }))
    }
    const snap = surface.snapshot()
    expect(snap.error.event?.message).toBe("m-0") // last was Emergency=0
  })

  it("dedup is per-slot: same tuple as warn doesn't dedup against error", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    surface.onEvent(event({ severity: Severity.Warning, message: "M" }))
    surface.onEvent(event({ severity: Severity.Warning, message: "M" }))
    surface.onEvent(event({ severity: Severity.Error, message: "M" }))
    const snap = surface.snapshot()
    expect(snap.warn.count).toBe(2)
    expect(snap.error.count).toBe(1)
  })
})

describe("TuiDiagnosticSurface — Info/Notice/Debug are ignored (no slot)", () => {
  it("Info events do not populate any slot", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    surface.onEvent(event({ severity: Severity.Info, message: "should be ignored" }))
    const snap = surface.snapshot()
    expect(snap.warn.event).toBeNull()
    expect(snap.error.event).toBeNull()
  })

  it("Debug events do not populate any slot", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    surface.onEvent(event({ severity: Severity.Debug, message: "should be ignored" }))
    expect(surface.snapshot().warn.event).toBeNull()
  })

  it("Notice without recovery flag is ignored (does not populate any slot)", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    surface.onEvent(event({ severity: Severity.Notice, message: "non-recovery notice" }))
    expect(surface.snapshot().warn.event).toBeNull()
    expect(surface.snapshot().error.event).toBeNull()
  })
})

describe("TuiDiagnosticSurface — recovery via Notice + recovery=true", () => {
  it("clears the warn slot for matching source", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    surface.onEvent(event({ source: "auth.refresh", message: "401 retry" }))
    expect(surface.snapshot().warn.event?.source).toBe("auth.refresh")
    surface.onEvent(
      event({
        severity: Severity.Notice,
        source: "auth.refresh",
        message: "ok",
        structuredData: { recovery: "true" },
      }),
    )
    expect(surface.snapshot().warn.event).toBeNull()
    expect(surface.snapshot().warn.count).toBe(0)
  })

  it("clears the error slot for matching source", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    surface.onEvent(event({ severity: Severity.Error, source: "x", message: "boom" }))
    surface.onEvent(
      event({
        severity: Severity.Notice,
        source: "x",
        message: "recovered",
        structuredData: { recovery: "true" },
      }),
    )
    expect(surface.snapshot().error.event).toBeNull()
  })

  it("recovery for one source does NOT clear a different source's slot", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    surface.onEvent(event({ source: "a", message: "msg-a" }))
    surface.onEvent(event({ source: "b", message: "msg-b", severity: Severity.Error }))
    surface.onEvent(
      event({
        severity: Severity.Notice,
        source: "a",
        structuredData: { recovery: "true" },
      }),
    )
    expect(surface.snapshot().warn.event).toBeNull()
    expect(surface.snapshot().error.event?.source).toBe("b")
  })

  it("Notice without structuredData.recovery is ignored", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    surface.onEvent(event({ source: "a", message: "msg-a" }))
    surface.onEvent(
      event({
        severity: Severity.Notice,
        source: "a",
        // No recovery flag
      }),
    )
    expect(surface.snapshot().warn.event?.source).toBe("a")
  })
})

describe("TuiDiagnosticSurface — clear()", () => {
  it("clears both slots and counts", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    surface.onEvent(event({ severity: Severity.Warning, message: "w" }))
    surface.onEvent(event({ severity: Severity.Warning, message: "w" }))
    surface.onEvent(event({ severity: Severity.Error, message: "e" }))
    surface.clear()
    const snap = surface.snapshot()
    expect(snap.warn.event).toBeNull()
    expect(snap.warn.count).toBe(0)
    expect(snap.error.event).toBeNull()
    expect(snap.error.count).toBe(0)
    const last = sink.calls[sink.calls.length - 1]
    expect(last).toEqual([])
  })
})

describe("TuiDiagnosticSurface — sink rebinding", () => {
  it("repaints on bind (idempotent for the same state)", () => {
    const surface = new TuiDiagnosticSurface()
    surface.onEvent(event({ message: "queued before bind" }))
    const sink = makeSink()
    surface.bindSink(sink)
    expect(sink.calls).toHaveLength(1)
    expect(sink.calls[0]).toHaveLength(1)
    expect(strip(sink.calls[0][0])).toContain("queued before bind")
  })

  it("changing sink mid-life keeps state intact", () => {
    const surface = new TuiDiagnosticSurface()
    const sinkA = makeSink()
    const sinkB = makeSink()
    surface.bindSink(sinkA)
    surface.onEvent(event({ message: "a" }))
    surface.bindSink(sinkB)
    // Sink B should have received the current state on bind.
    const last = sinkB.calls[sinkB.calls.length - 1]
    expect(strip(last[0])).toContain("a")
  })
})

describe("TuiDiagnosticSurface — bus integration", () => {
  it("attach() subscribes to '*'; events flow through", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    const bus = createDiagnosticBus()
    surface.attach(bus)
    bus.emit(event({ message: "via-bus" }))
    const last = sink.calls[sink.calls.length - 1]
    expect(strip(last[0])).toContain("via-bus")
  })

  it("detach() removes the subscription", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    const bus = createDiagnosticBus()
    surface.attach(bus)
    surface.detach()
    bus.emit(event({ message: "should not appear" }))
    expect(surface.snapshot().warn.event).toBeNull()
  })

  it("attach() is idempotent", () => {
    const surface = new TuiDiagnosticSurface()
    const sink = makeSink()
    surface.bindSink(sink)
    const bus = createDiagnosticBus()
    surface.attach(bus)
    surface.attach(bus)
    bus.emit(event())
    // Single event → single tally (would be 2 if double-attached).
    expect(surface.snapshot().warn.count).toBe(1)
  })
})
