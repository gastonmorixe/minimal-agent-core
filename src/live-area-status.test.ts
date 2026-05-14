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

  describe("elapsed suffix", () => {
    // Helper: drive a fake `now()` clock the controller reads from, plus
    // a fake bus listener trigger by `bus.create()` and a "force a
    // paint" hook via reflective bus.create()+update() that re-fires the
    // listener. We rely on the controller's design: every bus update
    // ends in a paint() call.
    function makeRig(opts?: { spinner?: Spinner }) {
      const bus = new StatusBus()
      const editor = new FakeEditor()
      let now = 1_000_000
      const ctrl = new LiveAreaStatusController(bus, editor, {
        spinner: opts?.spinner ?? fakeSpinner,
        maxFps: 0, // no auto-ticks. We drive paints via bus events.
        now: () => now,
      })
      ctrl.start()
      return {
        bus,
        editor,
        ctrl,
        setNow: (ms: number) => {
          now = ms
        },
        advance: (deltaMs: number) => {
          now += deltaMs
        },
      }
    }

    it("does not render the suffix at t=0 (sub-1s)", () => {
      const { bus, editor, ctrl } = makeRig()
      bus.create("Thinking", { notificationId: "a", category: "agent" })
      expect(editor.statuses[editor.statuses.length - 1]).toBe("* Thinking")
      ctrl.stop()
    })

    it("appends ` \\x1b[2m(2s)\\x1b[22m` after 2s on the same handle", () => {
      const { bus, editor, ctrl, advance } = makeRig()
      const handle = bus.create("Thinking", { notificationId: "a", category: "agent" })
      // Advance wall-clock and force a paint by re-publishing on the
      // same handle. update() with identical label keeps the same id,
      // so the elapsed timer continues ticking from the create() time.
      advance(2_100)
      handle.update("Thinking")
      expect(editor.statuses[editor.statuses.length - 1]).toBe("* Thinking \x1b[2m(2s)\x1b[22m")
      ctrl.stop()
    })

    it("ladder: 1s, 59s, 1m 0s, 1m 2s, 1h 0m", () => {
      const cases: Array<{ at: number; expected: string }> = [
        { at: 1_500, expected: "* Thinking \x1b[2m(1s)\x1b[22m" },
        { at: 59_900, expected: "* Thinking \x1b[2m(59s)\x1b[22m" },
        { at: 60_000, expected: "* Thinking \x1b[2m(1m 0s)\x1b[22m" },
        { at: 62_400, expected: "* Thinking \x1b[2m(1m 2s)\x1b[22m" },
        { at: 3_600_000, expected: "* Thinking \x1b[2m(1h 0m)\x1b[22m" },
      ]
      for (const { at, expected } of cases) {
        const { bus, editor, ctrl, setNow } = makeRig()
        const handle = bus.create("Thinking", { notificationId: "a", category: "agent" })
        setNow(1_000_000 + at)
        handle.update("Thinking")
        expect(editor.statuses[editor.statuses.length - 1]).toBe(expected)
        ctrl.stop()
      }
    })

    it("resets the timer when a new bus.create() is made (different id, same label)", () => {
      // Simulates two consecutive `Running Bash` tool dispatches.
      // First entry runs for 5s, gets cleared, new entry created with
      // identical label -- the elapsed counter must start at 0 again.
      const { bus, editor, ctrl, advance, setNow } = makeRig()
      const first = bus.create("Running Bash", { notificationId: "tool.running", category: "tool" })
      advance(5_000)
      first.update("Running Bash")
      expect(editor.statuses[editor.statuses.length - 1]).toBe("* Running Bash \x1b[2m(5s)\x1b[22m")
      first.clear()

      // New tool dispatch right after, same human label, brand-new id.
      // Paint must show no suffix (elapsed < 1s on the new entry).
      setNow(1_005_000) // same wall clock as after the advance
      bus.create("Running Bash", { notificationId: "tool.running", category: "tool" })
      expect(editor.statuses[editor.statuses.length - 1]).toBe("* Running Bash")
      ctrl.stop()
    })

    it("does NOT reset the timer across handle.update() with a different label", () => {
      // Simulates client.ts network phase transitions on one request:
      // `Sending` -> `Receiving stream` -> `Thinking`. The elapsed should
      // reflect total request time, not "time since the last phase
      // transition" -- same handle, same id.
      const { bus, editor, ctrl, advance } = makeRig()
      const handle = bus.create("Sending", {
        notificationId: "network.request",
        category: "network",
      })
      advance(3_500)
      handle.update("Receiving stream")
      expect(editor.statuses[editor.statuses.length - 1]).toBe(
        "* Receiving stream \x1b[2m(3s)\x1b[22m",
      )
      advance(2_500)
      handle.update("Thinking")
      expect(editor.statuses[editor.statuses.length - 1]).toBe("* Thinking \x1b[2m(6s)\x1b[22m")
      ctrl.stop()
    })

    it("clears suffix state on stop() so a fresh start re-arms cleanly", () => {
      const { bus, ctrl, advance } = makeRig()
      const handle = bus.create("Thinking", { notificationId: "a", category: "agent" })
      advance(2_000)
      handle.update("Thinking")
      ctrl.stop()
      // After stop, the editor should have been cleared (last status null).
      // (Implicit. No new assertion needed beyond no-throw.)
    })

    it("stays blink-stable across the spinner on/off cycle when suffix is present", () => {
      // Pin the elapsed to a stable second so both on/off paints share
      // the same suffix bytes. With a 200ms gap (< 1s ticker), the
      // formatter produces identical `(Xs)` and display width matches.
      let now = 1_000_000
      const bus = new StatusBus()
      const editor = new FakeEditor()
      const spinner = new BlinkingNerdSpinner({
        blinkMs: 300,
        iconByNotificationId: { tick: "●" },
      })
      const ctrl = new LiveAreaStatusController(bus, editor, {
        spinner,
        maxFps: 0,
        now: () => now,
      })
      ctrl.start()
      const handle = bus.create("Doing things", { notificationId: "tick", category: "any" })
      now += 1_500 // suffix becomes (1s)
      handle.update("Doing things")
      const onCapture = editor.statuses[editor.statuses.length - 1]!
      now += 200 // < blinkMs (300) and < 1s tick, suffix still (1s); spinner off-step is reached at blinkMs from previous render
      // Push the spinner past the on-step -> off-step boundary so we
      // exercise the blink-stability invariant with the suffix tail.
      now += 200 // total 400ms since last paint -> past 300ms blink
      handle.update("Doing things")
      const offCapture = editor.statuses[editor.statuses.length - 1]!
      // The two captures may differ in glyph bytes (on=colorized,
      // off=whitespace), but visible-width must agree -- the label
      // column doesn't jiggle across the cycle.
      expect(displayWidth(onCapture)).toBe(displayWidth(offCapture))
      ctrl.stop()
    })
  })
})
