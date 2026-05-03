import { describe, expect, it } from "bun:test"
import type { Spinner } from "./spinner.ts"
import { BlinkingNerdSpinner, SpinnerManager } from "./spinner.ts"

describe("SpinnerManager", () => {
  it("switches spinners after the negotiated grace window", () => {
    let now = 1_000
    const events: string[] = []

    const makeSpinner = (name: string, graceMs: number | false | undefined): Spinner => ({
      willShow: () => events.push(`${name}:willShow`),
      didShow: () => events.push(`${name}:didShow`),
      willDisappear: () => {
        events.push(`${name}:willDisappear`)
        return graceMs
      },
      didDisappear: () => events.push(`${name}:didDisappear`),
      render: () => ({ glyph: name }),
    })

    const a = makeSpinner("A", 50)
    const b = makeSpinner("B", undefined)
    const manager = new SpinnerManager({
      spinner: a,
      theme: {},
      now: () => now,
      maxSwitchGraceMs: 200,
    })

    manager.ensureMounted()
    expect(manager.render(30)?.glyph).toBe("A")

    manager.setSpinner(b, 100)
    now += 40
    expect(manager.render(30)?.glyph).toBe("A")

    now += 20
    expect(manager.render(30)?.glyph).toBe("B")
    expect(events).toEqual([
      "A:willShow",
      "A:didShow",
      "A:willDisappear",
      "A:didDisappear",
      "B:willShow",
      "B:didShow",
    ])
  })

  it("switches immediately when the current spinner refuses grace", () => {
    let now = 0
    const events: string[] = []

    const a: Spinner = {
      willShow: () => events.push("A:willShow"),
      didShow: () => events.push("A:didShow"),
      willDisappear: () => {
        events.push("A:willDisappear")
        return false
      },
      didDisappear: () => events.push("A:didDisappear"),
      render: () => ({ glyph: "A" }),
    }
    const b: Spinner = {
      willShow: () => events.push("B:willShow"),
      didShow: () => events.push("B:didShow"),
      render: () => ({ glyph: "B" }),
    }

    const manager = new SpinnerManager({
      spinner: a,
      theme: {},
      now: () => now,
    })
    manager.ensureMounted()
    manager.setSpinner(b, 100)

    expect(manager.render(30)?.glyph).toBe("B")
    expect(events).toEqual([
      "A:willShow",
      "A:didShow",
      "A:willDisappear",
      "A:didDisappear",
      "B:willShow",
      "B:didShow",
    ])
  })

  it("forwards theme changes to the mounted spinner", () => {
    let now = 0
    const seen: Array<{ previous: string; next: string }> = []

    const spinner: Spinner<{ name: string }> = {
      render: () => ({ glyph: "." }),
      onThemeChange: (context) => {
        seen.push({
          previous: context.previousTheme.name,
          next: context.nextTheme.name,
        })
      },
    }

    const manager = new SpinnerManager({
      spinner,
      theme: { name: "base" },
      now: () => now,
    })
    manager.ensureMounted()

    now = 5
    manager.setTheme({ name: "next" })

    expect(seen).toEqual([{ previous: "base", next: "next" }])
  })

  it("forwards notification changes to the mounted spinner", () => {
    let now = 0
    const seen: Array<{ previous?: string; next?: string }> = []

    const spinner: Spinner = {
      render: () => ({ glyph: "." }),
      onNotificationChange: (context) => {
        seen.push({
          previous: context.previousNotification.notificationId,
          next: context.nextNotification.notificationId,
        })
      },
    }

    const manager = new SpinnerManager({
      spinner,
      theme: {},
      now: () => now,
    })
    manager.ensureMounted()

    now = 1
    manager.setNotification({ notificationId: "network.request" })
    now = 2
    manager.setNotification({ notificationId: "network.request" })
    now = 3
    manager.setNotification({ notificationId: "tool.running" })

    expect(seen).toEqual([
      { previous: undefined, next: "network.request" },
      { previous: "network.request", next: "tool.running" },
    ])
  })
})

describe("BlinkingNerdSpinner", () => {
  it("blinks at 300ms and maps icon by notification id", () => {
    const spinner = new BlinkingNerdSpinner({
      iconByNotificationId: {
        "network.request": "NET",
      },
      colorizers: [(text) => `C:${text}`],
    })

    const base = {
      now: 0,
      startedAt: 0,
      maxFps: 30,
      currentFps: 30,
      theme: {},
      notification: { notificationId: "network.request" },
    }

    const onFrame = spinner.render({ ...base, elapsedMs: 0 })
    const offFrame = spinner.render({ ...base, elapsedMs: 300 })
    const onFrame2 = spinner.render({ ...base, elapsedMs: 600 })

    expect(onFrame.glyph).toBe("C:NET")
    // Off-frame pads to the on-glyph's display width so the label column
    // is stable across the blink cycle. "NET" is 3 cells wide.
    expect(offFrame.glyph).toBe("   ")
    expect(onFrame2.glyph).toBe("C:NET")
  })
})
