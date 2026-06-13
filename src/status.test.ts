import { describe, expect, it } from "bun:test"

import type { Spinner } from "./spinner.ts"
import {
  formatActivityInfix,
  formatElapsed,
  formatElapsedSuffix,
  STALL_THRESHOLD_MS,
  type StatusActivity,
  StatusBus,
  StatusRenderer,
} from "./status.ts"
import { stripAnsi } from "./term-width.ts"

class FakeTTYOutput {
  isTTY = true
  /** Terminal width; undefined = no clamp (matches a non-sized stream). */
  columns?: number
  readonly chunks: string[] = []

  constructor(columns?: number) {
    this.columns = columns
  }

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk))
    return true
  }

  text(): string {
    return this.chunks.join("")
  }
}

describe("status", () => {
  it("publishes the most recent active label and restores the previous one when cleared", () => {
    const bus = new StatusBus()
    const seen: Array<string | null> = []
    const unsubscribe = bus.subscribe((label) => {
      seen.push(label)
    })

    const outer = bus.create("Thinking")
    const inner = bus.create("Running Bash")
    inner.clear()
    outer.clear()
    unsubscribe()

    expect(seen).toEqual([null, "Thinking", "Running Bash", "Thinking", null])
  })

  it("renders, updates, clears, suspends, and resumes the spinner line", () => {
    const bus = new StatusBus()
    const output = new FakeTTYOutput()
    const renderer = new StatusRenderer(bus, output, 0)

    renderer.start()

    const handle = bus.create("Thinking")
    expect(output.text()).toContain("Thinking")

    handle.update("Streaming response")
    expect(output.text()).toContain("Streaming response")

    renderer.suspend()
    expect(output.chunks.at(-1)).toBe("\r\x1b[2K")

    renderer.resume()
    expect(output.text()).toContain("Streaming response")

    handle.clear()
    expect(output.chunks.at(-1)).toBe("\r\x1b[2K")

    renderer.stop()
  })

  it("keeps spinner animation continuity across label updates", () => {
    const bus = new StatusBus()
    const output = new FakeTTYOutput()
    let now = 0

    const spinner: Spinner = {
      preferredFps: 10,
      render: (context) => ({
        glyph: String(Math.floor(context.elapsedMs / 100)),
      }),
    }
    const renderer = new StatusRenderer(bus, output, {
      maxFps: 0,
      spinner,
      now: () => now,
    })

    renderer.start()
    const handle = bus.create("Thinking")
    expect(output.chunks.at(-1)).toContain("0")

    now = 250
    handle.update("Streaming response")
    expect(output.chunks.at(-1)).toContain("2")
    expect(output.chunks.at(-1)).toContain("Streaming response")

    handle.clear()
    renderer.stop()
  })

  it("maps spinner context from notification id/category metadata", () => {
    const bus = new StatusBus()
    const output = new FakeTTYOutput()

    const spinner: Spinner = {
      render: (context) => ({
        glyph: `${context.notification.notificationId ?? "none"}:${context.notification.category ?? "none"}`,
      }),
    }
    const renderer = new StatusRenderer(bus, output, {
      maxFps: 0,
      spinner,
    })

    renderer.start()
    const handle = bus.create("Sending request", {
      notificationId: "network.request",
      category: "network",
    })
    expect(output.chunks.at(-1)).toContain("network.request:network")

    handle.update("Running Bash", {
      notificationId: "tool.running",
      category: "tool",
    })
    expect(output.chunks.at(-1)).toContain("tool.running:tool")

    handle.clear()
    renderer.stop()
  })

  describe("activity payload (structured)", () => {
    it("snapshots an initial activity passed via create()", () => {
      const bus = new StatusBus()
      const handle = bus.create("Sending", {
        notificationId: "network.request",
        category: "network",
        activity: {
          direction: "up",
          phase: "upload",
          sentBytes: 47_312,
          sentTokens: 124_000,
          target: { host: "api.anthropic.com", protocol: "h2", model: "opus-4-7" },
          startedAt: 1_000,
        },
      })

      const snap = bus.currentStatus()
      expect(snap?.label).toBe("Sending")
      expect(snap?.activity?.phase).toBe("upload")
      expect(snap?.activity?.direction).toBe("up")
      expect(snap?.activity?.sentBytes).toBe(47_312)
      expect(snap?.activity?.target).toEqual({
        host: "api.anthropic.com",
        protocol: "h2",
        model: "opus-4-7",
      })

      handle.clear()
    })

    it("merges activity field-by-field on update() (undefined keeps prior)", () => {
      const bus = new StatusBus()
      const handle = bus.create("Sending", {
        activity: {
          phase: "upload",
          sentBytes: 1_000,
          target: { host: "api.anthropic.com" },
        },
      })

      handle.update("Streaming", { activity: { phase: "stream", recvBytes: 512 } })

      const snap = bus.currentStatus()
      expect(snap?.label).toBe("Streaming")
      expect(snap?.activity?.phase).toBe("stream")
      expect(snap?.activity?.sentBytes).toBe(1_000) // preserved
      expect(snap?.activity?.recvBytes).toBe(512) // new
      expect(snap?.activity?.target?.host).toBe("api.anthropic.com") // preserved

      handle.clear()
    })

    it("merges target sub-object instead of replacing", () => {
      const bus = new StatusBus()
      const handle = bus.create("Sending", {
        activity: { target: { host: "api.anthropic.com", protocol: "h2" } },
      })

      // Only model changes; host + protocol must survive.
      handle.updateActivity({ target: { model: "opus-4-7[1m]" } })

      const snap = bus.currentStatus()
      expect(snap?.activity?.target).toEqual({
        host: "api.anthropic.com",
        protocol: "h2",
        model: "opus-4-7[1m]",
      })

      handle.clear()
    })

    it("updateActivity() does not change the label", () => {
      const bus = new StatusBus()
      const handle = bus.create("Sending", { activity: { phase: "upload" } })

      const seen: Array<string | null> = []
      const unsub = bus.subscribe((label) => seen.push(label))

      handle.updateActivity({ sentBytes: 4096 })
      handle.updateActivity({ sentBytes: 8192 })

      // Listener was invoked on subscribe + two activity updates.
      // Label stayed "Sending" throughout (no change).
      expect(seen).toEqual(["Sending", "Sending", "Sending"])
      expect(bus.currentStatus()?.activity?.sentBytes).toBe(8192)

      unsub()
      handle.clear()
    })

    it("listeners still receive label-only payloads (no breaking change)", () => {
      const bus = new StatusBus()
      const seen: Array<string | null> = []
      const unsub = bus.subscribe((label) => seen.push(label))

      const handle = bus.create("Sending", {
        activity: { phase: "upload", sentBytes: 1024 },
      })
      handle.update("Streaming", { activity: { phase: "stream" } })
      handle.clear()

      expect(seen).toEqual([null, "Sending", "Streaming", null])
      unsub()
    })

    it("clear() removes the activity along with the entry", () => {
      const bus = new StatusBus()
      const handle = bus.create("Sending", { activity: { phase: "upload" } })
      expect(bus.currentStatus()?.activity?.phase).toBe("upload")

      handle.clear()
      expect(bus.currentStatus()).toBeNull()
    })

    it("snapshot is a copy, not a live reference", () => {
      const bus = new StatusBus()
      const handle = bus.create("Sending", { activity: { sentBytes: 100 } })

      const snap = bus.currentStatus()
      handle.updateActivity({ sentBytes: 200 })

      // First snapshot must remain at 100 (not mutated by the later update).
      expect(snap?.activity?.sentBytes).toBe(100)
      expect(bus.currentStatus()?.activity?.sentBytes).toBe(200)

      handle.clear()
    })

    it("update() without activity in metadata does not erase existing activity", () => {
      const bus = new StatusBus()
      const handle = bus.create("Sending", {
        activity: { phase: "upload", sentBytes: 1024 },
      })

      // Caller only changes notificationId — activity stays.
      handle.update("Waiting", { notificationId: "network.request" })

      const snap = bus.currentStatus()
      expect(snap?.label).toBe("Waiting")
      expect(snap?.activity?.phase).toBe("upload")
      expect(snap?.activity?.sentBytes).toBe(1024)

      handle.clear()
    })

    it("type smoke: StatusActivity fields are all optional", () => {
      // Compile-time check that an empty object is a valid activity.
      const a: StatusActivity = {}
      expect(a).toEqual({})
    })
  })

  describe("StatusSnapshot.id", () => {
    it("exposes the entry id and increments per create()", () => {
      const bus = new StatusBus()
      const a = bus.create("first")
      const id1 = bus.currentStatus()?.id
      expect(typeof id1).toBe("number")

      a.clear()
      expect(bus.currentStatus()).toBeNull()

      bus.create("second")
      const id2 = bus.currentStatus()?.id
      expect(typeof id2).toBe("number")
      expect(id2).not.toBe(id1)
    })

    it("preserves id across handle.update() on the same entry", () => {
      const bus = new StatusBus()
      const handle = bus.create("Thinking")
      const id1 = bus.currentStatus()?.id
      handle.update("Writing response")
      const id2 = bus.currentStatus()?.id
      expect(id2).toBe(id1)
    })

    it("a second `create()` while the first is alive returns a different id", () => {
      // Two consecutive `Running Bash` tools both push their own
      // entry. Both share the same human label but each gets its own
      // id, so a renderer can reset per-status timers on the second
      // dispatch.
      const bus = new StatusBus()
      bus.create("Running Bash")
      const idA = bus.currentStatus()?.id
      bus.create("Running Bash")
      const idB = bus.currentStatus()?.id
      expect(idA).toBeDefined()
      expect(idB).toBeDefined()
      expect(idB).not.toBe(idA)
    })
  })
})

