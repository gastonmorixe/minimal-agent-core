import { describe, expect, it } from "bun:test"

import { make } from "./editor-controller.fixtures.ts"

describe("EditorController — footer rows (live-area slots)", () => {
  it("setFooterLines appends rows BELOW the editor content; cursor stays on the editor row", () => {
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setFooterLines(["quota 5h 12% · 7d 3%"])
    const last = compositor.last()!
    // Layout (idle, no status): [editor, footerSpacer, footer].
    // 1 editor row + 1 blank spacer + 1 footer row = 3 rows.
    expect(last.lines).toHaveLength(3)
    expect(last.lines[0]).toContain("> ") // editor prompt
    expect(last.lines[1]).toBe("") // footer spacer (blank)
    expect(last.lines[2]).toBe("quota 5h 12% · 7d 3%") // footer
    // Cursor sits on the editor row — spacer + footer rows are below.
    expect(last.cursor).not.toBeNull()
    expect(last.cursor!.row).toBe(0)
    ctrl.stop()
  })

  it("setFooterLines bumps liveHeight by N footer rows + 1 blank spacer", () => {
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    const heightBefore = compositor.liveHeight
    ctrl.setFooterLines(["row1", "row2"])
    // +2 footer rows +1 spacer = +3
    expect(compositor.liveHeight).toBe(heightBefore + 3)
    ctrl.setFooterLines(["row1"])
    // +1 footer row +1 spacer = +2
    expect(compositor.liveHeight).toBe(heightBefore + 2)
    ctrl.setFooterLines([])
    expect(compositor.liveHeight).toBe(heightBefore)
    ctrl.stop()
  })

  it("repaint is shallow-deduped (no setLiveArea call when content unchanged)", () => {
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setFooterLines(["same"])
    const before = compositor.liveAreaCalls.length
    ctrl.setFooterLines(["same"]) // identical → must not repaint
    expect(compositor.liveAreaCalls.length).toBe(before)
    ctrl.setFooterLines(["different"]) // change → must repaint
    expect(compositor.liveAreaCalls.length).toBeGreaterThan(before)
    ctrl.stop()
  })

  it("footer coexists with status, decoration, and gap, indicator without disturbing them", () => {
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setStatus("· thinking")
    ctrl.setDecorationLines(["queued: hi"])
    ctrl.setFooterLines(["quota 0%"])
    const last = compositor.last()!
    // Layout: [status, decoration, "", "", editor, "", footer]
    //   = 1 status + 1 decoration + 2 gap + 1 editor + 1 footer-spacer + 1 footer = 7 rows.
    expect(last.lines[0]).toContain("thinking")
    expect(last.lines[1]).toContain("queued: hi")
    expect(last.lines[2]).toBe("")
    expect(last.lines.at(-1)).toBe("quota 0%")
    expect(last.lines.at(-2)).toBe("") // footer spacer
    // Editor cursor row: status(1) + decoration(1) + gap(1) = 3.
    expect(last.cursor!.row).toBe(3)
    ctrl.stop()
  })

  it("setFooterLines([]) clears the footer (and its spacer)", () => {
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setFooterLines(["a", "b"])
    // Layout: [editor, "", "a", "b"] = 4 rows (idle, no status; 1 editor + 1 spacer + 2 footer).
    expect(compositor.last()!.lines.length).toBe(4)
    ctrl.setFooterLines([])
    // Layout: [editor] = 1 row.
    expect(compositor.last()!.lines.length).toBe(1)
    ctrl.stop()
  })
})

