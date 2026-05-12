import { describe, expect, it } from "bun:test"
import type { Spinner } from "./spinner.ts"
import { BlinkingNerdSpinner, SpinnerManager } from "./spinner.ts"
import { displayWidth } from "./term-width.ts"

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
  it("blinks (color on-frame, whitespace off-frame) and maps icon by notification id", () => {
    const spinner = new BlinkingNerdSpinner({
      blinkMs: 300,
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

    // On-step: the active palette colorizer wraps the spec.
    expect(onFrame.glyph).toBe("C:NET")
    // Off-step: whitespace of equivalent display width. "NET" is 3
    // ASCII cells → 3 spaces.
    expect(offFrame.glyph).toBe("   ")
    expect(onFrame2.glyph).toBe("C:NET")
  })

  it("cycles palette in declared order across on-frames (color1 → blank → color2 → blank → …)", () => {
    // Regression for the bug where `palette[step % len]` advanced the
    // color on EVERY frame (on-step and off-step alike), so on-frames
    // only ever saw even-indexed entries — a 5-color palette became
    // [c0, blank, c2, blank, c4, blank, c1, blank, c3, blank, …]. The
    // fix uses Math.floor(step / 2) for the color index so successive
    // on-frames walk c0, c1, c2, … in order.
    const spinner = new BlinkingNerdSpinner({
      blinkMs: 100,
      iconByNotificationId: { "x.test": "X" },
      // Easy-to-distinguish palette tags so the cycle order is obvious.
      colorizers: [(t) => `c0:${t}`, (t) => `c1:${t}`, (t) => `c2:${t}`, (t) => `c3:${t}`],
    })
    const base = {
      now: 0,
      startedAt: 0,
      maxFps: 30,
      currentFps: 30,
      theme: {},
      notification: { notificationId: "x.test" },
    }
    // True blink: off-step is whitespace of equivalent display width.
    // "X" is 1 ASCII cell → 1 space.
    const blank = " "
    // 8 on/off pairs = full 4-color cycle + first color of next cycle.
    const sequence = Array.from(
      { length: 10 },
      (_, i) => spinner.render({ ...base, elapsedMs: i * 100 }).glyph,
    )
    expect(sequence).toEqual([
      "c0:X", // step 0: on, color 0
      blank, // step 1: blank
      "c1:X", // step 2: on, color 1 (was "c2:X" before fix — the bug)
      blank, // step 3: blank
      "c2:X", // step 4: on, color 2
      blank, // step 5: blank
      "c3:X", // step 6: on, color 3 (last in palette)
      blank, // step 7: blank
      "c0:X", // step 8: wrap to color 0
      blank, // step 9: blank
    ])
  })

  it("on-step and off-step have IDENTICAL display width (no jiggle)", () => {
    // Cover the three icon-width regimes. "NET" is 3 ASCII cells,
    // "●" is 1 cell, "\u{F1064}" is the 󱁤 nf-md-tools PUA glyph.
    // On-step renders the colorized glyph; off-step renders whitespace
    // of equivalent display width. The cell count must match.
    const cases: Array<{ name: string; spec: string }> = [
      { name: "ASCII multi-char", spec: "NET" },
      { name: "narrow Unicode", spec: "\u{25CF}" }, // ●
      { name: "Nerd Font PUA", spec: "\u{F1064}" }, // 󱁤
    ]
    for (const { name, spec } of cases) {
      const spinner = new BlinkingNerdSpinner({
        blinkMs: 300,
        iconByNotificationId: { "x.test": spec },
      })
      const base = {
        now: 0,
        startedAt: 0,
        maxFps: 30,
        currentFps: 30,
        theme: {},
        notification: { notificationId: "x.test" },
      }
      const onFrame = spinner.render({ ...base, elapsedMs: 0 })
      const offFrame = spinner.render({ ...base, elapsedMs: 300 })
      // Compare display widths — `displayWidth` strips SGRs and sums
      // codepoint widths via the same table the rest of the agent uses
      // for column tracking. On-frame and off-frame must occupy the
      // same number of cells so the label column does not jiggle.
      expect({ name, on: displayWidth(onFrame.glyph), off: displayWidth(offFrame.glyph) }).toEqual({
        name,
        on: displayWidth(spec),
        off: displayWidth(spec),
      })
    }
  })
})
