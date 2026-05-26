/**
 * Unit tests for `ScrollbackDiagnosticSink`.
 *
 * Coverage matrix (one block per behaviour, deterministic clock and
 * collector writer so we never depend on real stderr):
 *
 *   Rendering
 *     - Warning block: gold ⚠, source, timestamp, message in body, ╰ closer.
 *     - Error block:   red  ✗, identical shape with `error` word.
 *     - Structured-data renders as `dim(key):` value lines under message.
 *     - Multi-line message keeps gutter on every body row.
 *
 *   Severity gate
 *     - Notice / Info / Debug are NOT painted (file sink covers them).
 *
 *   Dedup
 *     - Same (severity, source, message) within window → compact `(×N)` line.
 *     - Different message from same source → new full block, count resets.
 *     - Window expiry → new full block, count resets.
 *     - Storm throttle: paints capped at `dedupRepaintMinMs` cadence.
 *
 *   Bus wiring
 *     - attach() subscribes, detach() unsubscribes (no double-handler).
 */

import { beforeEach, describe, expect, it } from "bun:test"

import { createDiagnosticBus, Facility, type LogEvent, Severity } from "./diagnostic-bus.ts"
import {
  formatScrollbackTs,
  renderBlock,
  ScrollbackDiagnosticSink,
  scrollbackSeverityChrome,
} from "./log-scrollback.ts"
import { PALETTE } from "./palette.ts"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 4, 20, 14, 56, 51, 0) // 2026-05-20T14:56:51.000Z

/**
 * Stable HH:MM:SS for assertions: we render in LOCAL time so this
 * mirrors what the sink will emit on the test machine (no TZ pin).
 */
function localTs(ms: number): string {
  return formatScrollbackTs(ms)
}

function event(over: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: T0,
    severity: Severity.Warning,
    facility: Facility.User,
    source: "api.stream-error",
    message: "overloaded_error: Overloaded",
    ...over,
  }
}

function makeWriter(): { write: (s: string) => void; calls: string[] } {
  const calls: string[] = []
  return {
    write: (s: string) => {
      calls.push(s)
    },
    calls,
  }
}

