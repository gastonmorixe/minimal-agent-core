/**
 * Effect applier — the imperative shell's core, made testable.
 *
 * The handlers translate a host event into an FSM {@link Event}, run
 * `transition()`, then hand the resulting {@link Effect}s here. This module
 * performs the side effects: mutate the {@link ConfigModel}, emit footer
 * paints / buffer writes on the shared bus, and report whether the key was
 * halted. By funneling every effect through one pure-ish function (its only
 * dependencies are injected — `emit`, `cols`), the whole shell behavior is
 * unit-testable with a fake bus.
 *
 * Bus channels used (declared in the host channel catalog):
 *   - `editor.footer.set`  → paint / clear the overlay footer band.
 *
 * Buffer writes are NOT emitted here. `set-buffer` / `close` instead REPORT
 * the desired buffer text via {@link ApplyResult.setBuffer}, because the
 * right application differs by caller: the `editor.key` hook writes
 * `payload.result.buffer` for same-tick effect (the editor reads it the
 * instant the hook returns), while the command + buffer-changed handlers
 * emit `editor.buffer.set` on the bus. Centralizing the emit here would
 * force the wrong path on the key hook.
 *
 * @module config/lib/runtime
 */

import type { Effect, State } from "./fsm.ts"
import type { ConfigModel } from "./model.ts"
import { render } from "./render.ts"
import { CONFIG_OVERLAY_OWNER } from "./state.ts"
import { renderModel } from "./view.ts"

/** Outcome the caller (key hook) needs: did we consume the keystroke? */
export interface ApplyResult {
  /** True when at least one effect was `halt` (suppress default key handling). */
  halt: boolean
  /** Set when an effect wrote/cleared the buffer; the value to write (may be ""). */
  setBuffer?: string
  /** True when the overlay closed as a result. */
  closed: boolean
  /** Non-null when a save was performed; the resulting confirmation note. */
  saved?: string | null
  /** Non-null when a save failed; the error message. */
  saveError?: string
}

export interface ApplyDeps {
  /** Shape-aware bus emit (host context provides this). */
  emit: (channel: string, payload?: unknown) => void
  /** Current terminal columns. */
  cols: number
  /** Max field/action rows to show at once. */
  maxRows: number
  /** Read the current FSM state (post-transition). */
  getState: () => State
  /** The live model (present while open). */
  model: ConfigModel | null
}

/**
 * Apply a list of effects. Mutates `deps.model` for stage/save effects and
 * emits footer / buffer signals. Returns an {@link ApplyResult} summarizing
 * what the caller must do (halt the key, etc.).
 */
export function applyEffects(effects: Effect[], deps: ApplyDeps): ApplyResult {
  const result: ApplyResult = { halt: false, closed: false }
  let needsRepaint = false

  for (const eff of effects) {
    switch (eff.kind) {
      case "halt":
        result.halt = true
        break
      case "repaint":
        needsRepaint = true
        break
      case "close":
        result.closed = true
        deps.emit("editor.footer.set", { lines: [] })
        // Release modal input ownership: restores the prompt row + cursor and
        // resumes normal key handling. Owner-checked host-side.
        deps.emit("editor.overlay.close", { owner: CONFIG_OVERLAY_OWNER })
        break
      case "set-buffer":
        // Report the buffer write; the caller applies it (payload vs bus).
        result.setBuffer = eff.text
        break
      case "stage-set":
        deps.model?.set(eff.fieldId, eff.value)
        break
      case "stage-clear":
        deps.model?.clear(eff.fieldId)
        break
      case "revert-all":
        deps.model?.revertAll()
        break
      case "save": {
        if (!deps.model) break
        try {
          result.saved = deps.model.save()
        } catch (e) {
          result.saveError = e instanceof Error ? e.message : String(e)
        }
        break
      }
    }
  }

  // Paint AFTER mutations so the footer reflects the new model + state.
  if (needsRepaint && !result.closed) {
    paint(deps)
  }
  return result
}

/** Render the current model + state and emit the footer paint. */
export function paint(deps: ApplyDeps): void {
  const state = deps.getState()
  if (state.kind !== "open" || !deps.model) return
  const rm = renderModel(deps.model, state, deps.cols, deps.maxRows)
  deps.emit("editor.footer.set", { lines: render(rm) })
}
