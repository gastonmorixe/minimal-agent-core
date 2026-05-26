import { EventEmitter } from "node:events"

import { describe, expect, it } from "bun:test"

import { AutoAskController } from "./auto-ask.ts"
import { ModeManager } from "./modes.ts"
import type { ManifestMode } from "./plugins/types.ts"

const ASK_MODE: ManifestMode = {
  id: "ask",
  label: "ASK",
  statusLabel: "Asking",
  disallowedTools: ["Edit", "Write"],
}

class FakeSource extends EventEmitter {
  // Tiny adapter: typed `on/off` for "input".
  override on(event: "input", listener: (e: any) => void): this {
    return super.on(event, listener)
  }
  override off(event: "input", listener: (e: any) => void): this {
    return super.off(event, listener)
  }
  send(text: string, seq: number) {
    this.emit("input", { text, seq })
  }
}

function setup() {
  const modes = new ModeManager([ASK_MODE], null)
  const source = new FakeSource()
  const logs: string[] = []
  const ctrl = new AutoAskController(source, modes, {
    logger: (m) => logs.push(m),
  })
  return { modes, source, ctrl, logs }
}

describe("AutoAskController", () => {
  it("flips to ASK on a confident question", () => {
    const { modes, source } = setup()
    expect(modes.activeId()).toBeNull()
    source.send("what is this", 1)
    expect(modes.activeId()).toBe("ask")
  })

  it("does NOT flip on ambiguous text", () => {
    const { modes, source } = setup()
    source.send("can you fix this?", 1)
    expect(modes.activeId()).toBeNull()
  })

  it("does NOT flip on action verbs", () => {
    const { modes, source } = setup()
    source.send("fix the bug in src/foo.ts", 1)
    expect(modes.activeId()).toBeNull()
  })

  it("reverts to default when user pivots from question to action mid-typing", () => {
    const { modes, source } = setup()
    source.send("what is this", 1)
    expect(modes.activeId()).toBe("ask")
    source.send("fix the bug", 2) // user backspaced and switched
    expect(modes.activeId()).toBeNull()
  })

  it("does NOT revert a mode the user manually set (Shift+Tab)", () => {
    const { modes, source, ctrl } = setup()
    // User manually enters ASK before typing.
    modes.setMode("ask")
    expect(ctrl._suspended()).toBe(false) // no input yet
    // First input triggers user-override detection? Actually no — we set
    // ask via setMode BEFORE any input event, so lastSetModeId is null
    // and the subscribe hook sees the user change but `lastSetModeId ===
    // null` means we DON'T mark as override. That's the correct semantic:
    // pre-existing user mode is the baseline.
    source.send("fix the bug", 1)
    // Score is action-confident, but didAutoSwitch is false → no revert.
    expect(modes.activeId()).toBe("ask")
  })

  it("user Shift+Tab while in our auto-ASK suspends us until buffer empties", () => {
    const { modes, source, ctrl } = setup()
    source.send("what is this", 1)
    expect(modes.activeId()).toBe("ask")
    expect(ctrl._didAutoSwitch()).toBe(true)

    // User manually toggles AWAY (Shift+Tab → no mode).
    modes.setMode(null)
    expect(ctrl._suspended()).toBe(true)
    expect(ctrl._didAutoSwitch()).toBe(false)

    // New question text — we should NOT auto-flip back, we're suspended.
    source.send("what about now", 2)
    expect(modes.activeId()).toBeNull()

    // Empty buffer resets suspension.
    source.send("", 3)
    expect(ctrl._suspended()).toBe(false)

    // Now we auto-flip again.
    source.send("how does this work", 4)
    expect(modes.activeId()).toBe("ask")
  })

  it("ignores stale (out-of-order) seq", () => {
    const { modes, source } = setup()
    source.send("what is this", 5)
    expect(modes.activeId()).toBe("ask")
    // Replay an older event — must not act.
    source.send("fix the bug", 3)
    expect(modes.activeId()).toBe("ask")
  })

  it("empty buffer clears didAutoSwitch and suspension", () => {
    const { source, ctrl } = setup()
    source.send("what is this", 1)
    expect(ctrl._didAutoSwitch()).toBe(true)
    source.send("", 2)
    expect(ctrl._didAutoSwitch()).toBe(false)
    expect(ctrl._suspended()).toBe(false)
  })

  it("dispose() detaches listeners", () => {
    const { modes, source, ctrl } = setup()
    ctrl.dispose()
    source.send("what is this", 1)
    expect(modes.activeId()).toBeNull()
  })

  it("does not double-flip when already in ASK", () => {
    const { modes, source, logs } = setup()
    source.send("what is this", 1)
    source.send("what is this thing", 2)
    source.send("what is this thing here", 3)
    // One arrow log — only the first transition fired.
    const flips = logs.filter((l) => l.includes("→ ASK"))
    expect(flips.length).toBe(1)
    expect(modes.activeId()).toBe("ask")
  })
})
