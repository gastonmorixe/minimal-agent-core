/**
 * Footer-tail tests for `LiveAreaScheduler` (split from
 * live-area-scheduler.test.ts to stay under the max-lines lint cap).
 *
 * Covers: legacy suffix-only compat, inline tail placement on the LAST
 * footer line, per-plugin-id keying, and suffix+tail coexistence.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { setDecorationSuffix } from "@minimal-agent/plugin-api/utils/decoration-suffix"
import { clearFooterTails, setFooterTail } from "@minimal-agent/plugin-api/utils/footer-tail"

import { FakeClock, makeSink, makeSlot } from "./live-area-scheduler.fixtures.ts"
import { LiveAreaScheduler } from "./live-area-scheduler.ts"

beforeEach(() => setDecorationSuffix(""))
beforeEach(() => clearFooterTails())
afterEach(() => setDecorationSuffix(""))
afterEach(() => clearFooterTails())

describe("LiveAreaScheduler — footer tails", () => {
  it("exposes footerReservedWidth = 0 when nothing is reserved", async () => {
    let seen: number | undefined
    const slot = makeSlot({
      id: "f",
      position: "footer",
      refreshMs: 1_000,
      invoke: async (ctx) => {
        seen = ctx.footerReservedWidth
        return "quota line"
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
    expect(seen).toBe(0)
    sched.stop()
  })

  it("REGRESSION: footerReservedWidth counts suffix + joined tails with their gaps", async () => {
    // The bug this pins: quota-status rendered its bar ladder against bare
    // COLUMNS, so bars stayed at max width while the host appended the tps
    // tail inline — pushing the line past cols and clipping the tail. The
    // ctx field must report the FULL reservation so the ladder starts
    // shrinking as soon as the whole painted line stops fitting.
    let seen: number | undefined
    const slot = makeSlot({
      id: "f",
      pluginId: "quota-status",
      position: "footer",
      refreshMs: 1_000,
      invoke: async (ctx) => {
        seen = ctx.footerReservedWidth
        return "quota line"
      },
    })
    setDecorationSuffix("\x1b[2m· ♻ sk-lsp\x1b[22m") // visible width 10
    setFooterTail("tps", "\x1b[2m28/tps\x1b[22m") // visible width 6
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    // 2 + 10 (suffix gap + width) + 2 + 6 (tails gap + width) = 20.
    // ANSI escapes contribute 0 cells.
    expect(seen).toBe(20)
    sched.stop()
  })

  it("footerReservedWidth updates when a tail appears mid-session", async () => {
    const seen: number[] = []
    const slot = makeSlot({
      id: "f",
      position: "footer",
      refreshMs: 1_000,
      invoke: async (ctx) => {
        seen.push(ctx.footerReservedWidth ?? -1)
        return "quota line"
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
    expect(seen.at(-1)).toBe(0)
    // TPS wakes up mid-stream.
    setFooterTail("tps", "28/tps")
    await clock.tick(1_000)
    expect(seen.at(-1)).toBe(2 + 6)
    sched.stop()
  })

  it("suffix-only behavior is UNCHANGED when no tails exist (legacy compat)", async () => {
    const slot = makeSlot({
      id: "f",
      position: "footer",
      refreshMs: 1_000,
      invoke: async () => "quota line",
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
    // Byte-identical to the pre-tail behavior: suffix appended inline, no
    // tail block.
    expect(sink.footerCalls.at(-1)).toEqual(["quota line  · ♻ sk-lsp"])
    sched.stop()
  })

  it("appends the tail INLINE after the LAST footer line's content", async () => {
    const slot = makeSlot({
      id: "f",
      position: "footer",
      refreshMs: 1_000,
      invoke: async () => "quota line",
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    setFooterTail("tps", "42/tps")
    sched.start()
    await clock.tick(0)
    // Inline with a two-space gap — same visual grammar as segments inside
    // the line. No right-edge padding (the editor clips overlong lines,
    // which truncated padded tails in production).
    expect(sink.footerCalls.at(-1)).toEqual(["quota line  42/tps"])
    sched.stop()
  })

  it("REGRESSION: tail rides the LAST footer line, not the intercom roster", async () => {
    // Real-world bug: the intercom roster is a footer slot that can sort
    // BEFORE quota-status. Tails must land on the bottom-most (status) line,
    // never on the roster above it.
    let rosterValue = "⇆ intercom · 3 online"
    const roster = makeSlot({
      id: "intercom",
      pluginId: "intercom",
      position: "footer",
      refreshMs: 1_000,
      invoke: async () => rosterValue,
    })
    const quota = makeSlot({
      id: "quota",
      pluginId: "quota-status",
      position: "footer",
      refreshMs: 1_000,
      invoke: async () => "1M ▏░░░░░░░ 1% 10.8k beed5631 (Daniela)",
    })
    const tps = makeSlot({
      id: "tps",
      pluginId: "tps",
      position: "footer",
      refreshMs: 60_000,
      invoke: async (ctx) => {
        ctx.setFooterTail?.("28/tps")
        return null
      },
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([roster, quota, tps], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    const lines = sink.footerCalls.at(-1)!
    expect(lines.length).toBe(2)
    // Roster line untouched.
    expect(lines[0]).toBe("⇆ intercom · 3 online")
    // Tail is inline on the status line, after the sid/name segment.
    expect(lines[1]).toBe("1M ▏░░░░░░░ 1% 10.8k beed5631 (Daniela)  28/tps")
    sched.stop()
  })

  it("clearing the tail removes it from the next repaint", async () => {
    let line = "quota line"
    const slot = makeSlot({
      id: "f",
      position: "footer",
      refreshMs: 1_000,
      invoke: async () => line,
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    setFooterTail("tps", "42/tps")
    sched.start()
    await clock.tick(0)
    expect(sink.footerCalls.at(-1)![0]).toContain("42/tps")
    // Tail-only change: the carrier line is unchanged. The scheduler must
    // still re-flush so clearing the registry actually drops the segment.
    setFooterTail("tps", "")
    await clock.tick(1_000)
    expect(sink.footerCalls.at(-1)).toEqual(["quota line"])
    sched.stop()
  })

  it("binds ctx.setFooterTail per plugin id (two plugins don't clobber)", async () => {
    // A tail-only slot paints NO row of its own; pair each publisher with a
    // row-producing slot so there is a footer line for the tails to ride on.
    const carrier = makeSlot({
      id: "carrier",
      position: "footer",
      refreshMs: 1_000,
      invoke: async () => "quota line",
    })
    const a = makeSlot({
      id: "a",
      pluginId: "plugin-a",
      position: "footer",
      refreshMs: 1_000,
      invoke: async (ctx) => {
        ctx.setFooterTail?.("from-a")
        return null
      },
    })
    const b = makeSlot({
      id: "b",
      pluginId: "plugin-b",
      position: "footer",
      refreshMs: 1_000,
      invoke: async (ctx) => {
        ctx.setFooterTail?.("from-b")
        return null
      },
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([carrier, a, b], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    // Both tails survive on the carrier's line — keyed independently.
    const line = sink.footerCalls.at(-1)![0]!
    expect(line).toContain("from-a")
    expect(line).toContain("from-b")
    sched.stop()
  })
})

describe("LiveAreaScheduler — suffix + tails coexistence", () => {
  it("decoration suffix (inline) and footer tails (inline) coexist", async () => {
    const slot = makeSlot({
      id: "f",
      position: "footer",
      refreshMs: 1_000,
      invoke: async () => "quota line",
    })
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([slot], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      logger: () => {},
    })
    // Real-world scenario: diagnostics LSP badge inline + tps tail.
    setDecorationSuffix("  · ♻ sk-lsp")
    setFooterTail("tps", "42/tps")
    sched.start()
    await clock.tick(0)
    // Suffix rides inline right after the content; the tail follows with
    // the standard two-space gap.
    expect(sink.footerCalls.at(-1)).toEqual(["quota line  · ♻ sk-lsp  42/tps"])
    sched.stop()
  })
})

describe("LiveAreaScheduler — tail-only slot refresh", () => {
  it("REGRESSION: refreshOn re-paints tails even when the slot still returns null", async () => {
    const { EventBus } = await import("../../../plugins/event-bus.ts")
    const bus = new EventBus(() => {})
    let tail = ""
    const quota = makeSlot({
      id: "quota",
      pluginId: "quota-status",
      position: "footer",
      refreshMs: 60_000,
      invoke: async () => "quota line",
    })
    const tps = makeSlot({
      id: "tps",
      pluginId: "tps",
      position: "footer",
      refreshMs: 60_000,
      invoke: async (ctx) => {
        ctx.setFooterTail?.(tail)
        return null
      },
    })
    tps.definition.placeholder = ""
    tps.definition.refreshOn = ["llm.outputDelta"]
    const clock = new FakeClock()
    const sink = makeSink()
    const sched = new LiveAreaScheduler([quota, tps], sink, {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      bus,
      logger: () => {},
    })
    sched.start()
    await clock.tick(0)
    expect(sink.footerCalls.at(-1)).toEqual(["quota line"])
    tail = "28/tps"
    bus.emit("llm.outputDelta", { deltaTokens: 10 })
    await clock.tick(0)
    expect(sink.footerCalls.at(-1)).toEqual(["quota line  28/tps"])
    sched.stop()
  })
})
