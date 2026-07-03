/**
 * Unit tests for `StderrMirrorSink`.
 *
 * The sink mirrors every diagnostic event to a stderr-shaped writer in
 * a compact `[LEVEL] source: message [k=v ...]` form. It's opt-in and
 * intended for development — when enabled via `MINIMAL_AGENT_LOG_STDERR=1`,
 * the wiring layer in src/index.ts must inject a write fn that bypasses
 * the compositor (`interceptor.rawStderrWrite`).
 */

import { describe, expect, it } from "bun:test"

import { createDiagnosticBus, Facility, type LogEvent, Severity } from "./bus/diagnostic-bus.ts"
import { StderrMirrorSink } from "./log-stderr.ts"

function event(over: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: Date.UTC(2026, 4, 20, 11, 14, 37, 412),
    severity: Severity.Warning,
    facility: Facility.User,
    source: "test.src",
    message: "hello",
    ...over,
  }
}

describe("StderrMirrorSink — write format", () => {
  it("writes `[LEVEL] source: message\\n` for events without structured data", () => {
    const written: string[] = []
    const bus = createDiagnosticBus()
    const sink = new StderrMirrorSink({ write: (s) => written.push(s) })
    sink.attach(bus)
    bus.emit(event())
    expect(written).toEqual(["[WARN] test.src: hello\n"])
  })

  it("appends structured-data k=v pairs after the message", () => {
    const written: string[] = []
    const bus = createDiagnosticBus()
    const sink = new StderrMirrorSink({ write: (s) => written.push(s) })
    sink.attach(bus)
    bus.emit(
      event({
        message: "timeout",
        structuredData: { slot: "quota", "timeout-ms": 8000 },
      }),
    )
    expect(written[0]).toBe('[WARN] test.src: timeout slot="quota" timeout-ms="8000"\n')
  })

  it("uses correct level tags per severity", () => {
    const written: string[] = []
    const bus = createDiagnosticBus()
    const sink = new StderrMirrorSink({ write: (s) => written.push(s) })
    sink.attach(bus)
    for (const [sev, tag] of [
      [Severity.Emergency, "EMERG"],
      [Severity.Alert, "ALERT"],
      [Severity.Critical, "CRIT"],
      [Severity.Error, "ERROR"],
      [Severity.Warning, "WARN"],
      [Severity.Notice, "NOTICE"],
      [Severity.Info, "INFO"],
      [Severity.Debug, "DEBUG"],
    ] as const) {
      bus.emit(event({ severity: sev }))
      expect(written[written.length - 1]).toStartWith(`[${tag}]`)
    }
  })
})

describe("StderrMirrorSink — level filter", () => {
  it("default level=Debug logs everything", () => {
    const written: string[] = []
    const bus = createDiagnosticBus()
    const sink = new StderrMirrorSink({ write: (s) => written.push(s) })
    sink.attach(bus)
    for (const sev of [
      Severity.Emergency,
      Severity.Error,
      Severity.Warning,
      Severity.Info,
      Severity.Debug,
    ]) {
      bus.emit(event({ severity: sev }))
    }
    expect(written).toHaveLength(5)
  })

  it("level=Warning skips Notice/Info/Debug", () => {
    const written: string[] = []
    const bus = createDiagnosticBus()
    const sink = new StderrMirrorSink({
      write: (s) => written.push(s),
      level: Severity.Warning,
    })
    sink.attach(bus)
    bus.emit(event({ severity: Severity.Error }))
    bus.emit(event({ severity: Severity.Warning }))
    bus.emit(event({ severity: Severity.Notice }))
    bus.emit(event({ severity: Severity.Info }))
    bus.emit(event({ severity: Severity.Debug }))
    expect(written).toHaveLength(2)
  })
})

describe("StderrMirrorSink — attach/detach", () => {
  it("attach is idempotent", () => {
    const written: string[] = []
    const bus = createDiagnosticBus()
    const sink = new StderrMirrorSink({ write: (s) => written.push(s) })
    sink.attach(bus)
    sink.attach(bus)
    bus.emit(event())
    expect(written).toHaveLength(1)
  })

  it("detach removes the subscription", () => {
    const written: string[] = []
    const bus = createDiagnosticBus()
    const sink = new StderrMirrorSink({ write: (s) => written.push(s) })
    sink.attach(bus)
    bus.emit(event({ message: "before" }))
    sink.detach()
    bus.emit(event({ message: "after" }))
    expect(written).toHaveLength(1)
  })

  it("write errors are swallowed and do not propagate", () => {
    const bus = createDiagnosticBus()
    const sink = new StderrMirrorSink({
      write: () => {
        throw new Error("write boom")
      },
    })
    sink.attach(bus)
    expect(() => bus.emit(event())).not.toThrow()
  })
})

describe("StderrMirrorSink — default writer", () => {
  it("default writer is process.stderr.write (smoke; no assertion on actual stderr)", () => {
    // We can't easily intercept process.stderr in a test, but we can
    // verify the sink can be constructed without args and doesn't crash.
    const sink = new StderrMirrorSink()
    const bus = createDiagnosticBus()
    sink.attach(bus)
    // Manually re-route bus to a noop so we don't actually write to stderr.
    sink.detach()
    expect(true).toBe(true)
  })
})
