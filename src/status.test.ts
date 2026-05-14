import { describe, expect, it } from "bun:test"
import {
  formatElapsed,
  formatElapsedSuffix,
  StatusBus,
  StatusRenderer,
  type StatusActivity,
} from "./status.ts"
import type { Spinner } from "./spinner.ts"

class FakeTTYOutput {
  isTTY = true
  readonly chunks: string[] = []

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