/** Strip ANSI SGR sequences for plain-text shape assertions. */
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "")
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("ScrollbackDiagnosticSink — rendering", () => {
  it("renders a warning block: gold ⚠, source, timestamp, ╰ closer", () => {
    const w = makeWriter()
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => T0,
    })
    sink.onEvent(event())
    expect(w.calls).toHaveLength(1)
    const painted = w.calls[0]
    expect(painted).toContain(PALETTE.gold)
    expect(painted).toContain("⚠")
    expect(painted).toContain("api.stream-error")
    expect(painted).toContain(localTs(T0))
    const plain = strip(painted)
    expect(plain).toContain("⚠ warn")
    // Single-line message → only one body row → uses ╰ directly (the
    // intermediate │ rows only appear when there are 2+ body rows).
    expect(plain).toContain("╰ overloaded_error: Overloaded")
    // Trailing newline appended by the sink (not the renderer)
    expect(painted.endsWith("\n")).toBe(true)
  })

  it("renders an error block: red ✗ with `error` word", () => {
    const w = makeWriter()
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => T0,
    })
    sink.onEvent(
      event({
        severity: Severity.Error,
        source: "auth.refresh",
        message: "invalid_grant: refresh token expired",
      }),
    )
    const painted = w.calls[0]
    expect(painted).toContain(PALETTE.red)
    expect(painted).toContain("✗")
    expect(strip(painted)).toContain("✗ error")
    expect(strip(painted)).toContain("auth.refresh")
  })

  it("renders structured-data as dim key: value rows under the message", () => {
    const w = makeWriter()
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => T0,
    })
    sink.onEvent(
      event({
        structuredData: {
          "error-type": "overloaded_error",
          "request-id": "req_011CbE1suHv2YRDRZuT4VAoC",
        },
      }),
    )
    const plain = strip(w.calls[0])
    expect(plain).toContain("│ overloaded_error: Overloaded")
    expect(plain).toContain("error-type:")
    expect(plain).toContain("overloaded_error")
    expect(plain).toContain("request-id:")
    expect(plain).toContain("req_011CbE1suHv2YRDRZuT4VAoC")
    // The very last body row uses ╰; everything before uses │.
    const lines = plain.split("\n").filter((l) => l.length > 0)
    expect(lines[lines.length - 1]).toMatch(/^  ╰ /)
    for (const l of lines.slice(1, -1)) {
      expect(l).toMatch(/^  │ /)
    }
  })

  it("keeps the gutter on every line of a multi-line message", () => {
    const w = makeWriter()
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => T0,
    })
    sink.onEvent(event({ message: "line one\nline two\nline three" }))
    const plain = strip(w.calls[0])
    expect(plain).toContain("│ line one")
    expect(plain).toContain("│ line two")
    expect(plain).toContain("╰ line three")
  })

  it("pure renderBlock matches the sink's output (modulo trailing newline)", () => {
    const e = event({
      structuredData: { "request-id": "req_abc" },
    })
    const direct = renderBlock(e)
    const w = makeWriter()
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => T0,
    })
    sink.onEvent(e)
    expect(w.calls[0]).toBe(`${direct}\n`)
  })

  it("severity chrome surface contract", () => {
    expect(scrollbackSeverityChrome(Severity.Warning).color).toBe(PALETTE.gold)
    expect(scrollbackSeverityChrome(Severity.Warning).icon).toBe("⚠")
    expect(scrollbackSeverityChrome(Severity.Error).color).toBe(PALETTE.red)
    expect(scrollbackSeverityChrome(Severity.Error).icon).toBe("✗")
    expect(scrollbackSeverityChrome(Severity.Critical).color).toBe(PALETTE.red)
    expect(scrollbackSeverityChrome(Severity.Alert).color).toBe(PALETTE.red)
    expect(scrollbackSeverityChrome(Severity.Emergency).color).toBe(PALETTE.red)
  })
})

// ---------------------------------------------------------------------------
// Severity gate
// ---------------------------------------------------------------------------

