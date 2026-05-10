/**
 * Unit tests for `LiveAreaScheduler`.
 *
 * Drives the scheduler with a fake `setTimeout`/`clearTimeout` pair so
 * we can advance virtual time deterministically — no `await
 * new Promise(setTimeout)` flakes. The fake timer is a tiny min-heap
 * of `{when, fn}` entries that `tick(ms)` advances; cancellation
 * removes by id.
 *
 * Each test isolates the slot wiring (no real plugin loader involved):
 * we hand-construct {@link ResolvedLiveAreaSlot} fixtures with the
 * minimum shape `LiveAreaScheduler` reads.
 */

import { describe, expect, it } from "bun:test"
import { LiveAreaScheduler, type LiveAreaSink } from "./live-area-providers.ts"
import type {
  LiveAreaHandlerContext,
  ManifestLiveAreaSlot,
  ResolvedLiveAreaSlot,
} from "./plugins/types.ts"

// ----------------------------- fake timer ---------------------------------

class FakeClock {
  private now = 0
  private nextId = 1
  private q: Array<{ id: number; when: number; fn: () => void; cancelled: boolean }> = []

  setTimeout = (fn: () => void, ms: number): unknown => {
    const id = this.nextId++
    this.q.push({ id, when: this.now + ms, fn, cancelled: false })
    this.q.sort((a, b) => a.when - b.when)
    return { id } as unknown
  }

  clearTimeout = (handle: unknown): void => {
    const t = (handle as { id?: number })?.id
    for (const e of this.q) if (e.id === t) e.cancelled = true
  }

  /**
   * Advance virtual time by `ms` ms, firing any due (non-cancelled)
   * timers in order. After firing each timer we also let microtasks
   * settle — handlers commonly resolve a Promise, and the scheduler's
   * `.then(handle)` continuation is a microtask.
   *
   * We drain microtasks BEFORE looking for the next due timer (so a
   * just-fired handler that calls `scheduleNext` is observable on this
   * iteration), and once more at the end (so the caller can assert on
   * post-resolve state without a manual `await Promise.resolve()`
   * after every tick).
   */
  async tick(ms: number): Promise<void> {
    const target = this.now + ms
    // Drain microtasks at entry so any handlers that resolved between
    // ticks have already run before we sample the queue.
    await this.drainMicrotasks()
    while (true) {
      const next = this.q.find((e) => !e.cancelled)
      if (!next || next.when > target) break
      this.now = next.when
      next.cancelled = true
      next.fn()
      await this.drainMicrotasks()
    }
    this.now = target
    await this.drainMicrotasks()
  }

  private async drainMicrotasks(): Promise<void> {
    // 16 turns is plenty for `Promise.resolve().then().then()` chains and
    // for an async-function body with a couple of awaits.
    for (let i = 0; i < 16; i++) await Promise.resolve()
  }

  pendingCount(): number {
    return this.q.filter((e) => !e.cancelled).length
  }
}

// -------------------------------- helpers ---------------------------------

interface SlotSpec {
  id: string
  position?: "header" | "footer"
  refreshMs?: number
  timeoutMs?: number
  invoke: (ctx: LiveAreaHandlerContext) => Promise<string | null>
}

function makeSlot(spec: SlotSpec): ResolvedLiveAreaSlot {
  const definition: ManifestLiveAreaSlot = {
    id: spec.id,
    handler: { type: "module", path: "./fake.ts" },
    position: spec.position ?? "footer",
    refreshMs: spec.refreshMs ?? 60_000,
    timeoutMs: spec.timeoutMs ?? 5000,
  }
  return {
    definition,
    pluginId: "fake-plugin",
    packageDir: "/tmp/fake",
    entryAbsolute: "/tmp/fake/handler.ts",
    invoke: spec.invoke,
  }
}

function makeSink(): LiveAreaSink & { footerCalls: string[][]; decorationCalls: string[][] } {
  const footerCalls: string[][] = []
  const decorationCalls: string[][] = []
  return {
    footerCalls,
    decorationCalls,
    setFooterLines(lines) {
      footerCalls.push([...lines])
    },
    setDecorationLines(lines) {
      decorationCalls.push([...lines])
    },
  }
}

// --------------------------------- tests ----------------------------------

