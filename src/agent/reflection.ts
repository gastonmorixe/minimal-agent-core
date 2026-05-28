/**
 * Reflection-checkpoint utilities used by the agent's run() loop.
 *
 * Three primitives live here:
 *
 *  - {@link parseReflectionAck} extracts the `<ma::reflection-ack
 *    silence-for="K" reason="..." />` tag out of an assistant response.
 *  - {@link runReflectionCooldown} applies a wall-clock pause + live
 *    status surface, with Esc as a "skip cooldown but keep going"
 *    affordance.
 *  - {@link buildReflectionCheckpointBlock} produces the user-content
 *    attachment injected after a cooldown.
 *
 * Split out of `src/agent.ts` to keep that file under the `max-lines`
 * lint budget. Names are re-exported from `agent.ts` for back-compat
 * with existing consumers.
 *
 * @module agent/reflection
 */

import type { ContentBlock } from "../client.ts"
import type { InputCaptureStack } from "../input-capture-stack.ts"
import type { StatusBus } from "../status.ts"

/**
 * Regex matching a `<ma::reflection-ack silence-for="K" reason="..." />`
 * tag in assistant response text. Both attributes are optional in either
 * order. Anchored to `\b` boundaries on the attribute names so a typo
 * like `silencefor` doesn't accidentally match.
 *
 * Captures: group 1 = silence-for value (digits), group 2 = reason text.
 * When the attribute is absent the capture is `undefined`. The model is
 * expected to emit this tag at most once per response : when multiple
 * tags appear the LAST well-formed one wins (see {@link parseReflectionAck}).
 */
const REFLECTION_ACK_RE =
  /<ma::reflection-ack(?:\s+(?:silence-for="(\d+)"|reason="([^"]*)")){0,2}\s*\/>/g

/**
 * Parse `<ma::reflection-ack ... />` tags out of an assistant response.
 *
 * Returns the LAST well-formed tag's parsed values (or `null` if none),
 * so a model that hedges by emitting multiple acks ends with the value
 * it most recently committed to. `silenceFor` defaults to 1 when the
 * attribute is omitted; a 0 disables the ack (no silence applied).
 * Reason is stored verbatim for transcript logging.
 *
 * @param responseText - The assistant response body to scan.
 * @returns The parsed ack, or `null` when no well-formed tag is present.
 */
export function parseReflectionAck(
  responseText: string,
): { silenceFor: number; reason: string } | null {
  let result: { silenceFor: number; reason: string } | null = null
  for (const m of responseText.matchAll(REFLECTION_ACK_RE)) {
    const silenceForRaw = m[1]
    const reason = m[2] ?? ""
    const silenceFor = silenceForRaw === undefined ? 1 : Number.parseInt(silenceForRaw, 10)
    if (!Number.isFinite(silenceFor) || silenceFor < 0) continue
    result = { silenceFor, reason }
  }
  return result
}

/**
 * Wall-clock cooldown applied at a reflection checkpoint. Surfaces a
 * live countdown in the global status bus (same channel the spinner /
 * `Running <tool>` indicator uses), so the human watching sees
 * `<blinking-⏸> reflection @ round 50 · 59s remaining · press Esc to interrupt`
 * tick down in the live area without spamming scrollback. The leading
 * pause glyph is contributed by the live-area status icon (see
 * `agent.reflection-cooldown` in `src/spinner/presets.ts`) : the label
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
 *     and the caller's top-of-loop `if (signal?.aborted) throw
 *     AbortError` tears the turn down on the next iteration. The
 *     checkpoint marker is still pushed; messages stay well-formed.
 *
 * Without a stack (back-compat path), behavior (2) collapses into
 * behavior (3): Esc on its own goes through the abort-quit FSM and
 * aborts the turn. The stack is what gives Esc a "skip cooldown but
 * keep going" meaning.
 *
 * No-op when `totalMs <= 0` : the checkpoint attachment is still
 * injected by the caller in that case (model-facing marker without
 * the wall-clock penalty).
 *
 * @param opts - Cooldown options.
 * @param opts.totalMs - Total cooldown duration in milliseconds. `<= 0`
 *   makes this a no-op.
 * @param opts.round - The tool-loop round at which the checkpoint
 *   fires; shown in the status label.
 * @param opts.signal - Optional abort signal. When it fires the
 *   cooldown resolves immediately (the caller's top-of-loop check will
 *   tear the turn down on the next iteration).
 * @param opts.statusBus - Live-area status bus used to surface the
 *   countdown row.
 * @param opts.inputCaptureStack - Stack to push the "Esc skips this
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

/**
 * Build the `<ma::reflection-checkpoint ... />` attachment text that
 * gets injected into the next user content after a cooldown. The
 * `cooldown-applied-seconds` attribute carries the wall-clock penalty
 * the model can reason about; the trailing prose restates the soft-
 * checkpoint contract so a model that didn't read the system-prompt
 * paragraph carefully still has the ack syntax right next to where it
 * matters.
 *
 * @param round - The current tool-loop round.
 * @param cooldownMs - The wall-clock pause that was applied (or 0 when
 *   the checkpoint fired without a cooldown).
 * @returns A user-content `ContentBlock` ready to prepend on the next turn.
 */
export function buildReflectionCheckpointBlock(round: number, cooldownMs: number): ContentBlock {
  const cooldownSec = Math.max(0, Math.round(cooldownMs / 1000))
  return {
    type: "text",
    text:
      `<ma::reflection-checkpoint round="${round}" cooldown-applied-seconds="${cooldownSec}" />\n` +
      `Soft checkpoint, not a stop signal. Briefly consider whether you are still on track, then continue, change strategy, or pause and ask the user. ` +
      `Emit \`<ma::reflection-ack silence-for="K" reason="..." />\` anywhere in your response to suppress the next K checkpoints (skipping both the cooldown and this attachment).`,
  }
}
