import { describe, expect, it } from "bun:test"
import { StatusBus } from "./status.ts"
import { BlinkingNerdSpinner, type Spinner } from "./spinner.ts"
import { LiveAreaStatusController } from "./live-area-status.ts"

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

  it("pulse-stable: on-frame and off-frame status strings have identical visible width", () => {
    // Drive the real BlinkingNerdSpinner so we exercise the actual
    // pulse-instead-of-blink behavior: both frames emit the same
    // glyph codepoints, only the SGR escape differs.
    //
    // Stripping SGRs from both frames must yield identical strings.
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
      // Stub time so we can control on/off step deterministically.
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
      const stripSgr = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")
      const onStripped = stripSgr(onCapture)
      const offStripped = stripSgr(offCapture)
      expect({ name, onStripped, offStripped }).toEqual({
        name,
        onStripped: `${spec} Doing things`,
        offStripped: `${spec} Doing things`,
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
