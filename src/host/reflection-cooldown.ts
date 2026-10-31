/**
 * TUI implementation of the `reflectionGate` host port (spec v2 2.6, S30):
 * a wall-clock pause with a live countdown and an Esc-skip affordance.
 *
 * `AgentCore` never reads the keyboard or sets a timer for this — it only
 * calls `ports.reflectionGate?.beforeCheckpoint(round)` (see
 * `src/sdk/agent-core-helpers.ts`) and awaits whatever the host does with
 * that call. This module is one such host implementation, used by
 * {@link InteractiveSession}'s default `beforeReflectionCheckpoint` wiring.
 * It owns the keyboard (the input capture stack) and the timer; neither
 * leaves the engine side anymore (moved out of the former
 * `src/agent/reflection.ts` in S30, which keeps only the pure ack-parsing
 * and checkpoint-text helpers).
 *
 * @module host/reflection-cooldown
 */

import type { StatusBus } from "../bus/status.ts"
import type { InputCaptureStack } from "../input/input-capture-stack.ts"

/**
 * Wall-clock cooldown applied at a reflection checkpoint. Surfaces a
 * live countdown in the global status bus (same channel the spinner /
 * `Running <tool>` indicator uses), so the human watching sees
 * `<blinking-⏸> reflection @ round 50 · 59s remaining · press Esc to interrupt`
 * tick down in the live area without spamming scrollback. The leading
 * pause glyph is contributed by the live-area status icon (see
 * `agent.reflection-cooldown` in `src/ui/spinner/presets.ts`) : the label
 * itself MUST NOT carry one too or the row reads as a duplicated icon.
 *
 * Three ways this resolves
 * ------------------------
 *  1. **Timer elapsed** (normal): the countdown reaches 0, the wait
 *     resolves, the caller continues to inject the checkpoint marker.
 *  2. **Esc pressed** (skip, via `inputCaptureStack`): the cooldown
 *     ends but the turn does NOT abort. The user just said "go faster"
 *     not "abort". The checkpoint marker is still injected: peeling
 *     the wall-clock pause off the front does not change what the
 *     model is supposed to see.
 *  3. **Abort signal fires** (turn aborting, e.g. Ctrl+C or a second
 *     Esc after this cooldown closed): the wait resolves immediately
 *     and the caller's top-of-loop aborted-signal check
 *     (`if (signal?.aborted) throw AbortError`) tears the turn down on
 *     the next iteration. The checkpoint marker is still pushed;
 *     messages stay well-formed.
 *
 * Without a stack (back-compat path), behavior (2) collapses into
 * behavior (3): Esc on its own goes through the abort-quit FSM and
 * aborts the turn. The stack is what gives Esc a "skip cooldown but
 * keep going" meaning.
 *
 * No-op when `totalMs <= 0` : the caller (`AgentCore`, via the
 * `reflectionGate` port) still injects the checkpoint attachment in that
 * case (model-facing marker without the wall-clock penalty).
 *
 * Cooldown options (the `opts` bag):
 *   - `totalMs` - Total cooldown duration in milliseconds. `<= 0`
 *   makes this a no-op.
 *   - `round` - The tool-loop round at which the checkpoint
 *   fires; shown in the status label.
 *   - `signal` - Optional abort signal. When it fires the
 *   cooldown resolves immediately (the caller's top-of-loop check will
 *   tear the turn down on the next iteration).
 *   - `statusBus` - Live-area status bus used to surface the
 *   countdown row.
 *   - `inputCaptureStack` - Stack to push the "Esc skips this
 *   cooldown" capture onto. When omitted (tests / standalone use), Esc
 *   routes through the editor's FSM as before and aborts the turn
 *   instead of just skipping the cooldown.
 */
export async function runReflectionCooldown(opts: {
  totalMs: number
  round: number
  signal?: AbortSignal
  statusBus: StatusBus
  inputCaptureStack?: InputCaptureStack
}): Promise<void> {
  const { totalMs, round, signal, statusBus, inputCaptureStack: stack } = opts
  if (totalMs <= 0) return
  if (signal?.aborted) return
  const totalSec = Math.max(1, Math.ceil(totalMs / 1000))
  const fmt = (sec: number) =>
    `reflection @ round ${round} · ${sec}s remaining · press Esc to interrupt`
  const handle = statusBus.create(fmt(totalSec), {
    notificationId: "agent.reflection-cooldown",
    category: "reflection",
  })
  let remaining = totalSec
  const tick = setInterval(() => {
    remaining = Math.max(0, remaining - 1)
    if (remaining > 0) handle.update(fmt(remaining))
  }, 1000)
  // The capture is registered for the LIFETIME of this cooldown only.
  // On any resolution path (timer / skip / abort), the `finally` block
  // releases it so the stack returns to its prior state. The handler
  // returns `true` (claims the key) so Esc does NOT reach the
  // abort-quit FSM while the cooldown is visible.
  //
  // Initialised to a no-op so TypeScript's control-flow narrowing
  // doesn't pin it to `null` after the closure assignment inside the
  // Promise executor (the canonical `let X: T | null = null` then
  // assign-in-callback pattern triggers `Type 'never' has no call
  // signatures` in strict mode). The no-op is also a safe default for
  // the `stack === undefined` branch where no push happens.
  let releaseCapture: () => void = () => {}
  try {
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const settle = (): void => {
        if (timer !== null) {
          clearTimeout(timer)
          timer = null
        }
        resolve()
      }
      const onAbort = (): void => settle()
      timer = setTimeout(() => {
        if (signal) signal.removeEventListener("abort", onAbort)
        settle()
      }, totalMs)
      if (signal) signal.addEventListener("abort", onAbort, { once: true })
      if (stack) {
        releaseCapture = stack.push("agent.reflection-cooldown", (key) => {
          if (key !== "Escape") return false
          // Esc = skip the cooldown but DO NOT abort the turn. Settle
          // the promise synchronously; the agent loop continues
          // normally on the next iteration.
          settle()
          return true
        })
      }
    })
  } finally {
    releaseCapture()
    clearInterval(tick)
    handle.clear()
  }
}
