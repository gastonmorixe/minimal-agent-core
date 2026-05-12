import { describe, expect, it } from "bun:test"
import { StatusBus } from "./status.ts"
import { BlinkingNerdSpinner, type Spinner } from "./spinner.ts"
import { LiveAreaStatusController } from "./live-area-status.ts"
import { displayWidth } from "./term-width.ts"

class FakeEditor {
  readonly statuses: Array<string | null> = []
  setStatus(text: string | null): void {
    this.statuses.push(text)
  }
}

const fakeSpinner: Spinner = {
  willShow: () => undefined,
  didShow: () => undefined,
  willDisappear: () => undefined,
  didDisappear: () => undefined,
  render: () => ({ glyph: "*" }),
}

describe("LiveAreaStatusController", () => {
  it("publishes 'glyph label' when a status appears on the bus", () => {
    const bus = new StatusBus()
    const editor = new FakeEditor()
    const ctrl = new LiveAreaStatusController(bus, editor, {
      spinner: fakeSpinner,
      maxFps: 0, // no animation timer
    })
    ctrl.start()
    const handle = bus.create("Thinking", { notificationId: "x", category: "agent" })
    expect(editor.statuses[editor.statuses.length - 1]).toBe("* Thinking")
    handle.clear()
    expect(editor.statuses[editor.statuses.length - 1]).toBe(null)
    ctrl.stop()
  })

  it("clears the status row on stop()", () => {
    const bus = new StatusBus()
    const editor = new FakeEditor()
    const ctrl = new LiveAreaStatusController(bus, editor, {
      spinner: fakeSpinner,
      maxFps: 0,
    })
    ctrl.start()
    bus.create("busy", { notificationId: "y", category: "agent" })
    editor.statuses.length = 0
    ctrl.stop()
    expect(editor.statuses).toContain(null)
  })

  it("uses plain 1-space gap for a 1-cell icon", () => {
    const bus = new StatusBus()
    const editor = new FakeEditor()
    const ctrl = new LiveAreaStatusController(bus, editor, {
      spinner: { ...fakeSpinner, render: () => ({ glyph: "●" }) },
      maxFps: 0,
    })
    ctrl.start()
    bus.create("Thinking", { notificationId: "n1", category: "agent" })
    expect(editor.statuses[editor.statuses.length - 1]).toBe("● Thinking")
    ctrl.stop()
  })

  it("uses plain 1-space gap for a wide PUA nerd-font icon (no special padding)", () => {
    const bus = new StatusBus()
    const editor = new FakeEditor()
    const wideGlyph = "\u{F1064}" // 󱁤 nf-md-tools, U+F1064, PUA-A
    const ctrl = new LiveAreaStatusController(bus, editor, {
      spinner: { ...fakeSpinner, render: () => ({ glyph: wideGlyph }) },
      maxFps: 0,
    })
    ctrl.start()
    bus.create("Running Bash", { notificationId: "n2", category: "agent" })
    // Same 1-space gap as narrow icons. Visual width may be tight in
    // patched-Nerd-Font terminals (glyph fills 2 cells), but byte
    // emission is stable — see pulse-instead-of-blink test below.
    expect(editor.statuses[editor.statuses.length - 1]).toBe(`${wideGlyph} Running Bash`)
    ctrl.stop()
  })

  it("uses plain 1-space gap when the spinner is between frames (empty glyph)", () => {
    const bus = new StatusBus()
    const editor = new FakeEditor()
    const ctrl = new LiveAreaStatusController(bus, editor, {
      spinner: { ...fakeSpinner, render: () => ({ glyph: "" }) },
      maxFps: 0,
    })
    ctrl.start()
    bus.create("hello", { notificationId: "n3", category: "agent" })
    // Empty glyph falls back to " " (1 cell), 1-space gap = 2 spaces total.
    expect(editor.statuses[editor.statuses.length - 1]).toBe("  hello")
    ctrl.stop()
  })

  it("animates status rows by default (timer ticks while a status is active)", async () => {
    // Spinner that emits a DIFFERENT glyph on every render call so the
    // controller's `editor.setStatus` short-circuit (skip when text
    // unchanged) does not mask the animation timer. If the timer fires
    // at all, additional paints land in `editor.statuses` beyond the
    // single paint triggered by `bus.create`.
    let renders = 0
    const tickingSpinner: Spinner = {
      ...fakeSpinner,
      render: () => ({ glyph: String(renders++) }),
    }
    const bus = new StatusBus()
    const editor = new FakeEditor()
    const ctrl = new LiveAreaStatusController(bus, editor, {
      spinner: tickingSpinner,
      // 20 fps → 50 ms tick. With a 200 ms wait we expect 3-4 ticks.
      maxFps: 20,
    })
    ctrl.start()
    bus.create("steady", { notificationId: "n4", category: "agent" })
    const afterCreate = editor.statuses.length

    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(editor.statuses.length).toBeGreaterThan(afterCreate)
    ctrl.stop()
  })

  it("blink-stable: on-frame and off-frame status strings have identical display width", () => {
    // Drive the real BlinkingNerdSpinner so we exercise the actual
    // true-blink behavior: on-frame is the colorized glyph, off-frame
    // is whitespace of equivalent cell width. The two frames differ
    // in stripped content but MUST agree on display width so the
    // label column does not jiggle across the cycle.
    const cases: Array<{ name: string; spec: string }> = [
      { name: "narrow", spec: "●" },
      { name: "wide PUA", spec: "\u{F1064}" }, // 󱁤
    ]
    for (const { name, spec } of cases) {
      const bus = new StatusBus()
      const editor = new FakeEditor()
      const spinner = new BlinkingNerdSpinner({
        // Pin blinkMs so the on/off-step assertion stays decoupled
        // from whatever default the spinner ships with.
        blinkMs: 300,
        iconByNotificationId: { [`x.${name}`]: spec },
      })
      // Stub time so we can control on/off step deterministically. The
      // controller is constructed with maxFps:0 so only bus events
      // produce paints — guarantees exactly two captures below.
      let now = 1_000_000
      const ctrl = new LiveAreaStatusController(bus, editor, {
        spinner,
        maxFps: 0,
        now: () => now,
      })
      ctrl.start()
      bus.create("Doing things", {
        notificationId: `x.${name}`,
        category: `cat.${name}`,
      })
      const onCapture = editor.statuses[editor.statuses.length - 1]!
      // Re-publish to force a new paint at a later time → off-step.
      now += 350 // > blinkMs (300)
      bus.create("Doing things", {
        notificationId: `x.${name}`,
        category: `cat.${name}`,
      })
      const offCapture = editor.statuses[editor.statuses.length - 1]!
      // Both captures must occupy the same number of terminal cells.
      // On-frame: "<colorized spec> Doing things". Off-frame:
      // "<displayWidth(spec) spaces> Doing things". Same width.
      expect({ name, on: displayWidth(onCapture), off: displayWidth(offCapture) }).toEqual({
        name,
        on: displayWidth(`${spec} Doing things`),
        off: displayWidth(`${spec} Doing things`),
      })
      ctrl.stop()
    }
  })

  it("suspend/resume keeps the label and re-paints on resume", () => {
    const bus = new StatusBus()
    const editor = new FakeEditor()
    const ctrl = new LiveAreaStatusController(bus, editor, {
      spinner: fakeSpinner,
      maxFps: 0,
    })
    ctrl.start()
    bus.create("hi", { notificationId: "z", category: "agent" })
    editor.statuses.length = 0
    ctrl.suspend()
    ctrl.resume()
    expect(editor.statuses[editor.statuses.length - 1]).toBe("* hi")
    ctrl.stop()
  })
})
