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
  it("pulses (same glyph, different SGR) at 300ms and maps icon by notification id", () => {
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

    // On-step: the active palette colorizer wraps the spec.
    expect(onFrame.glyph).toBe("C:NET")
    // Off-step: SAME glyph, wrapped in dim SGR (\x1b[2m...\x1b[22m).
    // The spec text is unchanged — only the SGR escape differs — so the
    // rendered cell width is byte-identical to the on-step regardless
    // of how the terminal interprets PUA / wide-char widths.
    expect(offFrame.glyph).toBe("\x1b[2mNET\x1b[22m")
    expect(onFrame2.glyph).toBe("C:NET")
  })

  it("on-step and off-step have IDENTICAL display width (no jiggle)", () => {
    // Cover the three icon-width regimes. "NET" is 3 ASCII cells,
    // "●" is 1 cell, "\u{F1064}" is the 󱁤 nf-md-tools PUA glyph (cell
    // width depends on the active font, BUT the on/off frames must
    // come out the same width regardless because they emit the same
    // codepoints).
    const cases: Array<{ name: string; spec: string }> = [
      { name: "ASCII multi-char", spec: "NET" },
      { name: "narrow Unicode", spec: "\u{25CF}" }, // ●
      { name: "Nerd Font PUA", spec: "\u{F1064}" }, // 󱁤
    ]
    for (const { name, spec } of cases) {
      const spinner = new BlinkingNerdSpinner({
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
      // Strip ALL SGR escapes from both frames; what remains must be
      // the same number of code points (≡ same rendered cell count
      // since the codepoints themselves are identical).
      const stripSgr = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")
      const onCps = Array.from(stripSgr(onFrame.glyph))
      const offCps = Array.from(stripSgr(offFrame.glyph))
      expect({ name, on: onCps, off: offCps }).toEqual({
        name,
        on: Array.from(spec),
        off: Array.from(spec),
      })
    }
  })
})
