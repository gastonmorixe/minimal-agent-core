/**
 * Tests for {@link runReflectionCooldown} — specifically the three
 * resolution paths and the new "Esc skips the cooldown WITHOUT
 * aborting the turn" UX added when the {@link InputCaptureStack} is
 * threaded through.
 *
 * Coverage matrix
 * ---------------
 *
 *   | Trigger               | Stack provided? | Outcome                |
 *   |-----------------------|-----------------|------------------------|
 *   | Timer elapsed         | n/a             | resolves, no abort     |
 *   | Esc via stack         | yes             | resolves, NO abort     |
 *   | Esc when no stack     | no              | resolves only on abort |
 *   | Abort signal          | yes             | resolves, capture freed|
 *   | totalMs == 0          | n/a             | no-op return           |
 *   | signal already aborted| n/a             | no-op return           |
 *
 * The "resolves, no abort" path is THE new behavior. Before the stack
 * existed, Esc during the cooldown either did nothing (no signal
 * wired) or aborted the whole turn (signal wired through the
 * abort-quit FSM). Now it can do a third thing: skip just the
 * cooldown.
 */
import { describe, expect, it } from "bun:test"

import { StatusBus } from "../bus/status.ts"
import { InputCaptureStack } from "../input/input-capture-stack.ts"

import { runReflectionCooldown } from "./agent.ts"

function newBus(): StatusBus {
  return new StatusBus()
}