describe("StatusRenderer elapsed suffix", () => {
  // Helper rig: deterministic now() and a maxFps:0 renderer so paints
  // happen only on bus events. The label is already wrapped in
  // `\x1b[2m...\x1b[22m` by the renderer (legacy line-mode dims the
  // whole label), and our suffix adds its own `\x1b[2m(Xs)\x1b[22m`
  // -- so the assertion is on the suffix bytes appearing in the
  // chunk's tail.
  function makeRig() {
    const bus = new StatusBus()
    const output = new FakeTTYOutput()
    let now = 1_000_000
    const renderer = new StatusRenderer(bus, output, {
      maxFps: 0,
      spinner: { render: () => ({ glyph: "" }) },
      now: () => now,
    })
    renderer.start()
    return {
      bus,
      output,
      renderer,
      advance: (deltaMs: number) => {
        now += deltaMs
      },
    }
  }

  it("no suffix at t=0 (sub-1s)", () => {
    const { bus, output, renderer } = makeRig()
    bus.create("Thinking")
    const last = output.chunks.at(-1)!
    expect(last.includes("\x1b[2m(")).toBe(false)
    renderer.stop()
  })

  it("appends faint `(2s)` after 2s on the same handle", () => {
    const { bus, output, renderer, advance } = makeRig()
    const handle = bus.create("Thinking")
    advance(2_100)
    handle.update("Thinking")
    const last = output.chunks.at(-1)!
    expect(last.endsWith(" \x1b[2m(2s)\x1b[22m")).toBe(true)
    renderer.stop()
  })

  it("resets the timer when a new bus.create() is made (different id, same label)", () => {
    const { bus, output, renderer, advance } = makeRig()
    const first = bus.create("Running Bash")
    advance(5_000)
    first.update("Running Bash")
    expect(output.chunks.at(-1)!.endsWith(" \x1b[2m(5s)\x1b[22m")).toBe(true)
    first.clear()

    bus.create("Running Bash") // new id
    const last = output.chunks.at(-1)!
    expect(last.includes("\x1b[2m(")).toBe(false)
    renderer.stop()
  })

  it("preserves the timer across update() with a different label (phase transition)", () => {
    const { bus, output, renderer, advance } = makeRig()
    const handle = bus.create("Sending")
    advance(3_500)
    handle.update("Receiving stream")
    expect(output.chunks.at(-1)!.endsWith(" \x1b[2m(3s)\x1b[22m")).toBe(true)
    advance(2_500)
    handle.update("Thinking")
    expect(output.chunks.at(-1)!.endsWith(" \x1b[2m(6s)\x1b[22m")).toBe(true)
    renderer.stop()
  })
})

