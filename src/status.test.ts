import { describe, expect, it } from "bun:test"
import { StatusBus, StatusRenderer } from "./status.ts"
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
})
