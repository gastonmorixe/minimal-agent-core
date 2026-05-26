/**
 * Unit tests for the singleton diagnostic bus.
 *
 * The bus is the fan-out hub for in-process log events. Producers call
 * `diag.warn/error/info/...` (or `bus.emit(LogEvent)` directly); sinks
 * subscribe via `bus.on(filter, handler)` and route events to a file,
 * the TUI surface, opt-in stderr, etc.
 *
 * Test contract:
 *   - Stateless: bus stores nothing; just multicasts.
 *   - Sync emit: handlers fire in registration order, on the calling
 *     stack. Errors in handlers DO NOT propagate to the producer.
 *   - Filter shapes: `"*"`, exact `Severity`, or `(event) => boolean`.
 *   - `on()` returns a dispose function; calling it twice is idempotent.
 *   - `diag.*` helpers stamp the event with the right severity/facility
 *     and current epoch ms; everything else is pass-through.
 *   - Singleton is process-wide via `getDiagnosticBus()`; tests can
 *     construct isolated buses via `createDiagnosticBus()`.
 *   - `resetDiagnosticBus()` clears the singleton (test-only utility).
 */

import { beforeEach, describe, expect, it } from "bun:test"

import {
  createDiagnosticBus,
  diag,
  Facility,
  getDiagnosticBus,
  type LogEvent,
  resetDiagnosticBus,
  Severity,
} from "./diagnostic-bus.ts"

function event(over: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: 1_700_000_000_000,
    severity: Severity.Warning,
    facility: Facility.User,
    source: "test.source",
    message: "test message",
    ...over,
  }
}

describe("DiagnosticBus — emit/on", () => {
  it("delivers events to a subscriber that matches '*'", () => {
    const bus = createDiagnosticBus()
    const seen: LogEvent[] = []
    bus.on("*", (e) => seen.push(e))
    const e = event()
    bus.emit(e)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(e)
  })

  it("delivers events to multiple subscribers in registration order", () => {
    const bus = createDiagnosticBus()
    const order: string[] = []
    bus.on("*", () => order.push("a"))
    bus.on("*", () => order.push("b"))
    bus.on("*", () => order.push("c"))
    bus.emit(event())
    expect(order).toEqual(["a", "b", "c"])
  })

  it("filters by exact severity", () => {
    const bus = createDiagnosticBus()
    const warns: LogEvent[] = []
    const errs: LogEvent[] = []
    bus.on(Severity.Warning, (e) => warns.push(e))
    bus.on(Severity.Error, (e) => errs.push(e))
    bus.emit(event({ severity: Severity.Warning, message: "w" }))
    bus.emit(event({ severity: Severity.Error, message: "e" }))
    bus.emit(event({ severity: Severity.Info, message: "i" }))
    expect(warns.map((w) => w.message)).toEqual(["w"])
    expect(errs.map((e) => e.message)).toEqual(["e"])
  })

  it("filters by predicate", () => {
    const bus = createDiagnosticBus()
    const caught: LogEvent[] = []
    bus.on(
      (e) => e.source === "auth.refresh",
      (e) => caught.push(e),
    )
    bus.emit(event({ source: "auth.refresh", message: "a" }))
    bus.emit(event({ source: "other", message: "b" }))
    bus.emit(event({ source: "auth.refresh", message: "c" }))
    expect(caught.map((e) => e.message)).toEqual(["a", "c"])
  })
})

describe("DiagnosticBus — disposal", () => {
  it("returns a dispose function that removes the listener", () => {
    const bus = createDiagnosticBus()
    const seen: LogEvent[] = []
    const dispose = bus.on("*", (e) => seen.push(e))
    bus.emit(event({ message: "1" }))
    dispose()
    bus.emit(event({ message: "2" }))
    expect(seen.map((e) => e.message)).toEqual(["1"])
  })

  it("dispose is idempotent", () => {
    const bus = createDiagnosticBus()
    const dispose = bus.on("*", () => {})
    dispose()
    dispose()
    dispose()
    // No throw, no other observable behavior.
    expect(true).toBe(true)
  })

  it("only removes the listener it was created for", () => {
    const bus = createDiagnosticBus()
    const a: number[] = []
    const b: number[] = []
    const disposeA = bus.on("*", () => a.push(1))
    bus.on("*", () => b.push(1))
    disposeA()
    bus.emit(event())
    expect(a).toEqual([])
    expect(b).toEqual([1])
  })
})

