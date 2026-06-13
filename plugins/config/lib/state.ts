/**
 * Shared per-process state for the config overlay.
 *
 * All three handlers (`cmd_config`, `on_key`, `on_buffer_changed`) import
 * this module. ESM caches by URL, so the loader's separate imports resolve
 * to the SAME instance — one singleton FSM state + one live model. Same
 * pattern as `ma-slash-menu-plugin/lib/state.ts`.
 *
 * # Why a singleton?
 *
 * The overlay's "is it open, what's selected, what's the draft" is
 * per-session, not per-event. The command opens it; the key + buffer hooks
 * mutate it; the close path clears it. Threading it through `ctx` would
 * require a host-provided slot that doesn't exist, so the singleton is the
 * smallest workable shape (the editor-overlay primitive the slash-menu
 * README asks for is the eventual home; until then, this).
 *
 * @module config/lib/state
 */

import { CLOSED, type State } from "./fsm.ts"
import type { ConfigModel } from "./model.ts"

/**
 * Stable owner id for the modal-overlay channels (`editor.overlay.open` /
 * `editor.overlay.close`). The host uses it to scope ownership so a close
 * from a different overlay is ignored. Matches the plugin id.
 */
export const CONFIG_OVERLAY_OWNER = "config"

/** FSM state (per-process). */
let fsmState: State = CLOSED

/** Current overlay FSM state (module-global, one per process). */
export function getState(): State {
  return fsmState
}

/** Replaces the overlay FSM state; callers go through the FSM's `transition`, not directly. */
export function setState(next: State): void {
  fsmState = next
}

/** The live model, present only while the overlay is open. */
let model: ConfigModel | null = null

/** The config model backing the open overlay, or `null` when the overlay is closed. */
export function getModel(): ConfigModel | null {
  return model
}

/** Installs (or clears, with `null`) the model for the overlay's lifetime. */
export function setModel(m: ConfigModel | null): void {
  model = m
}

/** Test hook: reset everything. */
export function _resetForTests(): void {
  fsmState = CLOSED
  model = null
}
