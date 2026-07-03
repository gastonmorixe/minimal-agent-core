import { describe, expect, it } from "bun:test"

import { effectiveDisplayWidth } from "../../../terminal/nerd-glyph-width.ts"
import { displayWidth } from "../../../terminal/term-width.ts"

import type { Spinner } from "./index.ts"
import { BlinkingNerdSpinner, SpinnerManager } from "./index.ts"
import { THINKING_BREATHING, TOOL_SQUARE_PULSE } from "./library/frames.ts"
import {
  ICON_DOT_FILLED,
  ICON_PAUSE,
  ICON_SQUARE_BIG,
  ICON_SQUARE_SMALL,
  NF_LOCK,
} from "./library/icons.ts"
import {
  DEFAULT_ICON_BY_CATEGORY,
  DEFAULT_ICON_BY_NOTIFICATION_ID,
  DEFAULT_NERD_ICON,
} from "./presets.ts"
import { isAnimatedIcon } from "./types.ts"

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

  it("animated icons (e.g. TOOL_SQUARE_PULSE) stay continuously visible — no off-frame whitespace", () => {
    // Regression for the "blinking icon I can barely see" bug: the
    // previous `tool.running` default was a static glyph (`▸`) routed
    // through the static-blink branch, which replaces it with whitespace
    // every other 500ms step. Switching to an animated rotor
    // (TOOL_SQUARE_PULSE) routes through the animated branch, where
    // every step renders a frame from the frames[] array. Sample a
    // 4-frame span (covering 2 full big↔small cycles) at 500ms steps
    // and assert NONE of them are pure whitespace — i.e. the icon is
    // always visible.
    const spinner = new BlinkingNerdSpinner({
      blinkMs: 500,
      // Single-colorizer palette so we can scrub it cleanly to inspect
      // the glyph payload.
      colorizers: [(t) => t],
    })
    const base = {
      now: 0,
      startedAt: 0,
      maxFps: 30,
      currentFps: 30,
      theme: {},
      notification: { notificationId: "tool.running" },
    }
    for (let step = 0; step < 4; step++) {
      const frame = spinner.render({ ...base, elapsedMs: step * 500 })
      // Strip any SGR (none in this palette) and assert non-whitespace.
      expect(frame.glyph.trim().length).toBeGreaterThan(0)
      // And one of the two SQUARE_PULSE frames must be present.
      expect([ICON_SQUARE_BIG, ICON_SQUARE_SMALL]).toContain(frame.glyph)
    }
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

describe("DEFAULT_ICON_BY_NOTIFICATION_ID (live-area status defaults)", () => {
  // These mappings drive what the user sees in the live status row.
  // Pinning each explicitly prevents accidental regressions when the
  // library/frames.ts presets get reshuffled.

  it("agent.thinking → breathing dot (animated, calm)", () => {
    expect(DEFAULT_ICON_BY_NOTIFICATION_ID["agent.thinking"]).toBe(THINKING_BREATHING)
    expect(isAnimatedIcon(THINKING_BREATHING)).toBe(true)
    // `steadyColor: true` keeps the rainbow advance slow (one hue per
    // full breath rather than per frame).
    expect(THINKING_BREATHING.steadyColor).toBe(true)
  })

  it("tool.running → big/small square size-pulse (animated, no off-frame blank)", () => {
    expect(DEFAULT_ICON_BY_NOTIFICATION_ID["tool.running"]).toBe(TOOL_SQUARE_PULSE)
    expect(isAnimatedIcon(TOOL_SQUARE_PULSE)).toBe(true)
    // Color advances per frame (no steadyColor) — gives the "lazy
    // color-and-size pulse" feel.
    expect(TOOL_SQUARE_PULSE.steadyColor).toBeUndefined()
    expect(TOOL_SQUARE_PULSE.intervalMs).toBe(500)
    expect(TOOL_SQUARE_PULSE.frames).toEqual([ICON_SQUARE_BIG, ICON_SQUARE_SMALL])
  })

  it("network.request → blinking filled dot (static, rainbow per cycle)", () => {
    expect(DEFAULT_ICON_BY_NOTIFICATION_ID["network.request"]).toBe(ICON_DOT_FILLED)
    expect(isAnimatedIcon(ICON_DOT_FILLED)).toBe(false)
  })

  it("auth.refresh → blinking NF lock (static)", () => {
    expect(DEFAULT_ICON_BY_NOTIFICATION_ID["auth.refresh"]).toBe(NF_LOCK)
    expect(isAnimatedIcon(NF_LOCK)).toBe(false)
  })

  it("agent.reflection-cooldown → blinking pause (regression: was silently the fallback dot)", () => {
    // Pre-this-change, the reflection-cooldown emitter had no entry in
    // either `iconByNotificationId` or `iconByCategory[reflection]`, so
    // it silently fell through to DEFAULT_NERD_ICON (the tiny `·`).
    // This test pins the explicit mapping so a future preset refactor
    // can't silently revert the fallback.
    expect(DEFAULT_ICON_BY_NOTIFICATION_ID["agent.reflection-cooldown"]).toBe(ICON_PAUSE)
    expect(DEFAULT_ICON_BY_NOTIFICATION_ID["agent.reflection-cooldown"]).not.toBe(DEFAULT_NERD_ICON)
  })

  it("category mappings mirror notification-id mappings for the same semantic", () => {
    // The category map is the fallback when no notification id matches.
    // Today the two maps are aligned for the five known states — keep
    // them aligned so a plugin emitting `category: "tool"` without a
    // notification id still gets the same visual.
    expect(DEFAULT_ICON_BY_CATEGORY.agent).toBe(THINKING_BREATHING)
    expect(DEFAULT_ICON_BY_CATEGORY.tool).toBe(TOOL_SQUARE_PULSE)
    expect(DEFAULT_ICON_BY_CATEGORY.network).toBe(ICON_DOT_FILLED)
    expect(DEFAULT_ICON_BY_CATEGORY.auth).toBe(NF_LOCK)
    expect(DEFAULT_ICON_BY_CATEGORY.reflection).toBe(ICON_PAUSE)
  })
})

describe("VS-15 force text presentation (no emoji 2-cell promotion)", () => {
  // ICON_PAUSE (⏸ U+23F8) has Emoji_Presentation=Yes; without the U+FE0E
  // suffix terminals render it as 2-cell color emoji, which would break
  // the spinner's pad-math (it assumes the rendered width matches
  // `effectiveDisplayWidth` — 1 cell). The suffix is load-bearing.
  //
  // Square icons (ICON_SQUARE_BIG, ICON_SQUARE_SMALL) were previously in
  // this set using ◼ U+25FC / ◾ U+25FE + VS-15, but VS-15 turned out to
  // be unreliable in iTerm for those codepoints, causing the
  // `tool.running` label column to slide 1 cell between rotor frames.
  // They've been swapped for ■ U+25A0 / ▪ U+25AA, which have
  // Emoji_Presentation=No and default to text presentation without any
  // VS-15 suffix — pinned by the separate describe block below.
  it("ICON_PAUSE (⏸) carries U+FE0E and reports 1-cell width", () => {
    const codepoints = Array.from(ICON_PAUSE).map((c) => c.codePointAt(0))
    expect(codepoints).toEqual([0x23f8, 0xfe0e])
    expect(effectiveDisplayWidth(ICON_PAUSE)).toBe(1)
  })
})

describe("square icons default to text without VS-15 (regression for label jiggle)", () => {
  // Regression guard for "tool.running label jumps 1 space" reported
  // May 2026. The earlier ◼/◾ + VS-15 pair relied on terminals honoring
  // VS-15; iTerm doesn't reliably do that for "medium square"
  // codepoints. ■ (U+25A0) has Emoji=No, ▪ (U+25AA) has Emoji=Yes but
  // Emoji_Presentation=No — both default to 1-cell text presentation
  // in every conforming terminal. NO VS-15 suffix on either.
  it("ICON_SQUARE_BIG is ■ U+25A0 (no VS-15)", () => {
    const codepoints = Array.from(ICON_SQUARE_BIG).map((c) => c.codePointAt(0))
    expect(codepoints).toEqual([0x25a0])
    expect(effectiveDisplayWidth(ICON_SQUARE_BIG)).toBe(1)
  })
  it("ICON_SQUARE_SMALL is ▪ U+25AA (no VS-15)", () => {
    const codepoints = Array.from(ICON_SQUARE_SMALL).map((c) => c.codePointAt(0))
    expect(codepoints).toEqual([0x25aa])
    expect(effectiveDisplayWidth(ICON_SQUARE_SMALL)).toBe(1)
  })
})