describe("formatElapsed", () => {
  it("< 60s renders as `<n>s`", () => {
    expect(formatElapsed(0)).toBe("0s")
    expect(formatElapsed(999)).toBe("0s") // sub-second floors to 0
    expect(formatElapsed(1_000)).toBe("1s")
    expect(formatElapsed(2_400)).toBe("2s") // floor, not round
    expect(formatElapsed(59_000)).toBe("59s")
    expect(formatElapsed(59_999)).toBe("59s")
  })

  it("60s..3599s renders as `<m>m <s>s`", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s")
    expect(formatElapsed(62_000)).toBe("1m 2s")
    expect(formatElapsed(125_000)).toBe("2m 5s")
    expect(formatElapsed(3_599_000)).toBe("59m 59s")
  })

  it(">= 3600s renders as `<h>h <m>m` (seconds dropped)", () => {
    expect(formatElapsed(3_600_000)).toBe("1h 0m")
    expect(formatElapsed(3_660_000)).toBe("1h 1m")
    expect(formatElapsed(7_320_000)).toBe("2h 2m")
  })

  it("clamps negative/NaN/Infinity inputs to 0s", () => {
    expect(formatElapsed(-1)).toBe("0s")
    expect(formatElapsed(Number.NaN)).toBe("0s")
    expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe("0s")
  })
})

