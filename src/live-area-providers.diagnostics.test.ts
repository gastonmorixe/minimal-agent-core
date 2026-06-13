/**
 * `LiveAreaScheduler` — diagnosticBus integration + ctx.emit side-channel.
 * Split out of `live-area-providers.test.ts` (oxlint max-lines); shares
 * fixtures via `live-area-providers.fixtures.ts`.
 */

import { describe, expect, it } from "bun:test"

import { FakeClock, makeSink, makeSlot } from "./live-area-providers.fixtures.ts"
import { LiveAreaScheduler } from "./live-area-providers.ts"

// ---------------------------------------------------------------------------
// DiagnosticBus integration — added with the log subsystem refactor.
//
// When `deps.logger` is unset, scheduler emits go through
// `diagnosticBus` as structured `LogEvent`s. Tests inject a fresh
// `createDiagnosticBus()` so they don't see / pollute the singleton.
// ---------------------------------------------------------------------------

describe("LiveAreaScheduler — diagnosticBus integration", () => {
  it("emits live-area.timeout (Warning) with slot + timeout-ms structured data", async () => {
    const { createDiagnosticBus, Severity } = await import("./diagnostic-bus.ts")
    const bus = createDiagnosticBus()
    const events: Array<{
      severity: number
      source: string
      message: string
      structuredData?: Readonly<Record<string, string | number | boolean>>
    }> = []
    bus.on("*", (e) => events.push(e))

    let invokeCount = 0
    const slot = makeSlot({
      id: "deadlock-prone",
      refreshMs: 1_000,
      timeoutMs: 100,
      invoke: async () => {
        invokeCount++
        return await new Promise<string>(() => {
          // never resolves
        })
      },
    })
    const clock = new FakeClock()
    const sched = new LiveAreaScheduler([slot], makeSink(), {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      diagnosticBus: bus,
    })
    sched.start()
    await clock.tick(200)
    sched.stop()

    expect(invokeCount).toBe(1)
    const timeouts = events.filter((e) => e.source === "live-area.timeout")
    expect(timeouts).toHaveLength(1)
    expect(timeouts[0].severity).toBe(Severity.Warning)
    expect(timeouts[0].message).toContain("timed out after 100ms")
    expect(timeouts[0].structuredData).toEqual({
      slot: "fake-plugin/deadlock-prone",
      "timeout-ms": 100,
    })
  })

  it("emits live-area.handler-failed (Error) when the invoke rejects", async () => {
    const { createDiagnosticBus, Severity } = await import("./diagnostic-bus.ts")
    const bus = createDiagnosticBus()
    const events: Array<{
      severity: number
      source: string
      message: string
      structuredData?: Readonly<Record<string, string | number | boolean>>
    }> = []
    bus.on("*", (e) => events.push(e))

    const slot = makeSlot({
      id: "boom",
      refreshMs: 5_000,
      invoke: async () => {
        throw new Error("synthetic failure")
      },
    })
    const clock = new FakeClock()
    const sched = new LiveAreaScheduler([slot], makeSink(), {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      diagnosticBus: bus,
    })
    sched.start()
    await clock.tick(0)
    sched.stop()

    const failures = events.filter((e) => e.source === "live-area.handler-failed")
    expect(failures).toHaveLength(1)
    expect(failures[0].severity).toBe(Severity.Error)
    expect(failures[0].message).toContain("synthetic failure")
    expect(failures[0].structuredData).toEqual({
      slot: "fake-plugin/boom",
      error: "synthetic failure",
    })
  })

  it("emits Notice with recovery=true after a healthy tick following a failure", async () => {
    const { createDiagnosticBus, Severity } = await import("./diagnostic-bus.ts")
    type LocalEvent = {
      // Keep `severity` typed as the enum here so the comparison below
      // doesn't trip oxlint's `no-unsafe-enum-comparison` (the bus's
      // `LogEvent.severity` is already `Severity` ; widening to plain
      // `number` for the test fixture lost that information).
      severity: (typeof Severity)[keyof typeof Severity]
      source: string
      structuredData?: Readonly<Record<string, string | number | boolean>>
    }
    const bus = createDiagnosticBus()
    const events: LocalEvent[] = []
    bus.on("*", (e) => events.push(e as LocalEvent))

    let attempt = 0
    const slot = makeSlot({
      id: "flapper",
      refreshMs: 1_000,
      invoke: async () => {
        attempt++
        if (attempt === 1) throw new Error("first call fails")
        return "v"
      },
    })
    const clock = new FakeClock()
    const sched = new LiveAreaScheduler([slot], makeSink(), {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      diagnosticBus: bus,
    })
    sched.start()
    await clock.tick(0) // first tick: fails → error event
    await clock.tick(1_000) // heartbeat: succeeds → recovery notices
    sched.stop()

    const recoveries = events.filter(
      (e) => e.severity === Severity.Notice && e.structuredData?.recovery === "true",
    )
    // Two recovery notices fire on the same recovery event: one targeting
    // `live-area.timeout`, one targeting `live-area.handler-failed`. This
    // is intentional so the TUI surface can clear either matching slot.
    expect(recoveries).toHaveLength(2)
    const sources = recoveries.map((e) => e.source).sort()
    expect(sources).toEqual(["live-area.handler-failed", "live-area.timeout"])
  })

  it("does NOT emit recovery when no prior failure occurred", async () => {
    const { createDiagnosticBus } = await import("./diagnostic-bus.ts")
    const bus = createDiagnosticBus()
    const events: Array<{
      severity: number
      source: string
      structuredData?: Readonly<Record<string, string | number | boolean>>
    }> = []
    bus.on("*", (e) => events.push(e))

    const slot = makeSlot({
      id: "happy",
      refreshMs: 1_000,
      invoke: async () => "v",
    })
    const clock = new FakeClock()
    const sched = new LiveAreaScheduler([slot], makeSink(), {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      diagnosticBus: bus,
    })
    sched.start()
    await clock.tick(0)
    await clock.tick(1_000)
    sched.stop()

    expect(events.filter((e) => e.structuredData?.recovery === "true")).toHaveLength(0)
  })

  it("emits live-area.header-position (Notice) when a slot requests header position", async () => {
    const { createDiagnosticBus, Severity } = await import("./diagnostic-bus.ts")
    const bus = createDiagnosticBus()
    const events: Array<{
      severity: number
      source: string
      message: string
      structuredData?: Readonly<Record<string, string | number | boolean>>
    }> = []
    bus.on("*", (e) => events.push(e))

    const slot = makeSlot({
      id: "h",
      position: "header",
      refreshMs: 1_000,
      invoke: async () => "x",
    })
    const clock = new FakeClock()
    const sched = new LiveAreaScheduler([slot], makeSink(), {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      diagnosticBus: bus,
    })
    sched.start()
    await clock.tick(0)
    await clock.tick(1_000)
    sched.stop()

    const positionEvents = events.filter((e) => e.source === "live-area.header-position")
    // Fires exactly once across multiple ticks.
    expect(positionEvents).toHaveLength(1)
    expect(positionEvents[0].severity).toBe(Severity.Notice)
    expect(positionEvents[0].structuredData?.slot).toBe("fake-plugin/h")
  })

  it("legacyLogger takes precedence over diagnosticBus", async () => {
    const { createDiagnosticBus } = await import("./diagnostic-bus.ts")
    const bus = createDiagnosticBus()
    const busEvents: unknown[] = []
    bus.on("*", (e) => busEvents.push(e))
    const logs: string[] = []

    const slot = makeSlot({
      id: "boom",
      invoke: async () => {
        throw new Error("x")
      },
    })
    const clock = new FakeClock()
    const sched = new LiveAreaScheduler([slot], makeSink(), {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      diagnosticBus: bus,
      logger: (m) => logs.push(m),
    })
    sched.start()
    await clock.tick(0)
    sched.stop()

    // Legacy logger fired, bus did NOT.
    expect(logs.length).toBeGreaterThan(0)
    expect(busEvents).toHaveLength(0)
  })
})

