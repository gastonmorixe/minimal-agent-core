import { describe, expect, it } from "bun:test"
import { StatusBus, StatusRenderer, type StatusActivity } from "./status.ts"
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
})