describe("DiagnosticBus — error isolation", () => {
  it("handler throws do not propagate to the producer", () => {
    const bus = createDiagnosticBus()
    bus.on("*", () => {
      throw new Error("listener boom")
    })
    // Must NOT throw.
    expect(() => bus.emit(event())).not.toThrow()
  })

  it("a throwing handler does not block subsequent handlers", () => {
    const bus = createDiagnosticBus()
    const seen: string[] = []
    bus.on("*", () => seen.push("before"))
    bus.on("*", () => {
      throw new Error("boom")
    })
    bus.on("*", () => seen.push("after"))
    bus.emit(event())
    expect(seen).toEqual(["before", "after"])
  })
})

describe("diag.* helpers", () => {
  let bus: ReturnType<typeof getDiagnosticBus>
  let collected: LogEvent[]

  beforeEach(() => {
    resetDiagnosticBus()
    bus = getDiagnosticBus()
    collected = []
    bus.on("*", (e) => collected.push(e))
  })

  it("diag.warn stamps Severity.Warning + Facility.User", () => {
    diag.warn("src.foo", "hello")
    expect(collected).toHaveLength(1)
    expect(collected[0].severity).toBe(Severity.Warning)
    expect(collected[0].facility).toBe(Facility.User)
    expect(collected[0].source).toBe("src.foo")
    expect(collected[0].message).toBe("hello")
    expect(collected[0].structuredData).toBeUndefined()
  })

  it("diag.error stamps Severity.Error", () => {
    diag.error("src.foo", "oops", { code: "E1" })
    expect(collected[0].severity).toBe(Severity.Error)
    expect(collected[0].structuredData).toEqual({ code: "E1" })
  })

  it("diag.info, diag.notice, diag.debug stamp correctly", () => {
    diag.info("a", "i")
    diag.notice("a", "n")
    diag.debug("a", "d")
    expect(collected.map((e) => e.severity)).toEqual([
      Severity.Info,
      Severity.Notice,
      Severity.Debug,
    ])
  })

  it("stamps ts with Date.now() (approximately)", () => {
    const before = Date.now()
    diag.warn("src", "msg")
    const after = Date.now()
    expect(collected[0].ts).toBeGreaterThanOrEqual(before)
    expect(collected[0].ts).toBeLessThanOrEqual(after)
  })

  it("passes structured data through verbatim", () => {
    diag.warn("src", "msg", { foo: "bar", num: 42, b: true })
    expect(collected[0].structuredData).toEqual({ foo: "bar", num: 42, b: true })
  })
})

describe("DiagnosticBus — singleton", () => {
  beforeEach(() => resetDiagnosticBus())

  it("getDiagnosticBus returns the same instance across calls", () => {
    const a = getDiagnosticBus()
    const b = getDiagnosticBus()
    expect(a).toBe(b)
  })

  it("resetDiagnosticBus replaces the singleton with a fresh instance", () => {
    const a = getDiagnosticBus()
    resetDiagnosticBus()
    const b = getDiagnosticBus()
    expect(a).not.toBe(b)
  })

  it("createDiagnosticBus returns an isolated instance, not the singleton", () => {
    const singleton = getDiagnosticBus()
    const isolated = createDiagnosticBus()
    expect(isolated).not.toBe(singleton)
    const seenInIsolated: LogEvent[] = []
    isolated.on("*", (e) => seenInIsolated.push(e))
    diag.warn("src", "msg") // emits to singleton
    expect(seenInIsolated).toHaveLength(0)
  })
})