describe("LiveAreaScheduler — ctx.emit side-channel (prompt.inject port)", () => {
  it("slot ctx.emit fans out onto the shared bus", async () => {
    const { EventBus } = await import("./plugins/event-bus.ts")
    const bus = new EventBus(() => {})
    const received: unknown[] = []
    bus.on("prompt.inject", (ctx) => {
      received.push(ctx.payload)
    })
    const slot = makeSlot({
      id: "heartbeat",
      refreshMs: 1_000,
      invoke: async (ctx) => {
        ctx.emit?.("prompt.inject", { text: `fire-${ctx.tick}` })
        return `tick ${ctx.tick}`
      },
    })
    const clock = new FakeClock()
    const sched = new LiveAreaScheduler([slot], makeSink(), {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      bus,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    await clock.tick(1_000)
    // Let the bus microtask fanout settle.
    await new Promise((r) => setTimeout(r, 10))
    sched.stop()

    expect(received).toEqual([{ text: "fire-0" }, { text: "fire-1" }])
  })

  it("ctx.emit is a no-op (never throws) when no bus is wired", async () => {
    let threw = false
    const slot = makeSlot({
      id: "heartbeat",
      invoke: async (ctx) => {
        try {
          ctx.emit?.("prompt.inject", { text: "x" })
        } catch {
          threw = true
        }
        return "ok"
      },
    })
    const clock = new FakeClock()
    const sched = new LiveAreaScheduler([slot], makeSink(), {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
      // no bus
    })
    sched.start()
    await clock.tick(0)
    sched.stop()
    expect(threw).toBe(false)
  })
})