describe("runReflectionCooldown — resolution paths", () => {
  it("totalMs == 0: returns immediately, no status entry created", async () => {
    const statusBus = newBus()
    const stack = new InputCaptureStack()
    const start = Date.now()
    await runReflectionCooldown({
      totalMs: 0,
      round: 1,
      statusBus,
      inputCaptureStack: stack,
    })
    expect(Date.now() - start).toBeLessThan(20)
    expect(statusBus.current()).toBe(null)
    // No capture should have been pushed.
    expect(stack.depth()).toBe(0)
  })

  it("signal already aborted: returns immediately, no status entry, no capture", async () => {
    const statusBus = newBus()
    const stack = new InputCaptureStack()
    const ctrl = new AbortController()
    ctrl.abort()
    await runReflectionCooldown({
      totalMs: 1000,
      round: 1,
      signal: ctrl.signal,
      statusBus,
      inputCaptureStack: stack,
    })
    expect(statusBus.current()).toBe(null)
    expect(stack.depth()).toBe(0)
  })

  it("timer elapses naturally: resolves after totalMs, status entry cleared, capture released", async () => {
    const statusBus = newBus()
    const stack = new InputCaptureStack()
    const start = Date.now()
    const wait = runReflectionCooldown({
      totalMs: 30,
      round: 7,
      statusBus,
      inputCaptureStack: stack,
    })
    // While in flight: capture is on the stack, status entry visible.
    await new Promise((r) => setTimeout(r, 5))
    expect(stack.depth()).toBe(1)
    expect(stack.topId()).toBe("agent.reflection-cooldown")
    expect(statusBus.current()).toContain("reflection @ round 7")
    expect(statusBus.current()).toContain("press Esc to interrupt")
    await wait
    expect(Date.now() - start).toBeGreaterThanOrEqual(25)
    // After: capture released, status cleared.
    expect(stack.depth()).toBe(0)
    expect(statusBus.current()).toBe(null)
  })

  it("Esc via the stack: resolves IMMEDIATELY, signal NOT aborted, capture released", async () => {
    // The headline test: this is the new behavior. Esc during the
    // cooldown ends the wait without flipping the abort signal — the
    // agent loop continues to the next iteration with no abort.
    const statusBus = newBus()
    const stack = new InputCaptureStack()
    const ctrl = new AbortController()
    const start = Date.now()
    const wait = runReflectionCooldown({
      totalMs: 60_000, // way longer than the test would tolerate
      round: 50,
      signal: ctrl.signal,
      statusBus,
      inputCaptureStack: stack,
    })
    // Let the cooldown register its capture.
    await new Promise((r) => setTimeout(r, 5))
    expect(stack.depth()).toBe(1)
    // Simulate the editor's two-layer dispatch: stack.dispatch("Escape").
    // The cooldown's handler claims (returns true) and settles the wait.
    const claimed = stack.dispatch("Escape")
    expect(claimed).toBe(true)
    await wait
    const elapsed = Date.now() - start
    // Resolved well before the 60s totalMs.
    expect(elapsed).toBeLessThan(500)
    // Critically: the abort signal MUST NOT have fired. Esc-during-
    // cooldown means "skip the pause", not "abort the turn".
    expect(ctrl.signal.aborted).toBe(false)
    // Capture released, status cleared.
    expect(stack.depth()).toBe(0)
    expect(statusBus.current()).toBe(null)
  })

  it("Esc via the stack with NO signal: still resolves cleanly", async () => {
    const statusBus = newBus()
    const stack = new InputCaptureStack()
    const wait = runReflectionCooldown({
      totalMs: 60_000,
      round: 1,
      statusBus,
      inputCaptureStack: stack,
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(stack.dispatch("Escape")).toBe(true)
    await wait
    expect(stack.depth()).toBe(0)
    expect(statusBus.current()).toBe(null)
  })

  it("abort signal fires: cooldown resolves, capture is released (no leak)", async () => {
    const statusBus = newBus()
    const stack = new InputCaptureStack()
    const ctrl = new AbortController()
    const wait = runReflectionCooldown({
      totalMs: 60_000,
      round: 1,
      signal: ctrl.signal,
      statusBus,
      inputCaptureStack: stack,
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(stack.depth()).toBe(1)
    ctrl.abort()
    await wait
    expect(ctrl.signal.aborted).toBe(true)
    // Capture released even on the abort path: finally block runs.
    expect(stack.depth()).toBe(0)
    expect(statusBus.current()).toBe(null)
  })

  it("non-Escape keys delivered to the stack do NOT settle the cooldown", async () => {
    // The capture is Esc-specific; Tab / Enter / etc. must pass through
    // (return false) so the editor's other layers see them.
    const statusBus = newBus()
    const stack = new InputCaptureStack()
    const wait = runReflectionCooldown({
      totalMs: 80,
      round: 1,
      statusBus,
      inputCaptureStack: stack,
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(stack.dispatch("Enter")).toBe(false)
    expect(stack.dispatch("Tab")).toBe(false)
    expect(stack.dispatch("ArrowUp")).toBe(false)
    // Still in flight; capture still registered.
    expect(stack.depth()).toBe(1)
    // Now let the timer elapse normally.
    await wait
    expect(stack.depth()).toBe(0)
  })

  it("no inputCaptureStack option: works as before (timer-only), no leaks", async () => {
    // Back-compat: callers that don't pass the stack get the legacy
    // signal-only behavior. The test exists to pin the contract: the
    // stack is OPTIONAL.
    const statusBus = newBus()
    const ctrl = new AbortController()
    const wait = runReflectionCooldown({
      totalMs: 30,
      round: 2,
      signal: ctrl.signal,
      statusBus,
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(statusBus.current()).toContain("reflection @ round 2")
    await wait
    expect(statusBus.current()).toBe(null)
    expect(ctrl.signal.aborted).toBe(false)
  })

  it("LIFO co-existence: a later push lands on top of the cooldown capture", async () => {
    // Mirrors the user scenario from the bug report: an overlay opens
    // AFTER the reflection cooldown is already running. The later
    // capture wins for Esc; releasing it pops back to the cooldown,
    // and a second Esc skips the cooldown.
    const statusBus = newBus()
    const stack = new InputCaptureStack()
    const wait = runReflectionCooldown({
      totalMs: 60_000,
      round: 1,
      statusBus,
      inputCaptureStack: stack,
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(stack.topId()).toBe("agent.reflection-cooldown")
    // Open a simulated overlay (slash-menu) AFTER the cooldown started.
    let overlayClaimed = 0
    let overlayOff: (() => void) | null = null
    overlayOff = stack.push("simulated-overlay", (key) => {
      if (key !== "Escape") return false
      overlayClaimed++
      overlayOff?.()
      return true
    })
    expect(stack.topId()).toBe("simulated-overlay")
    // First Esc: overlay claims, cooldown still running.
    expect(stack.dispatch("Escape")).toBe(true)
    expect(overlayClaimed).toBe(1)
    expect(stack.topId()).toBe("agent.reflection-cooldown")
    // Second Esc: cooldown claims, settles, releases.
    expect(stack.dispatch("Escape")).toBe(true)
    await wait
    expect(stack.depth()).toBe(0)
  })
})