describe("DiagnosticBus — emit-during-emit safety", () => {
  it("safely handles a handler that emits on the same bus", () => {
    const bus = createDiagnosticBus()
    let count = 0
    bus.on("*", (e) => {
      count++
      // Re-emit once on the first event; must not recurse infinitely.
      if (e.message === "first") {
        bus.emit(event({ message: "nested" }))
      }
    })
    bus.emit(event({ message: "first" }))
    // We expect: first → handler runs → emit nested → handler runs → done. = 2.
    expect(count).toBe(2)
  })

  it("safely handles a handler that disposes itself", () => {
    const bus = createDiagnosticBus()
    let count = 0
    let dispose: (() => void) | null = null
    dispose = bus.on("*", () => {
      count++
      dispose?.() // self-dispose
    })
    bus.emit(event({ message: "1" }))
    bus.emit(event({ message: "2" }))
    expect(count).toBe(1)
  })

  it("safely handles a handler that disposes another handler", () => {
    const bus = createDiagnosticBus()
    const seenB: string[] = []
    const disposeB = bus.on("*", (e) => seenB.push(e.message))
    bus.on("*", () => disposeB())
    bus.emit(event({ message: "before-dispose" }))
    bus.emit(event({ message: "after-dispose" }))
    // The order of registration is [B, kill-B]. First emit: B runs first,
    // sees "before-dispose"; then kill-B disposes B. Second emit: B is gone.
    expect(seenB).toEqual(["before-dispose"])
  })
})

import { createPluginLogger } from "./diagnostic-bus.ts"

describe("createPluginLogger", () => {
  it("auto-prefixes source with the plugin id + dot", () => {
    const bus = createDiagnosticBus()
    const seen: LogEvent[] = []
    bus.on("*", (e) => seen.push(e))
    const log = createPluginLogger("quota-status", bus)
    log.warn("timeout", "boom")
    expect(seen[0].source).toBe("quota-status.timeout")
  })

  it("maps each level method to the correct severity", () => {
    const bus = createDiagnosticBus()
    const seen: LogEvent[] = []
    bus.on("*", (e) => seen.push(e))
    const log = createPluginLogger("p", bus)
    log.emergency("a", "1")
    log.alert("a", "2")
    log.critical("a", "3")
    log.error("a", "4")
    log.warn("a", "5")
    log.notice("a", "6")
    log.info("a", "7")
    log.debug("a", "8")
    expect(seen.map((e) => e.severity)).toEqual([
      Severity.Emergency,
      Severity.Alert,
      Severity.Critical,
      Severity.Error,
      Severity.Warning,
      Severity.Notice,
      Severity.Info,
      Severity.Debug,
    ])
  })

  it("passes structured data through verbatim", () => {
    const bus = createDiagnosticBus()
    const seen: LogEvent[] = []
    bus.on("*", (e) => seen.push(e))
    const log = createPluginLogger("p", bus)
    log.warn("ev", "msg", { k: "v", n: 1, b: true })
    expect(seen[0].structuredData).toEqual({ k: "v", n: 1, b: true })
  })

  it("falls back to the singleton bus when none is passed", () => {
    resetDiagnosticBus()
    const log = createPluginLogger("p")
    const seen: LogEvent[] = []
    getDiagnosticBus().on("*", (e) => seen.push(e))
    log.info("x", "y")
    expect(seen).toHaveLength(1)
    expect(seen[0].source).toBe("p.x")
  })

  it("emits unprefixed when pluginId is empty", () => {
    const bus = createDiagnosticBus()
    const seen: LogEvent[] = []
    bus.on("*", (e) => seen.push(e))
    const log = createPluginLogger("", bus)
    log.warn("x", "y")
    expect(seen[0].source).toBe("x")
  })

  it("never throws into the caller (bus error isolation)", () => {
    const bus = createDiagnosticBus()
    bus.on("*", () => {
      throw new Error("listener boom")
    })
    const log = createPluginLogger("p", bus)
    expect(() => log.warn("x", "y")).not.toThrow()
  })
})