describe("formatElapsedSuffix", () => {
  it("returns empty string below the 1s threshold", () => {
    expect(formatElapsedSuffix(0)).toBe("")
    expect(formatElapsedSuffix(999)).toBe("")
    expect(formatElapsedSuffix(-5)).toBe("")
    expect(formatElapsedSuffix(Number.NaN)).toBe("")
  })

  it("wraps the elapsed in faint SGR codes with a leading space and parens", () => {
    // Shape: " " + "\x1b[2m" + "(<elapsed>)" + "\x1b[22m"
    expect(formatElapsedSuffix(1_500)).toBe(" \x1b[2m(1s)\x1b[22m")
    expect(formatElapsedSuffix(62_000)).toBe(" \x1b[2m(1m 2s)\x1b[22m")
    expect(formatElapsedSuffix(3_660_000)).toBe(" \x1b[2m(1h 1m)\x1b[22m")
  })

  it("concatenates with a plain label to form a renderable status line", () => {
    expect(`Thinking${formatElapsedSuffix(2_000)}`).toBe("Thinking \x1b[2m(2s)\x1b[22m")
    expect(`Running Bash${formatElapsedSuffix(62_000)}`).toBe("Running Bash \x1b[2m(1m 2s)\x1b[22m")
  })
})

describe("formatActivityInfix", () => {
  // Most assertions use stripAnsi() to keep the test pinned to visible
  // content, not the exact SGR opcodes. A few targeted color assertions
  // pin the arrow's foreground (sky / lime / gold) directly, since the
  // color IS user-visible state — the rest of the row stays color-agnostic.

  const NOW = 100_000

  it("returns empty string when activity is undefined", () => {
    expect(formatActivityInfix(undefined)).toBe("")
  })

  it("returns empty string for an empty activity object (no direction, no bytes)", () => {
    // No data to render → no infix. Without the early-out we'd render
    // ` · ` (the idle dot alone) which adds visual noise to every status
    // that doesn't publish activity.
    const got = formatActivityInfix({})
    // Idle dot with no segments is fine (just the arrow on its own).
    // What we MUST NOT see is the segment separator ` · ` since segs=[].
    expect(stripAnsi(got)).toBe(" ·")
  })

  it("renders ↑ (sky) + bytes for an upload-direction activity", () => {
    const a: StatusActivity = { direction: "up", sentBytes: 48_456 }
    const out = formatActivityInfix(a)
    expect(stripAnsi(out)).toBe(" ↑ 47.3 KB")
    expect(out).toContain("\x1b[38;5;45m↑\x1b[39m") // sky arrow
    expect(out).toContain("47.3 KB")
  })

  it("renders ↓ (lime) + bytes for a download-direction activity", () => {
    const a: StatusActivity = { direction: "down", recvBytes: 12_700 }
    const out = formatActivityInfix(a)
    expect(stripAnsi(out)).toBe(" ↓ 12.4 KB")
    expect(out).toContain("\x1b[38;5;118m↓\x1b[39m") // lime arrow
  })

  it("renders idle dot (dim) when direction is omitted but other fields present", () => {
    const a: StatusActivity = { recvBytes: 512 }
    const out = formatActivityInfix(a)
    expect(stripAnsi(out)).toBe(" · 512 B")
    expect(out).toContain("\x1b[2m·\x1b[22m") // dim dot
  })

  it("appends tokens segment with ~ prefix (estimate marker)", () => {
    const a: StatusActivity = {
      direction: "down",
      recvBytes: 4_096,
      recvTokens: 215,
    }
    const out = formatActivityInfix(a)
    expect(stripAnsi(out)).toBe(" ↓ 4.0 KB · ~215 tok")
  })

  it("renders tokens with k suffix at >=1k", () => {
    const a: StatusActivity = { direction: "down", recvTokens: 1_500 }
    const out = formatActivityInfix(a)
    expect(stripAnsi(out)).toContain("~1.5k tok")
  })

  it("includes target host:proto as the lowest-priority segment", () => {
    const a: StatusActivity = {
      direction: "down",
      recvBytes: 4_096,
      target: { host: "api.anthropic.com", protocol: "h2" },
    }
    const out = formatActivityInfix(a)
    expect(stripAnsi(out)).toBe(" ↓ 4.0 KB · api.anthropic.com:h2")
  })

  it("renders host alone when protocol is missing", () => {
    const a: StatusActivity = {
      direction: "down",
      recvBytes: 4_096,
      target: { host: "api.anthropic.com" },
    }
    expect(stripAnsi(formatActivityInfix(a))).toBe(" ↓ 4.0 KB · api.anthropic.com")
  })

  it("computes tok/s rate when entryStartedAt and tokens are present", () => {
    const a: StatusActivity = { direction: "down", recvTokens: 168, recvBytes: 4_096 }
    const out = formatActivityInfix(a, {
      now: NOW,
      entryStartedAt: NOW - 2_000, // 2 seconds elapsed → 84 tok/s
    })
    expect(stripAnsi(out)).toContain("84 tok/s")
  })

  it("falls back to B/s or KB/s rate when no token signal", () => {
    const a: StatusActivity = { direction: "down", recvBytes: 2_048 }
    const out = formatActivityInfix(a, {
      now: NOW,
      entryStartedAt: NOW - 1_000, // 1 second elapsed → 2.0 KB/s
    })
    expect(stripAnsi(out)).toContain("2.0 KB/s")
  })

  it("suppresses rate segment when elapsed < 500ms (noisy)", () => {
    const a: StatusActivity = { direction: "down", recvBytes: 2_048 }
    const out = formatActivityInfix(a, {
      now: NOW,
      entryStartedAt: NOW - 200, // 200ms elapsed
    })
    expect(stripAnsi(out)).not.toContain("KB/s")
    expect(stripAnsi(out)).not.toContain("B/s")
  })

  it("hideBytes:true suppresses the bytes segment (when label already shows them)", () => {
    // Today's `Calling Write: streaming input (10 B)` pattern from
    // client.ts already shows bytes in the label — render the rest of
    // the infix without re-rendering bytes.
    const a: StatusActivity = {
      direction: "down",
      recvBytes: 12_700,
      target: { host: "api.anthropic.com", protocol: "h2" },
    }
    const out = formatActivityInfix(a, { hideBytes: true })
    expect(stripAnsi(out)).toBe(" ↓ api.anthropic.com:h2")
    expect(stripAnsi(out)).not.toContain("KB")
  })

  it("drops trailing segments right-to-left to fit maxWidth", () => {
    const a: StatusActivity = {
      direction: "down",
      recvBytes: 12_700,
      recvTokens: 215,
      target: { host: "api.anthropic.com", protocol: "h2" },
    }
    // Full width: ` ↓ 12.4 KB · ~215 tok · api.anthropic.com:h2` ≈ 45 cells.
    // Capping at 25 must drop host first, then maybe tokens.
    const out = formatActivityInfix(a, { maxWidth: 25 })
    const plain = stripAnsi(out)
    expect(plain).not.toContain("api.anthropic.com") // host dropped first
    expect(plain).toContain("12.4 KB") // bytes survive (highest priority)
  })

  it("drops everything but the arrow at very narrow maxWidth", () => {
    const a: StatusActivity = {
      direction: "down",
      recvBytes: 12_700,
      recvTokens: 215,
    }
    const out = formatActivityInfix(a, { maxWidth: 3 })
    // Just ` ↓` (3 cells: space, arrow, end)
    expect(stripAnsi(out)).toBe(" ↓")
  })

  it("returns empty string when even the arrow exceeds maxWidth", () => {
    const a: StatusActivity = { direction: "down", recvBytes: 100 }
    // maxWidth of 1 can't fit even ` ↓`
    expect(formatActivityInfix(a, { maxWidth: 1 })).toBe("")
  })

  it("rate uses tokens-per-second when both bytes and tokens are present (tokens win)", () => {
    const a: StatusActivity = { direction: "down", recvBytes: 8_192, recvTokens: 200 }
    const out = formatActivityInfix(a, { now: NOW, entryStartedAt: NOW - 2_000 })
    // 200 / 2 = 100 tok/s. NOT 4096 B/s. The rate prefers the more
    // human-meaningful counter.
    const plain = stripAnsi(out)
    expect(plain).toContain("100 tok/s")
    expect(plain).not.toContain("KB/s")
  })

  it("rate decimal for sub-10 tok/s readings (prevents '0 tok/s' rounding)", () => {
    const a: StatusActivity = { direction: "down", recvTokens: 6, recvBytes: 200 }
    const out = formatActivityInfix(a, { now: NOW, entryStartedAt: NOW - 2_000 })
    // 6 / 2 = 3.0 tok/s — must render with one decimal so the user
    // sees movement even at very slow rates.
    expect(stripAnsi(out)).toContain("3.0 tok/s")
  })

  it("STALL_THRESHOLD_MS is exported and reasonable (1-5s range)", () => {
    expect(STALL_THRESHOLD_MS).toBeGreaterThanOrEqual(1_000)
    expect(STALL_THRESHOLD_MS).toBeLessThanOrEqual(5_000)
  })

  it("upload-direction picks sentTokens not recvTokens for the tokens segment", () => {
    const a: StatusActivity = {
      direction: "up",
      sentBytes: 47_312,
      sentTokens: 11_800,
      recvTokens: 999, // should NOT appear (wrong direction)
    }
    const out = formatActivityInfix(a)
    expect(stripAnsi(out)).toContain("~11.8k tok")
    expect(stripAnsi(out)).not.toContain("999")
  })

  describe("stalled detector", () => {
    // The biggest UX win of Layer 3: the row flips to amber ⋯ stalled
    // when the wire goes silent for >2s. Before this, "Calling Write:
    // streaming input (10 B) (30s)" looked identical at 2s and at 30s —
    // user had no way to tell if the model was slow or genuinely hung.

    it("flips to ⋯ stalled (gold) when no chunk for >STALL_THRESHOLD_MS", () => {
      const NOW = 100_000
      const a: StatusActivity = {
        direction: "down",
        recvBytes: 10,
        lastChunkAt: NOW - STALL_THRESHOLD_MS - 500, // 2.5s ago
      }
      const out = formatActivityInfix(a, { now: NOW })
      const plain = stripAnsi(out)
      expect(plain).toContain("⋯ stalled")
      expect(plain).toContain("last byte 2s ago")
      expect(out).toContain("\x1b[38;5;214m") // gold SGR open
      // The arrow should NOT be the green ↓ — stalled wins over direction.
      expect(out).not.toContain("\x1b[38;5;118m↓")
    })

    it("stays in ↓ (lime) form when chunks are still arriving within threshold", () => {
      const NOW = 100_000
      const a: StatusActivity = {
        direction: "down",
        recvBytes: 10_000,
        lastChunkAt: NOW - 500, // 500ms ago, well below 2s
      }
      const out = formatActivityInfix(a, { now: NOW })
      expect(out).toContain("\x1b[38;5;118m↓\x1b[39m") // lime arrow
      expect(stripAnsi(out)).not.toContain("⋯ stalled")
      expect(stripAnsi(out)).not.toContain("last byte")
    })

    it("does NOT trigger stall when direction is 'up' (uploads can pause legitimately)", () => {
      // Uploads can pause for backpressure, large form bodies, etc. Only
      // download stalls are user-actionable ("model went silent"), so the
      // amber form is gated on direction="down".
      const NOW = 100_000
      const a: StatusActivity = {
        direction: "up",
        sentBytes: 1_000,
        lastChunkAt: NOW - 5_000, // 5s ago
      }
      const out = formatActivityInfix(a, { now: NOW })
      expect(stripAnsi(out)).not.toContain("⋯ stalled")
      expect(out).toContain("\x1b[38;5;45m↑\x1b[39m") // sky arrow stays
    })

    it("does NOT trigger stall when lastChunkAt is undefined (no chunk seen yet)", () => {
      const a: StatusActivity = {
        direction: "down",
        recvBytes: 0,
        // lastChunkAt omitted — TTFB phase, no chunks yet
      }
      const out = formatActivityInfix(a, { now: 100_000 })
      expect(stripAnsi(out)).not.toContain("⋯ stalled")
    })

    it("custom stallThresholdMs is honored", () => {
      const NOW = 100_000
      const a: StatusActivity = {
        direction: "down",
        recvBytes: 10,
        lastChunkAt: NOW - 800, // 800ms ago
      }
      // With a 500ms threshold, this IS stalled.
      const out = formatActivityInfix(a, { now: NOW, stallThresholdMs: 500 })
      expect(stripAnsi(out)).toContain("⋯ stalled")
    })

    it("renders stalled WITH the bytes segment so the user sees the total transferred", () => {
      // The bytes segment isn't dropped when stalled — knowing "10 B
      // total before silence" is the actionable signal that lets the
      // user decide whether to wait or abort.
      const NOW = 100_000
      const a: StatusActivity = {
        direction: "down",
        recvBytes: 10,
        lastChunkAt: NOW - 30_000, // 30s ago — matches the user's screenshot
        target: { host: "api.anthropic.com" },
      }
      const out = formatActivityInfix(a, { now: NOW })
      const plain = stripAnsi(out)
      expect(plain).toContain("⋯ stalled")
      expect(plain).toContain("last byte 30s ago")
      expect(plain).toContain("10 B") // the "total" survives
    })

    it("stalled clamps 'last byte 0s ago' to 1s minimum (no flicker on sub-second)", () => {
      // If the threshold is custom-set to 0ms and lastChunkAt was 1ms
      // ago, Math.floor would round to 0s. The clamp prevents the
      // visually ugly "last byte 0s ago" string.
      const NOW = 100_000
      const a: StatusActivity = {
        direction: "down",
        recvBytes: 10,
        lastChunkAt: NOW - 100,
      }
      const out = formatActivityInfix(a, { now: NOW, stallThresholdMs: 50 })
      expect(stripAnsi(out)).toContain("last byte 1s ago")
      expect(stripAnsi(out)).not.toContain("last byte 0s")
    })
  })
})

