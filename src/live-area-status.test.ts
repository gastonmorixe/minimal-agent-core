import { describe, expect, it } from "bun:test"
import { StatusBus } from "./status.ts"
import type { Spinner } from "./spinner.ts"
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