describe("LiveAreaScheduler — first-tick semantics", () => {
  it("invokes every slot at t=0 with tick=0", async () => {
    const ticks: number[] = []
    const slot = makeSlot({
      id: "a",
      invoke: async (ctx) => {
        ticks.push(ctx.tick)
        return "value"
      },
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0) // settle microtasks
    expect(ticks).toEqual([0])
    expect(sink.footerCalls.at(-1)).toEqual(["value"])
    sched.stop()
  })

  it("invokes again every refreshMs with monotonic tick counter", async () => {
    const ticks: number[] = []
    const slot = makeSlot({
      id: "a",
      refreshMs: 1_000,
      invoke: async (ctx) => {
        ticks.push(ctx.tick)
        return `t=${ctx.tick}`
      },
    })
    const clock = new FakeClock()
    const sched = new LiveAreaScheduler([slot], makeSink(), {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    await clock.tick(1_000)
    await clock.tick(1_000)
    expect(ticks).toEqual([0, 1, 2])
    sched.stop()
  })
})

describe("LiveAreaScheduler — repaint dedup & routing", () => {
  it("does not repaint the sink when the slot value is unchanged", async () => {
    const slot = makeSlot({ id: "a", refreshMs: 1_000, invoke: async () => "same" })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    const firstCount = sink.footerCalls.length
    await clock.tick(5_000) // 5 more invocations, all returning "same"
    expect(sink.footerCalls.length).toBe(firstCount) // no extra paints
    sched.stop()
  })

  it("repaints when the value changes", async () => {
    let n = 0
    const slot = makeSlot({
      id: "a",
      refreshMs: 1_000,
      invoke: async () => `v${n++}`,
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    await clock.tick(1_000)
    await clock.tick(1_000)
    expect(sink.footerCalls.length).toBe(3)
    expect(sink.footerCalls.map((c) => c[0])).toEqual(["v0", "v1", "v2"])
    sched.stop()
  })

  it("clears the slot when handler returns null", async () => {
    let returnNull = false
    const slot = makeSlot({
      id: "a",
      refreshMs: 1_000,
      invoke: async () => (returnNull ? null : "ok"),
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    expect(sink.footerCalls.at(-1)).toEqual(["ok"])
    returnNull = true
    await clock.tick(1_000)
    expect(sink.footerCalls.at(-1)).toEqual([])
    sched.stop()
  })

  it('treats `position: "header"` as footer (with a one-time warning)', async () => {
    const warnings: string[] = []
    const slot = makeSlot({
      id: "h",
      position: "header",
      refreshMs: 1_000,
      invoke: async () => "hi",
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: (m) => warnings.push(m),
    })
    sched.start()
    await clock.tick(0)
    await clock.tick(1_000)
    await clock.tick(1_000)
    expect(sink.footerCalls.at(-1)).toEqual(["hi"])
    // Warning fires exactly once even across multiple ticks.
    expect(warnings.filter((w) => w.includes('position="header"'))).toHaveLength(1)
    sched.stop()
  })
})

describe("LiveAreaScheduler — failure modes", () => {
  it("logs a thrown handler and clears its slot for that tick", async () => {
    const logs: string[] = []
    const slot = makeSlot({
      id: "a",
      invoke: async () => {
        throw new Error("boom")
      },
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: (m) => logs.push(m),
    })
    sched.start()
    await clock.tick(0)
    expect(logs.some((l) => l.includes("boom"))).toBe(true)
    // Sink should NOT be called with anything for footer (since clear-on-error
    // collapses to "still null", and null-from-null is a no-op).
    expect(sink.footerCalls).toHaveLength(0)
    sched.stop()
  })

  it("recovers on the next tick after a failure", async () => {
    let throwOnce = true
    const slot = makeSlot({
      id: "a",
      refreshMs: 1_000,
      invoke: async () => {
        if (throwOnce) {
          throwOnce = false
          throw new Error("once")
        }
        return "recovered"
      },
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    await clock.tick(1_000)
    expect(sink.footerCalls.at(-1)).toEqual(["recovered"])
    sched.stop()
  })

  it("aborts a slow invocation when timeoutMs elapses (next tick still scheduled)", async () => {
    // The slot's invoke listens for `ctx.abort` and resolves to a sentinel
    // when fired. Without the timeout firing, the promise would hang
    // forever — proving the timeout-AbortController plumbing works.
    let abortedTicks = 0
    const slot = makeSlot({
      id: "slow",
      refreshMs: 1_000,
      timeoutMs: 200,
      invoke: (ctx) =>
        new Promise<string | null>((resolve) => {
          ctx.abort.addEventListener(
            "abort",
            () => {
              abortedTicks++
              resolve("aborted")
            },
            { once: true },
          )
        }),
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0) // fire kicks; timeoutHandle scheduled at when=200
    expect(abortedTicks).toBe(0)
    await clock.tick(200) // timeout fires → ctx.abort → invoke resolves "aborted"
    expect(abortedTicks).toBe(1)
    expect(sink.footerCalls.at(-1)).toEqual(["aborted"])
    sched.stop()
  })

  // ----------------------------------------------------------------------
  // Regression: the live-area `quota-status` slot's deadlock recovery.
  //
  // A slot handler that *ignores* `ctx.abort` (older API consumers, or any
  // network call without signal plumbing — exactly what `checkQuota`
  // looked like before May 2026) must NOT permanently deadlock the
  // scheduler when its in-flight invocation gets stuck. The defensive
  // belt at the bottom of `fire()` is what makes that true: when the
  // timeout fires, we deliberately wait one microtask for a "natural"
  // resolution (so well-behaved handlers still win the latch), then
  // force-release `s.inFlight` ourselves and log a diagnostic.
  //
  // Both refresh paths (heartbeat AND `refreshOn` events) share the same
  // gate, so we test BOTH here — that's the smoking gun for the user's
  // bug report ("two systems failed: the interval AND the new request").
  // ----------------------------------------------------------------------
  it(
    "force-releases inFlight when timeoutMs fires AND invoke ignores ctx.abort " +
      "(heartbeat + refreshOn both recover)",
    async () => {
      const { EventBus } = await import("./plugins/event-bus.ts")
      const bus = new EventBus(() => {})
      let invokeCount = 0
      const slot = makeSlot({
        id: "deadlock-prone",
        refreshMs: 1_000,
        timeoutMs: 200,
        // The pathological case: invoke returns a promise that NEVER
        // resolves, NEVER rejects, and NEVER honors ctx.abort. This is
        // the fingerprint of a TCP socket whose peer died during macOS
        // sleep — `fetch` over h2 sits there forever.
        invoke: () => {
          invokeCount++
          return new Promise<string | null>(() => {
            /* never settles */
          })
        },
      })
      slot.definition.refreshOn = ["quota.headersReceived"]

      const logs: string[] = []
      const clock = new FakeClock()
      const sched = new LiveAreaScheduler([slot], makeSink(), {
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout,
        bus,
        logger: (m) => logs.push(m),
      })

      sched.start()
      await clock.tick(0)
      expect(invokeCount).toBe(1) // first fire kicked off

      // -- HEARTBEAT recovery --
      // Without the defensive belt, `s.inFlight` would still be true at
      // this point (the original promise never resolves) and the next
      // refreshMs tick would skip on the `if (s.inFlight) return` guard
      // — every subsequent heartbeat for the rest of the session.
      await clock.tick(200) // timeoutMs fires → force-release path runs
      expect(logs.some((m) => m.includes("timed out") && m.includes("deadlock-prone"))).toBe(true)

      // The heartbeat scheduled by the force-release path runs at
      // refreshMs after the release. Advance to that boundary and
      // confirm a second invoke actually fires (proving inFlight is now
      // false). 1000ms refresh + the 200ms we already advanced = 1200ms
      // since start, but scheduleNext re-schedules from "now", so we
      // need 1000ms more.
      await clock.tick(1_000)
      expect(invokeCount).toBe(2) // heartbeat recovered

      // -- refreshOn (bus event) recovery --
      // Even more important than the heartbeat: while the second fire
      // is also stuck (same pathological invoke), the user's recent API
      // response broadcast a `quota.headersReceived` event. Before the
      // fix, this emit would also hit the `inFlight` gate and silently
      // drop. After the fix, the timeout's force-release lets the next
      // bus emit kick off another invoke.
      await clock.tick(200) // second fire's timeoutMs fires
      bus.emit("quota.headersReceived", { rateLimits: new Map() })
      await clock.tick(0) // drain microtasks for the bus listener
      expect(invokeCount).toBe(3) // bus path recovered

      sched.stop()
    },
  )

  it("a well-behaved handler still wins the latch (force-release does NOT clobber on-time results)", async () => {
    // The defensive belt MUST be a tiebreaker for stuck handlers, not a
    // pre-emption of well-behaved ones. If invoke honors ctx.abort and
    // resolves to "aborted" the moment the signal fires, the latch must
    // record "aborted" — NOT null from the force-release microtask. This
    // is the existing "aborts a slow invocation" test's invariant. We
    // re-assert it here to pin the no-regression-on-the-happy-path bound
    // alongside the deadlock recovery test.
    // Explicit annotation prevents TS from narrowing to `undefined` at the
    // initializer. We mutate it from the abort listener below.
    let resolvedWith = undefined as string | null | undefined
    const slot = makeSlot({
      id: "well-behaved",
      refreshMs: 60_000,
      timeoutMs: 200,
      invoke: (ctx) =>
        new Promise<string | null>((resolve) => {
          ctx.abort.addEventListener(
            "abort",
            () => {
              resolvedWith = "aborted-ok"
              resolve(resolvedWith)
            },
            { once: true },
          )
        }),
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    await clock.tick(200) // timeoutMs fires
    // Sink received the well-behaved value, NOT a null force-release.
    expect(resolvedWith).toBe("aborted-ok")
    expect(sink.footerCalls.at(-1)).toEqual(["aborted-ok"])
    sched.stop()
  })
})

describe("LiveAreaScheduler — lifecycle", () => {
  it("stop() cancels pending timers and is idempotent", async () => {
    const slot = makeSlot({ id: "a", refreshMs: 1_000, invoke: async () => "ok" })
    const clock = new FakeClock()
    const sched = new LiveAreaScheduler([slot], makeSink(), {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    expect(clock.pendingCount()).toBe(1) // the next refresh
    sched.stop()
    expect(clock.pendingCount()).toBe(0)
    sched.stop() // idempotent
    expect(clock.pendingCount()).toBe(0)
  })

  it("snapshot() exposes current per-slot value", async () => {
    const slot = makeSlot({ id: "a", invoke: async () => "alpha" })
    const clock = new FakeClock()
    const sched = new LiveAreaScheduler([slot], makeSink(), {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    expect(sched.snapshot().get("a")).toBe("alpha")
    sched.stop()
  })
})

describe("LiveAreaScheduler — placeholder + refreshOn", () => {
  it("paints the placeholder synchronously at start(), BEFORE any fire resolves", async () => {
    let resolveInvoke!: (v: string) => void
    const slot = makeSlot({
      id: "p",
      invoke: () => new Promise<string | null>((r) => (resolveInvoke = r)),
    })
    // Inject a placeholder via the slot definition (we override the test
    // factory's default footer position; placeholder lives next to it).
    slot.definition.placeholder = "loading…"

    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    // BEFORE we resolve the invoke: the footer must already have the
    // placeholder line — that's the whole point of this feature.
    expect(sink.footerCalls.at(-1)).toEqual(["loading…"])

    // Drain microtasks so the .then chain reaches `slot.invoke(ctx)` and
    // captures `resolveInvoke`. The invoke promise is hung until we call
    // it explicitly — placeholder must STILL be the latest paint at this
    // point (no value has resolved yet).
    for (let i = 0; i < 16; i++) await Promise.resolve()
    expect(sink.footerCalls.at(-1)).toEqual(["loading…"])

    // Resolve invoke with real data; placeholder is replaced.
    resolveInvoke("real value")
    await clock.tick(0)
    expect(sink.footerCalls.at(-1)).toEqual(["real value"])
    sched.stop()
  })

  it("falls back to the placeholder when a tick returns null", async () => {
    let returnNull = false
    const slot = makeSlot({
      id: "p",
      refreshMs: 1_000,
      invoke: async () => (returnNull ? null : "data"),
    })
    slot.definition.placeholder = "·"

    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    expect(sink.footerCalls.at(-1)).toEqual(["data"])
    returnNull = true
    await clock.tick(1_000)
    // Row reservation is preserved — falls back to placeholder, not [].
    expect(sink.footerCalls.at(-1)).toEqual(["·"])
    sched.stop()
  })

  it("without a placeholder, null still clears the row (legacy behavior)", async () => {
    let returnNull = false
    const slot = makeSlot({
      id: "p",
      refreshMs: 1_000,
      invoke: async () => (returnNull ? null : "data"),
    })
    // No placeholder set.

    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    expect(sink.footerCalls.at(-1)).toEqual(["data"])
    returnNull = true
    await clock.tick(1_000)
    expect(sink.footerCalls.at(-1)).toEqual([])
    sched.stop()
  })

  it("refreshOn events trigger an off-cycle re-fire", async () => {
    const { EventBus } = await import("./plugins/event-bus.ts")
    const bus = new EventBus(() => {})
    let invokeCount = 0
    const slot = makeSlot({
      id: "q",
      refreshMs: 60_000, // very long timer; we drive via events
      invoke: async () => `tick=${invokeCount++}`,
    })
    slot.definition.refreshOn = ["evt.refresh"]

    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      bus,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    expect(invokeCount).toBe(1) // first fire from start()
    expect(sink.footerCalls.at(-1)).toEqual(["tick=0"])

    // Emit the event the slot subscribed to. EventBus uses queueMicrotask;
    // drain microtasks via tick(0).
    bus.emit("evt.refresh")
    await clock.tick(0)
    expect(invokeCount).toBe(2)
    expect(sink.footerCalls.at(-1)).toEqual(["tick=1"])

    // Repeated emits each fire (subject to in-flight skip, which doesn't
    // apply here since invoke resolves synchronously).
    bus.emit("evt.refresh")
    await clock.tick(0)
    expect(invokeCount).toBe(3)
    sched.stop()
  })

  it("refreshOn drops events that arrive while a previous tick is in-flight", async () => {
    const { EventBus } = await import("./plugins/event-bus.ts")
    const bus = new EventBus(() => {})
    let invokeCount = 0
    let resolveFirst!: (v: string | null) => void
    const slot = makeSlot({
      id: "q",
      refreshMs: 60_000,
      invoke: () =>
        new Promise<string | null>((r) => {
          invokeCount++
          if (invokeCount === 1) resolveFirst = r
          else r(`tick=${invokeCount}`)
        }),
    })
    slot.definition.refreshOn = ["evt.refresh"]

    const clock = new FakeClock()
    const sched = new LiveAreaScheduler([slot], makeSink(), {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      bus,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    expect(invokeCount).toBe(1) // first fire hangs

    // Burst of events while in-flight — none cause a new invoke.
    for (let i = 0; i < 5; i++) bus.emit("evt.refresh")
    await clock.tick(0)
    expect(invokeCount).toBe(1)

    // Resolve the first; subsequent emit fires normally.
    resolveFirst("first")
    await clock.tick(0)
    bus.emit("evt.refresh")
    await clock.tick(0)
    expect(invokeCount).toBe(2)
    sched.stop()
  })

  it("stop() removes refreshOn listeners (no leak across REPL teardown)", async () => {
    const { EventBus } = await import("./plugins/event-bus.ts")
    const bus = new EventBus(() => {})
    let invokeCount = 0
    const slot = makeSlot({
      id: "q",
      refreshMs: 60_000,
      invoke: async () => `tick=${invokeCount++}`,
    })
    slot.definition.refreshOn = ["evt.refresh"]

    const clock = new FakeClock()
    const sched = new LiveAreaScheduler([slot], makeSink(), {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      bus,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    sched.stop()

    bus.emit("evt.refresh")
    await clock.tick(0)
    // Still only the start()-time invoke; emit after stop is dropped.
    expect(invokeCount).toBe(1)
    expect(bus.listenerCount("evt.refresh")).toBe(0)
  })

  it("repaint dedup: identical footer arrays don't double-push to the sink", async () => {
    const slot = makeSlot({ id: "a", invoke: async () => "v" })
    slot.definition.placeholder = "·"
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    // start() repaint paints placeholder ["·"]. fire's first invoke
    // returns "v" → another paint ["v"]. But NO empty paint between.
    await clock.tick(0)
    const footerSnaps = sink.footerCalls.map((f) => f.slice())
    // We accept either:
    //  - [["·"], ["v"]]  (placeholder paint then value paint)
    //  - [["v"]]         (placeholder ≡ no paint when there's no row to draw)
    // What we MUST NOT see is an interleaved []-paint or duplicates.
    expect(footerSnaps.every((f) => f.length === 1)).toBe(true)
    expect(footerSnaps.at(-1)).toEqual(["v"])
    sched.stop()
  })
})