describe("LiveAreaStatusController + StatusRenderer infix wiring", () => {
  // Two end-to-end smoke tests pinning that the renderer reads the
  // activity off the bus AND that the LABEL_BYTES_RE suppresses the
  // bytes segment when the label already shows a trailing `(N <unit>)`.

  it("StatusRenderer renders the infix when activity is attached to the entry", () => {
    const bus = new StatusBus()
    const output = new FakeTTYOutput()
    const renderer = new StatusRenderer(bus, output, {
      maxFps: 0, // no timer
      spinner: { render: () => ({ glyph: "●", fpsHint: 0 }) },
      now: () => 100_000,
    })
    renderer.start()
    const handle = bus.create("Receiving stream", {
      activity: { direction: "down", recvBytes: 4_096 },
    })
    const last = output.chunks.at(-1) ?? ""
    expect(stripAnsi(last)).toContain("Receiving stream")
    expect(stripAnsi(last)).toContain("↓ 4.0 KB")
    handle.clear()
    renderer.stop()
  })

  it("StatusRenderer hides the infix bytes segment when label ends with `(N B)`", () => {
    const bus = new StatusBus()
    const output = new FakeTTYOutput()
    const renderer = new StatusRenderer(bus, output, {
      maxFps: 0,
      spinner: { render: () => ({ glyph: "●", fpsHint: 0 }) },
      now: () => 100_000,
    })
    renderer.start()
    // Mirror client.ts's `Calling Write: streaming input (10 B)` shape.
    const handle = bus.create("Calling Write: streaming input (10 B)", {
      activity: {
        direction: "down",
        recvBytes: 12_700,
        target: { host: "api.anthropic.com" },
      },
    })
    const last = stripAnsi(output.chunks.at(-1) ?? "")
    expect(last).toContain("Calling Write: streaming input (10 B)")
    expect(last).toContain("api.anthropic.com") // host survives
    expect(last).not.toContain("12.4 KB") // bytes suppressed (would duplicate label)
    handle.clear()
    renderer.stop()
  })

  it("clamps the line to terminal width so it never wraps on a narrow term (B-073)", () => {
    const cols = 20
    const bus = new StatusBus()
    const output = new FakeTTYOutput(cols)
    const renderer = new StatusRenderer(bus, output, {
      maxFps: 0,
      spinner: { render: () => ({ glyph: "●", fpsHint: 0 }) },
      now: () => 100_000,
    })
    renderer.start()
    // Label far longer than 20 cells, plus an activity infix that would push
    // the composed line well past the row width.
    const handle = bus.create(
      "A very long status label that would overflow a narrow terminal row",
      { activity: { direction: "down", recvBytes: 4_096, target: { host: "api.anthropic.com" } } },
    )
    const last = output.chunks.at(-1) ?? ""
    // The visible (ANSI-stripped) body, minus the leading `\r\x1b[2K` control,
    // must fit within the column budget — i.e. it can never wrap to row 2.
    const visible = stripAnsi(last).replace(/^\r/, "")
    expect(visible.length).toBeLessThanOrEqual(cols)
    handle.clear()
    renderer.stop()
  })

  it("does NOT clamp when the stream reports no columns (pipe / non-sized)", () => {
    const bus = new StatusBus()
    const output = new FakeTTYOutput() // columns undefined
    const renderer = new StatusRenderer(bus, output, {
      maxFps: 0,
      spinner: { render: () => ({ glyph: "●", fpsHint: 0 }) },
      now: () => 100_000,
    })
    renderer.start()
    const longLabel = "A very long status label that would overflow a narrow terminal row"
    const handle = bus.create(longLabel)
    const last = stripAnsi(output.chunks.at(-1) ?? "")
    expect(last).toContain(longLabel) // full label preserved, no truncation
    handle.clear()
    renderer.stop()
  })
})