describe("ScrollbackDiagnosticSink — severity gate", () => {
  let writer: ReturnType<typeof makeWriter>
  let sink: ScrollbackDiagnosticSink
  beforeEach(() => {
    writer = makeWriter()
    sink = new ScrollbackDiagnosticSink({ write: writer.write, now: () => T0 })
  })

  it("paints Warning", () => {
    sink.onEvent(event({ severity: Severity.Warning }))
    expect(writer.calls).toHaveLength(1)
  })

  it("paints Error / Critical / Alert / Emergency", () => {
    sink.onEvent(event({ severity: Severity.Error }))
    sink.onEvent(event({ severity: Severity.Critical, source: "subsys.crit" }))
    sink.onEvent(event({ severity: Severity.Alert, source: "subsys.alert" }))
    sink.onEvent(event({ severity: Severity.Emergency, source: "subsys.em" }))
    expect(writer.calls).toHaveLength(4)
  })

  it("skips Notice / Info / Debug (file sink covers them)", () => {
    sink.onEvent(event({ severity: Severity.Notice }))
    sink.onEvent(event({ severity: Severity.Info }))
    sink.onEvent(event({ severity: Severity.Debug }))
    expect(writer.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Dedup window + storm throttle
// ---------------------------------------------------------------------------

describe("ScrollbackDiagnosticSink — dedup", () => {
  it("same tuple within window collapses to compact (×N) line", () => {
    const w = makeWriter()
    let nowMs = T0
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => nowMs,
      dedupRepaintMinMs: 0, // no storm throttle — count every paint
    })
    sink.onEvent(event())
    nowMs = T0 + 1000
    sink.onEvent(event({ ts: nowMs }))
    nowMs = T0 + 2000
    sink.onEvent(event({ ts: nowMs }))
    expect(w.calls).toHaveLength(3)
    // First is the full block (has ╰); subsequent are compact lines.
    expect(strip(w.calls[0])).toContain("╰")
    expect(strip(w.calls[1])).toMatch(/⚠ warn .*api\.stream-error.*\(×2 · last/)
    expect(strip(w.calls[2])).toMatch(/⚠ warn .*api\.stream-error.*\(×3 · last/)
  })

  it("different message from same source re-arms with a new full block", () => {
    const w = makeWriter()
    let nowMs = T0
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => nowMs,
      dedupRepaintMinMs: 0,
    })
    sink.onEvent(event({ message: "first" }))
    nowMs = T0 + 100
    sink.onEvent(event({ message: "second" }))
    expect(w.calls).toHaveLength(2)
    // Both have ╰ → both rendered as full blocks (count reset).
    expect(strip(w.calls[0])).toContain("╰ first")
    expect(strip(w.calls[1])).toContain("╰ second")
  })

  it("window expiry → new full block, count resets", () => {
    const w = makeWriter()
    let nowMs = T0
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => nowMs,
      dedupWindowMs: 1000,
      dedupRepaintMinMs: 0,
    })
    sink.onEvent(event())
    nowMs = T0 + 2000 // past window
    sink.onEvent(event({ ts: nowMs }))
    expect(w.calls).toHaveLength(2)
    expect(strip(w.calls[0])).toContain("╰")
    expect(strip(w.calls[1])).toContain("╰")
  })

  it("storm throttle: many same-tuple events within minMs paint only once", () => {
    const w = makeWriter()
    let nowMs = T0
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => nowMs,
      dedupRepaintMinMs: 500,
    })
    sink.onEvent(event()) // full block — paint 1
    // 10 rapid duplicates all within 100ms — should NOT each paint
    for (let i = 0; i < 10; i++) {
      nowMs = T0 + 10 + i
      sink.onEvent(event({ ts: nowMs }))
    }
    // Crossing the 500ms cooldown bucket — one more paint
    nowMs = T0 + 600
    sink.onEvent(event({ ts: nowMs }))
    expect(w.calls).toHaveLength(2)
    // The single dedup line reflects the cumulative count (1 + 10 + 1 = 12)
    expect(strip(w.calls[1])).toMatch(/\(×12 · last /)
  })

  it("dedupWindowMs=0 disables dedup (every event is a full block)", () => {
    const w = makeWriter()
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => T0,
      dedupWindowMs: 0,
    })
    sink.onEvent(event())
    sink.onEvent(event())
    sink.onEvent(event())
    expect(w.calls).toHaveLength(3)
    for (const c of w.calls) expect(strip(c)).toContain("╰")
  })

  it("resetDedup() clears state — next event re-arms with a full block", () => {
    const w = makeWriter()
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => T0,
      dedupRepaintMinMs: 0,
    })
    sink.onEvent(event())
    sink.onEvent(event())
    expect(strip(w.calls[1])).toMatch(/\(×2/)
    sink.resetDedup()
    sink.onEvent(event())
    expect(strip(w.calls[2])).toContain("╰")
  })
})

// ---------------------------------------------------------------------------
// Bus wiring
// ---------------------------------------------------------------------------

