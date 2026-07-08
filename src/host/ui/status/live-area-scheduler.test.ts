/**
 * Unit tests for `LiveAreaScheduler`.
 *
 * Drives the scheduler with a fake `setTimeout`/`clearTimeout` pair so
 * we can advance virtual time deterministically — no
 * `await new Promise(setTimeout)` flakes. The fake timer is a tiny min-heap
 * of `{when, fn}` entries that `tick(ms)` advances; cancellation
 * removes by id.
 *
 * Each test isolates the slot wiring (no real plugin loader involved):
 * we hand-construct {@link ResolvedLiveAreaSlot} fixtures with the
 * minimum shape `LiveAreaScheduler` reads.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { setDecorationSuffix } from "@minimal-agent/plugin-api/utils/decoration-suffix"

import { FakeClock, makeSink, makeSlot } from "./live-area-scheduler.fixtures.ts"
import { LiveAreaScheduler } from "./live-area-scheduler.ts"

// --------------------------------- tests ----------------------------------

// The decoration-suffix singleton is global mutable state. Reset it before
// every test so non-suffix tests don't see a suffix from a prior file.
beforeEach(() => setDecorationSuffix(""))

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

  it("expands a multi-line slot value into one footer line per row", async () => {
    // A widget (e.g. the sub-agent fleet panel) returns several rows as a
    // single "\n"-joined string; the scheduler must paint each as its own
    // footer line so the editor counts live-area height correctly.
    const slot = makeSlot({
      id: "fleet",
      refreshMs: 1_000,
      invoke: async () => "◈ fleet · 2 running\n  ◐ A2 worker\n  ◐ A3 explorer",
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
    expect(sink.footerCalls.at(-1)).toEqual([
      "◈ fleet · 2 running",
      "  ◐ A2 worker",
      "  ◐ A3 explorer",
    ])
    sched.stop()
  })

  it("leaves a single-line slot value as exactly one footer line", async () => {
    const slot = makeSlot({ id: "a", refreshMs: 1_000, invoke: async () => "one row" })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    expect(sink.footerCalls.at(-1)).toEqual(["one row"])
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

  it('routes `position: "header"` to decoration lines', async () => {
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
    expect(sink.decorationCalls.at(-1)).toEqual(["hi"])
    expect(sink.footerCalls).toEqual([])
    expect(warnings.filter((w) => w.includes('position="header"'))).toHaveLength(0)
    sched.stop()
  })

  it("clears header slots through decoration lines", async () => {
    let returnNull = false
    const slot = makeSlot({
      id: "h",
      position: "header",
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
    expect(sink.decorationCalls.at(-1)).toEqual(["ok"])
    returnNull = true
    await clock.tick(1_000)
    expect(sink.decorationCalls.at(-1)).toEqual([])
    expect(sink.footerCalls).toEqual([])
    sched.stop()
  })
})

describe("LiveAreaScheduler — decoration suffix", () => {
  beforeEach(() => setDecorationSuffix(""))
  afterEach(() => setDecorationSuffix(""))

  it("appends the decoration suffix to the first footer line (intercom roster)", async () => {
    const slot = makeSlot({
      id: "f",
      position: "footer",
      refreshMs: 1_000,
      invoke: async () => "⇆ intercom · 8 online · 5 gone",
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    setDecorationSuffix("  · ♻ sk-lsp · · tsgo")
    sched.start()
    await clock.tick(0)
    expect(sink.footerCalls.at(-1)).toEqual(["⇆ intercom · 8 online · 5 gone  · ♻ sk-lsp · · tsgo"])
    sched.stop()
  })

  it("does not append suffix when no footer lines exist", async () => {
    const slot = makeSlot({
      id: "f",
      position: "footer",
      refreshMs: 1_000,
      invoke: async () => null,
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    setDecorationSuffix("  · ♻ sk-lsp")
    sched.start()
    await clock.tick(0)
    // No footer lines → no suffix
    expect(sink.footerCalls.at(-1)).toBeUndefined()
    sched.stop()
  })

  it("does not append an empty suffix", async () => {
    const slot = makeSlot({
      id: "f",
      position: "footer",
      refreshMs: 1_000,
      invoke: async () => "roster",
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    // Leave suffix empty (default)
    sched.start()
    await clock.tick(0)
    expect(sink.footerCalls.at(-1)).toEqual(["roster"])
    sched.stop()
  })

  it("suffix is NOT added to header/decoration lines", async () => {
    const slot = makeSlot({
      id: "h",
      position: "header",
      refreshMs: 1_000,
      invoke: async () => "header content",
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    setDecorationSuffix("  · ♻ sk-lsp")
    sched.start()
    await clock.tick(0)
    // Header/decoration lines should NOT have the suffix
    expect(sink.decorationCalls.at(-1)).toEqual(["header content"])
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
      const { EventBus } = await import("../../../plugins/event-bus.ts")
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
    const { EventBus } = await import("../../../plugins/event-bus.ts")
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
    const { EventBus } = await import("../../../plugins/event-bus.ts")
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
    const { EventBus } = await import("../../../plugins/event-bus.ts")
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

// ---------------------------------------------------------------------------
// End-to-end: the canonical transport's post-turn quota poke reaches the footer
// ---------------------------------------------------------------------------
//
// Post-Wave-G regression guard. Every provider plugin now lives in a sibling
// repo and caches its OWN rate-limit headers during adapter.run(); core can't
// reach that cache, so it can't broadcast the headers. The fix is that the
// canonical transport fires `signalQuotaRefresh()` (a payload-less
// `quota.headersReceived` emit on the global bus) after every completed send.
// This test proves that emit re-invokes a real quota footer slot through the
// live-area scheduler — the whole "footer repaints this turn" path — using the
// exact core seam the transport calls, without pulling the transport's auth
// harness into a host test. (The transport-side emit itself is pinned in
// src/llm/transport/canonical-send.test.ts.)
describe("LiveAreaScheduler — post-turn quota footer refresh (E2E seam)", () => {
  it("signalQuotaRefresh() from the transport re-invokes the quota footer slot", async () => {
    const { EventBus } = await import("../../../plugins/event-bus.ts")
    const { getGlobalEventBus, setGlobalEventBus } = await import("../../../bus/global-bus.ts")
    const { QUOTA_HEADERS_RECEIVED, signalQuotaRefresh } = await import(
      "../../../quota/quota-broadcast.ts"
    )

    const prevBus = getGlobalEventBus()
    const bus = new EventBus(() => {})
    setGlobalEventBus(bus)

    let invokeCount = 0
    const slot = makeSlot({
      id: "quota",
      refreshMs: 60_000, // long timer: the only re-fire we expect is event-driven
      invoke: async () => `quota-${invokeCount++}`,
    })
    slot.definition.refreshOn = [QUOTA_HEADERS_RECEIVED]

    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      bus,
      logger: () => {},
    })
    try {
      sched.start()
      await clock.tick(0)
      expect(invokeCount).toBe(1)
      expect(sink.footerCalls.at(-1)).toEqual(["quota-0"])

      // The exact call canonicalSendFn makes after a completed send.
      signalQuotaRefresh()
      await clock.tick(0)
      expect(invokeCount).toBe(2)
      expect(sink.footerCalls.at(-1)).toEqual(["quota-1"])
    } finally {
      sched.stop()
      setGlobalEventBus(prevBus)
    }
  })
})
