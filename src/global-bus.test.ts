/**
 * Unit tests for the global event-bus pointer.
 *
 * The bus is a module-level singleton; per-test cleanup
 * (`setGlobalEventBus(null)`) prevents state leak.
 */

import { afterEach, describe, expect, it } from "bun:test"

import { getGlobalEventBus, setGlobalEventBus } from "./global-bus.ts"
import { EventBus } from "./plugins/event-bus.ts"

afterEach(() => setGlobalEventBus(null))

describe("global-bus pointer", () => {
  it("starts null", () => {
    expect(getGlobalEventBus()).toBeNull()
  })

  it("setGlobalEventBus installs the instance", () => {
    const bus = new EventBus(() => {})
    setGlobalEventBus(bus)
    expect(getGlobalEventBus()).toBe(bus)
  })

  it("emits via the global pointer reach the bus's listeners", () => {
    const bus = new EventBus(() => {})
    let seen: unknown = null
    bus.on("hello", (ctx) => {
      seen = ctx.payload
    })
    setGlobalEventBus(bus)

    getGlobalEventBus()?.emit("hello", { world: 42 })
    return new Promise<void>((resolve) => {
      // The bus dispatches via queueMicrotask; let it drain.
      queueMicrotask(() => {
        expect(seen).toEqual({ world: 42 })
        resolve()
      })
    })
  })

  it("setGlobalEventBus(null) detaches", () => {
    setGlobalEventBus(new EventBus(() => {}))
    setGlobalEventBus(null)
    expect(getGlobalEventBus()).toBeNull()
  })

  it("optional-chaining a null pointer is a no-op (the production guard)", () => {
    setGlobalEventBus(null)
    // Must not throw and must not raise an unhandled rejection.
    expect(() => getGlobalEventBus()?.emit("x", "y")).not.toThrow()
  })
})