describe("ScrollbackDiagnosticSink — bus wiring", () => {
  it("attach() subscribes; events flow; detach() stops them", () => {
    const w = makeWriter()
    const bus = createDiagnosticBus()
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => T0,
    })
    sink.attach(bus)
    bus.emit(event())
    expect(w.calls).toHaveLength(1)
    sink.detach()
    bus.emit(event({ message: "after-detach" }))
    expect(w.calls).toHaveLength(1)
  })

  it("attach() is idempotent (no double-handler)", () => {
    const w = makeWriter()
    const bus = createDiagnosticBus()
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => T0,
      dedupRepaintMinMs: 0,
    })
    sink.attach(bus)
    sink.attach(bus) // no-op
    bus.emit(event())
    // If we'd subscribed twice, the same event would have written twice
    // (one full block + one dedup line).
    expect(w.calls).toHaveLength(1)
  })

  it("bindWriter() rebinds the output target mid-life", () => {
    const w1 = makeWriter()
    const w2 = makeWriter()
    const sink = new ScrollbackDiagnosticSink({
      write: w1.write,
      now: () => T0,
    })
    sink.onEvent(event())
    expect(w1.calls).toHaveLength(1)
    expect(w2.calls).toHaveLength(0)
    sink.bindWriter(w2.write)
    sink.onEvent(event({ message: "after-rebind" }))
    expect(w1.calls).toHaveLength(1)
    expect(w2.calls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Startup-banner buffering
//
// Plugin-loader / auth / config warnings can fire mid-banner (the
// loader runs between the `term` row and the `tools` row). Without
// buffering, those renderings would tear through the `╭ │ │ ╰` box.
// `startBuffering()` queues renderings in memory; `flushBuffer()`
// drains them after `closeStartupTree()` commits the final `╰` row.
// ---------------------------------------------------------------------------

describe("ScrollbackDiagnosticSink — startup-banner buffering", () => {
  it("buffers renderings while active; flushBuffer drains in order", () => {
    const w = makeWriter()
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => T0,
    })
    sink.startBuffering()
    expect(sink.isBuffering()).toBe(true)
    sink.onEvent(event({ message: "first" }))
    sink.onEvent(event({ severity: Severity.Error, source: "x.b", message: "second" }))
    // Nothing written through yet.
    expect(w.calls).toHaveLength(0)
    sink.flushBuffer()
    expect(sink.isBuffering()).toBe(false)
    // Both blocks drained in order, preserving chrome.
    expect(w.calls).toHaveLength(2)
    expect(strip(w.calls[0]!)).toContain("╰ first")
    expect(strip(w.calls[1]!)).toContain("╰ second")
  })

  it("flushBuffer is a no-op when never buffering", () => {
    const w = makeWriter()
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => T0,
    })
    sink.onEvent(event())
    expect(w.calls).toHaveLength(1)
    sink.flushBuffer() // no-op
    expect(w.calls).toHaveLength(1)
  })

  it("startBuffering is idempotent (re-entry does not lose entries)", () => {
    const w = makeWriter()
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => T0,
    })
    sink.startBuffering()
    sink.onEvent(event({ message: "first" }))
    sink.startBuffering() // idempotent
    sink.onEvent(event({ severity: Severity.Error, source: "x.b", message: "second" }))
    sink.flushBuffer()
    expect(w.calls).toHaveLength(2)
  })

  it("after flushBuffer, subsequent events stream pass-through", () => {
    const w = makeWriter()
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => T0,
    })
    sink.startBuffering()
    sink.onEvent(event({ message: "buffered" }))
    sink.flushBuffer()
    expect(w.calls).toHaveLength(1)
    sink.onEvent(event({ severity: Severity.Error, source: "x.b", message: "live" }))
    expect(w.calls).toHaveLength(2)
    expect(strip(w.calls[1]!)).toContain("╰ live")
  })

  it("dedup paths also respect the buffer (storm during banner stays queued)", () => {
    const w = makeWriter()
    let nowMs = T0
    const sink = new ScrollbackDiagnosticSink({
      write: w.write,
      now: () => nowMs,
      dedupRepaintMinMs: 0,
    })
    sink.startBuffering()
    sink.onEvent(event()) // full block
    nowMs = T0 + 10
    sink.onEvent(event({ ts: nowMs })) // dedup (×2)
    nowMs = T0 + 20
    sink.onEvent(event({ ts: nowMs })) // dedup (×3)
    expect(w.calls).toHaveLength(0)
    sink.flushBuffer()
    expect(w.calls).toHaveLength(3)
    expect(strip(w.calls[0]!)).toContain("╰")
    expect(strip(w.calls[1]!)).toMatch(/\(×2/)
    expect(strip(w.calls[2]!)).toMatch(/\(×3/)
  })
})
