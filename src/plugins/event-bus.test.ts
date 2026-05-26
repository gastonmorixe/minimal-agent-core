/**
 * Tests for the plugin EventBus.
 */

import { describe, expect, test } from "bun:test"

import { EventBus, type EventContext } from "./event-bus.ts"

function silentBus(): EventBus {
  return new EventBus(() => {})
}

/** Drain the microtask queue. */
async function tick(n = 1): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

describe("EventBus", () => {
  test("emit fans out to subscribed listeners", async () => {
    const bus = silentBus()
    const seen: number[] = []
    bus.on<number>("x", (ctx) => {
      seen.push(ctx.payload)
    })
    bus.emit("x", 1)
    bus.emit("x", 2)
    await tick()
    expect(seen).toEqual([1, 2])
  })

  test("emit returns synchronously (does not await listener)", async () => {
    const bus = silentBus()
    let ran = false
    bus.on("x", async () => {
      ran = true
    })
    bus.emit("x")
    // Listener has NOT run yet — it's queued on the microtask tick.
    expect(ran).toBe(false)
    await tick()
    expect(ran).toBe(true)
  })

  test("unsubscribe handle stops further deliveries", async () => {
    const bus = silentBus()
    let count = 0
    const off = bus.on("x", () => {
      count++
    })
    bus.emit("x")
    await tick()
    off()
    bus.emit("x")
    await tick()
    expect(count).toBe(1)
  })

  test("unsubscribing during dispatch is honored", async () => {
    const bus = silentBus()
    let count = 0
    const off = bus.on("x", () => {
      count++
    })
    bus.emit("x")
    off() // unsub before microtask drains
    await tick()
    expect(count).toBe(0)
  })

  test("listener errors are isolated and reported", async () => {
    const errors: string[] = []
    const bus = new EventBus((m) => errors.push(m))
    bus.on(
      "x",
      () => {
        throw new Error("boom")
      },
      { label: "bad" },
    )
    let okCount = 0
    bus.on("x", () => {
      okCount++
    })
    bus.emit("x")
    await tick()
    expect(okCount).toBe(1)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('"bad"')
    expect(errors[0]).toContain("boom")
  })

  test("async listener rejection is caught", async () => {
    const errors: string[] = []
    const bus = new EventBus((m) => errors.push(m))
    bus.on("x", async () => {
      throw new Error("nope")
    })
    bus.emit("x")
    await tick(3)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain("nope")
  })

  test("coalesce: in-flight listener defers, only latest payload runs next", async () => {
    const bus = silentBus()
    const seen: number[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    bus.on<number>(
      "x",
      async (ctx) => {
        seen.push(ctx.payload)
        if (ctx.payload === 0) await gate
      },
      { coalesce: true },
    )

    bus.emit("x", 0)
    await tick() // start invocation 0; it awaits gate
    bus.emit("x", 1)
    bus.emit("x", 2)
    bus.emit("x", 3)
    await tick(2)
    // Still only payload 0 has been delivered (in-flight).
    expect(seen).toEqual([0])

    release()
    await tick(5)
    // Trailing edge ran with the LATEST (3), intermediates dropped.
    expect(seen).toEqual([0, 3])
  })

  test("throttle drops emits inside the window", async () => {
    const bus = silentBus()
    const seen: number[] = []
    let now = 1000
    // Inject a fake clock by monkey-patching performance.now.
    const realNow = performance.now.bind(performance)
    ;(performance as unknown as { now: () => number }).now = () => now

    try {
      bus.on<number>(
        "x",
        (ctx) => {
          seen.push(ctx.payload)
        },
        { throttleMs: 100 },
      )

      bus.emit("x", 1)
      await tick()
      now = 1050
      bus.emit("x", 2) // dropped (within 100ms)
      await tick()
      now = 1101
      bus.emit("x", 3) // delivered
      await tick()
      expect(seen).toEqual([1, 3])
    } finally {
      ;(performance as unknown as { now: () => number }).now = realNow
    }
  })

  test("dispose makes emit and on no-ops", async () => {
    const bus = silentBus()
    let count = 0
    bus.on("x", () => {
      count++
    })
    bus.dispose()
    bus.emit("x")
    bus.on("x", () => {
      count++
    })
    bus.emit("x")
    await tick()
    expect(count).toBe(0)
  })

  test("ctx.emit can re-fire on the same bus", async () => {
    const bus = silentBus()
    const seen: string[] = []
    bus.on("a", (ctx: EventContext) => {
      seen.push(`a:${String(ctx.payload)}`)
      ctx.emit("b", `from-a:${String(ctx.payload)}`)
    })
    bus.on("b", (ctx) => {
      seen.push(`b:${String(ctx.payload)}`)
    })
    bus.emit("a", 1)
    await tick(2)
    expect(seen).toEqual(["a:1", "b:from-a:1"])
  })

  test("ctx.abort fires when the bus is disposed", async () => {
    const bus = silentBus()
    let aborted = false
    bus.on("x", (ctx) => {
      ctx.abort.addEventListener("abort", () => {
        aborted = true
      })
    })
    bus.emit("x")
    await tick()
    expect(aborted).toBe(false)
    bus.dispose()
    expect(aborted).toBe(true)
  })

  test("listenerCount and eventNames reflect subscriptions", () => {
    const bus = silentBus()
    expect(bus.eventNames()).toEqual([])
    const off1 = bus.on("a", () => {})
    bus.on("a", () => {})
    bus.on("b", () => {})
    expect(bus.listenerCount("a")).toBe(2)
    expect(bus.listenerCount("b")).toBe(1)
    expect(bus.listenerCount("c")).toBe(0)
    expect(bus.eventNames().sort()).toEqual(["a", "b"])
    off1()
    expect(bus.listenerCount("a")).toBe(1)
  })

  test("undefined payload is preserved in coalesce pending slot", async () => {
    const bus = silentBus()
    const seen: unknown[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    bus.on(
      "x",
      async (ctx) => {
        seen.push(ctx.payload)
        if (seen.length === 1) await gate
      },
      { coalesce: true },
    )
    bus.emit("x", "first")
    await tick()
    bus.emit("x", undefined) // pending slot must record this delivery
    await tick()
    release()
    await tick(5)
    expect(seen).toEqual(["first", undefined])
  })
})