describe("EditorController — footer layers (Bug 2801)", () => {
  // Background. Before this work the footer band was driven by ONE
  // mutable `footerLines: string[]`. Two unrelated producers wrote into
  // it through the SAME `setFooterLines(lines)` setter:
  //
  //   (a) The plugin scheduler / diagnostic aggregator pushed the quota
  //       row and last-warning summary (the "base" content).
  //   (b) The abort-quit FSM pushed the armed-quit footer (the
  //       "transient overlay") via `repaintArmedFooter`.
  //
  // Last writer won. When the FSM dismissed the armed footer (ESC, type,
  // expire, quit) it called `setFooterLines([])` which BLEW AWAY the
  // base content. The aggregator was not notified to re-emit, so the
  // quota row stayed gone until the next periodic refresh (~60s).
  //
  // The fix is a small layer-stack model on the controller:
  //   - producers own stable layer ids and write into their OWN layer
  //     (`setFooterLayer(id, lines, opts)` / `clearFooterLayer(id)`);
  //   - the renderer composes by picking the highest-priority non-empty
  //     layer (overlay semantics — clearing an upper layer reveals the
  //     one below);
  //   - `setFooterLines(lines)` stays as the back-compat sugar mapping
  //     to the "default" layer at priority 0;
  //   - the armed-quit FSM uses `"armed-quit"` at priority 100 (room is
  //     deliberately left for future intermediate overlays like a
  //     slash-menu completion bar).
  //
  // These tests pin the contract end-to-end via the FakeCompositor — no
  // private fields, no implementation-detail probing. The bug repro is
  // the first test; the rest pin the new API and z-order invariants.

  it("Bug 2801 (regression): ESC-dismissing the armed footer restores the underlying base footer", () => {
    const { ctrl, stdin, compositor } = make({ armedTickMs: 0, bareEscapeMs: 0 })
    ctrl.start()

    // (a) Plugin scheduler paints the base footer (the quota row).
    ctrl.setFooterLines(["quota 5h 12% · 7d 3%"])
    expect(compositor.last()!.lines).toContain("quota 5h 12% · 7d 3%")

    // (b) User hits Ctrl+C → FSM arms → armed-quit footer takes over.
    stdin.send("\x03")
    expect(ctrl.fsmStateForTest().kind).toBe("armed")
    const whileArmed = compositor.last()!.lines
    expect(whileArmed.some((l) => l.includes("Quit?"))).toBe(true)
    // Crucial intermediate state: the base content is NOT on screen
    // while armed (the overlay wins the composition).
    expect(whileArmed.some((l) => l.includes("quota 5h 12%"))).toBe(false)

    // (c) ESC dismisses the armed window. After the bareEscapeMs flush,
    // the BASE quota row must be back on screen. With the pre-fix
    // single-field design this assertion failed: the footer was empty
    // and the user had to wait ~60s for the next plugin refresh.
    stdin.send("\x1b")
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(ctrl.fsmStateForTest().kind).toBe("idle")
        const afterDismiss = compositor.last()!.lines
        expect(afterDismiss).toContain("quota 5h 12% · 7d 3%")
        expect(afterDismiss.some((l) => l.includes("Quit?"))).toBe(false)
        ctrl.stop()
        resolve()
      }, 5)
    })
  })

  it("Bug 2801 (regression): typing dismisses the armed footer AND the base footer reappears", () => {
    // Same shape as the ESC test but the dismiss mechanism is a
    // printable keystroke (rule: any printable char in armed state
    // cancels the modal and is then inserted into the buffer).
    const { ctrl, stdin, compositor } = make({ armedTickMs: 0 })
    ctrl.start()
    ctrl.setFooterLines(["quota 5h 12% · 7d 3%"])
    stdin.send("\x03")
    expect(ctrl.fsmStateForTest().kind).toBe("armed")
    expect(compositor.last()!.lines.some((l) => l.includes("Quit?"))).toBe(true)

    stdin.send("x")
    expect(ctrl.fsmStateForTest().kind).toBe("idle")
    const afterDismiss = compositor.last()!.lines
    expect(afterDismiss).toContain("quota 5h 12% · 7d 3%")
    expect(afterDismiss.some((l) => l.includes("Quit?"))).toBe(false)
    // The typed char also landed in the buffer.
    expect(afterDismiss[0]).toContain("> x")
    ctrl.stop()
  })

  it("Bug 2801 (regression): base updates DURING the armed window stay invisible but live; dismissing reveals the latest base", () => {
    // Pre-fix this scenario was a second manifestation of the same
    // architectural problem: the plugin scheduler tick during the
    // armed window CLOBBERED the armed line (because both producers
    // wrote into the same field). The armed-quit footer flickered
    // off, the quota row flashed on, then the next FSM tick re-wrote
    // the armed line back. Two writers, one register, no order.
    //
    // After the fix: writes to the "default" layer are accepted but
    // invisible while "armed-quit" holds a higher-priority non-empty
    // value. On dismiss, the LATEST default-layer content emerges
    // (not a stale snapshot).
    const { ctrl, stdin, compositor } = make({ armedTickMs: 0, bareEscapeMs: 0 })
    ctrl.start()
    ctrl.setFooterLines(["quota: 5%"])

    stdin.send("\x03")
    expect(ctrl.fsmStateForTest().kind).toBe("armed")
    expect(compositor.last()!.lines.some((l) => l.includes("Quit?"))).toBe(true)

    // Aggregator pushes a fresher quota number while the user is
    // staring at the armed footer. The armed line MUST stay on top.
    ctrl.setFooterLines(["quota: 12%"])
    const stillArmed = compositor.last()!.lines
    expect(stillArmed.some((l) => l.includes("Quit?"))).toBe(true)
    expect(stillArmed.some((l) => l.includes("quota: 12%"))).toBe(false)
    expect(stillArmed.some((l) => l.includes("quota: 5%"))).toBe(false)

    // Dismiss → the LATEST base content (12%, not the stale 5%) is on screen.
    stdin.send("\x1b")
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const afterDismiss = compositor.last()!.lines
        expect(afterDismiss).toContain("quota: 12%")
        expect(afterDismiss.some((l) => l.includes("quota: 5%"))).toBe(false)
        expect(afterDismiss.some((l) => l.includes("Quit?"))).toBe(false)
        ctrl.stop()
        resolve()
      }, 5)
    })
  })

  it("setFooterLayer / clearFooterLayer: highest-priority non-empty layer wins; clearing an upper layer reveals lower", () => {
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()

    // Base layer at priority 0.
    ctrl.setFooterLayer("plugins", ["plugin row"], { priority: 0 })
    expect(compositor.last()!.lines).toContain("plugin row")

    // Overlay at priority 50 — wins.
    ctrl.setFooterLayer("overlay", ["overlay row"], { priority: 50 })
    expect(compositor.last()!.lines).toContain("overlay row")
    expect(compositor.last()!.lines).not.toContain("plugin row")

    // Higher overlay at priority 100 — wins over the priority-50 one.
    ctrl.setFooterLayer("modal", ["modal row"], { priority: 100 })
    expect(compositor.last()!.lines).toContain("modal row")
    expect(compositor.last()!.lines).not.toContain("overlay row")

    // Clear the top layer → priority-50 layer reappears.
    ctrl.clearFooterLayer("modal")
    expect(compositor.last()!.lines).toContain("overlay row")
    expect(compositor.last()!.lines).not.toContain("modal row")

    // Clear the middle layer → priority-0 layer reappears.
    ctrl.clearFooterLayer("overlay")
    expect(compositor.last()!.lines).toContain("plugin row")
    expect(compositor.last()!.lines).not.toContain("overlay row")

    // Clear the base → no footer at all.
    ctrl.clearFooterLayer("plugins")
    expect(compositor.last()!.lines).not.toContain("plugin row")
    expect(compositor.last()!.lines.some((l) => l.length > 0 && !l.includes("> "))).toBe(false)

    ctrl.stop()
  })

  it("setFooterLayer with empty lines is equivalent to clearing the layer (lower priority reveals)", () => {
    // Producers should not have to remember which method to call when
    // they want to "remove" their content. Empty lines = invisible.
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setFooterLayer("base", ["base row"], { priority: 0 })
    ctrl.setFooterLayer("overlay", ["overlay row"], { priority: 50 })
    expect(compositor.last()!.lines).toContain("overlay row")
    expect(compositor.last()!.lines).not.toContain("base row")

    ctrl.setFooterLayer("overlay", [], { priority: 50 })
    expect(compositor.last()!.lines).toContain("base row")
    expect(compositor.last()!.lines).not.toContain("overlay row")
    ctrl.stop()
  })

  it("setFooterLines is back-compat sugar for the 'default' layer at priority 0", () => {
    // Any caller still using the old single-mutator API maps to a
    // layer with id 'default' at priority 0. This means the armed
    // overlay (priority 100) wins over it as expected, and so does
    // any explicit higher-priority layer.
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setFooterLines(["legacy row"])
    expect(compositor.last()!.lines).toContain("legacy row")

    // An overlay at priority 50 beats the legacy row.
    ctrl.setFooterLayer("overlay", ["overlay row"], { priority: 50 })
    expect(compositor.last()!.lines).toContain("overlay row")
    expect(compositor.last()!.lines).not.toContain("legacy row")

    // Clearing the overlay reveals the legacy row again.
    ctrl.clearFooterLayer("overlay")
    expect(compositor.last()!.lines).toContain("legacy row")

    // setFooterLines([]) clears the default layer.
    ctrl.setFooterLines([])
    expect(compositor.last()!.lines.some((l) => l === "legacy row")).toBe(false)
    ctrl.stop()
  })

  it("repaint is shallow-deduped across the layer stack (no setLiveArea call when composed footer unchanged)", () => {
    // The pre-fix dedup pinned `lines.length === footerLines.length && ...`.
    // The new path must still dedup at the COMPOSED-output level so
    // an unchanged top-layer paint is a no-op even if a lower layer
    // changes invisibly.
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setFooterLayer("overlay", ["overlay row"], { priority: 50 })
    const before = compositor.liveAreaCalls.length

    // Mutating an OBSCURED layer changes nothing on screen → no repaint.
    ctrl.setFooterLayer("base", ["base row a"], { priority: 0 })
    ctrl.setFooterLayer("base", ["base row b"], { priority: 0 })
    expect(compositor.liveAreaCalls.length).toBe(before)

    // Mutating the visible (top) layer DOES repaint.
    ctrl.setFooterLayer("overlay", ["overlay row v2"], { priority: 50 })
    expect(compositor.liveAreaCalls.length).toBeGreaterThan(before)
    ctrl.stop()
  })

  it("clearFooterLayer on an unknown id is a no-op (does not repaint)", () => {
    const { ctrl, compositor } = make({ columns: 40 })
    ctrl.start()
    ctrl.setFooterLayer("known", ["row"], { priority: 0 })
    const before = compositor.liveAreaCalls.length
    ctrl.clearFooterLayer("nope-not-a-real-id")
    expect(compositor.liveAreaCalls.length).toBe(before)
    ctrl.stop()
  })

  it("armed footer uses the 'armed-quit' layer id at priority 100 (load-bearing for plugin coexistence)", () => {
    // Pin the id + priority used by the FSM as part of the public
    // contract. Any future overlay (slash-menu completion at priority
    // 50, mid-prompt cmd bar at 75, etc.) depends on knowing where
    // 'armed-quit' sits in the stack. The constants live in
    // src/editor-controller.ts as `FOOTER_LAYER_*` exports.
    const { ctrl, stdin, compositor } = make({ armedTickMs: 0, bareEscapeMs: 0 })
    ctrl.start()
    stdin.send("\x03")
    expect(ctrl.fsmStateForTest().kind).toBe("armed")

    // Push an overlay at priority 50 — armed (100) MUST still win.
    ctrl.setFooterLayer("mid", ["mid row"], { priority: 50 })
    expect(compositor.last()!.lines.some((l) => l.includes("Quit?"))).toBe(true)
    expect(compositor.last()!.lines).not.toContain("mid row")

    // Push an overlay at priority 200 — beats armed.
    ctrl.setFooterLayer("top", ["top row"], { priority: 200 })
    expect(compositor.last()!.lines).toContain("top row")
    expect(compositor.last()!.lines.some((l) => l.includes("Quit?"))).toBe(false)

    // Clear top → armed re-emerges (mid is still 50, below armed 100).
    ctrl.clearFooterLayer("top")
    expect(compositor.last()!.lines.some((l) => l.includes("Quit?"))).toBe(true)
    expect(compositor.last()!.lines).not.toContain("mid row")

    // Dismiss armed → mid (50) emerges.
    stdin.send("\x1b")
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(compositor.last()!.lines).toContain("mid row")
        expect(compositor.last()!.lines.some((l) => l.includes("Quit?"))).toBe(false)
        ctrl.stop()
        resolve()
      }, 5)
    })
  })
})
