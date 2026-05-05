import { describe, expect, it } from "bun:test"
import { AbortBus, type AbortReason } from "./abort-bus"

describe("AbortBus", () => {
  it("requestAbort with no turn returns false and emits no event", () => {
    const bus = new AbortBus()
    let count = 0
    bus.on("abort", () => {
      count++
    })
    const result = bus.requestAbort({ kind: "programmatic", tag: "x" })
    expect(result).toBe(false)
    expect(count).toBe(0)
    expect(bus.isTurnInFlight()).toBe(false)
  })

  it("beginTurn returns a fresh AbortController; requestAbort aborts it and emits one 'abort' with the reason", () => {
    const bus = new AbortBus()
    const ctrl = bus.beginTurn()
    expect(ctrl).toBeInstanceOf(AbortController)
    expect(ctrl.signal.aborted).toBe(false)
    expect(bus.isTurnInFlight()).toBe(true)

    const reasons: AbortReason[] = []
    bus.on("abort", (r: AbortReason) => {
      reasons.push(r)
    })

    const reason: AbortReason = { kind: "user-key", key: "Esc" }
    const result = bus.requestAbort(reason)
    expect(result).toBe(true)
    expect(ctrl.signal.aborted).toBe(true)
    expect(reasons).toEqual([reason])
  })

  it("double requestAbort: second call returns false and listener fires once", () => {
    const bus = new AbortBus()
    bus.beginTurn()
    let count = 0
    bus.on("abort", () => {
      count++
    })
    expect(bus.requestAbort({ kind: "programmatic", tag: "a" })).toBe(true)
    expect(bus.requestAbort({ kind: "programmatic", tag: "b" })).toBe(false)
    expect(count).toBe(1)
  })

  it("endTurn clears state; subsequent requestAbort returns false", () => {
    const bus = new AbortBus()
    bus.beginTurn()
    bus.endTurn()
    expect(bus.isTurnInFlight()).toBe(false)
    let count = 0
    bus.on("abort", () => {
      count++
    })
    expect(bus.requestAbort({ kind: "programmatic", tag: "a" })).toBe(false)
    expect(count).toBe(0)
  })

  it("after endTurn then beginTurn again, a new requestAbort works fresh", () => {
    const bus = new AbortBus()
    const c1 = bus.beginTurn()
    bus.requestAbort({ kind: "programmatic", tag: "first" })
    bus.endTurn()

    const c2 = bus.beginTurn()
    expect(c2).not.toBe(c1)
    expect(c2.signal.aborted).toBe(false)

    const reasons: AbortReason[] = []
    bus.on("abort", (r: AbortReason) => {
      reasons.push(r)
    })
    const reason: AbortReason = { kind: "timeout", ms: 1000 }
    expect(bus.requestAbort(reason)).toBe(true)
    expect(c2.signal.aborted).toBe(true)
    expect(reasons).toEqual([reason])
  })

  it("isTurnInFlight reflects state correctly across the lifecycle", () => {
    const bus = new AbortBus()
    expect(bus.isTurnInFlight()).toBe(false)
    bus.beginTurn()
    expect(bus.isTurnInFlight()).toBe(true)
    bus.requestAbort({ kind: "signal", signal: "SIGINT" })
    expect(bus.isTurnInFlight()).toBe(false)
    bus.endTurn()
    expect(bus.isTurnInFlight()).toBe(false)
    bus.beginTurn()
    expect(bus.isTurnInFlight()).toBe(true)
    bus.endTurn()
    expect(bus.isTurnInFlight()).toBe(false)
  })
})
