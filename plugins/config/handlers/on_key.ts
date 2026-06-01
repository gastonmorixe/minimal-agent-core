/**
 * `editor.key` hook handler — the config overlay's key intercept.
 *
 * Broadcast-sync: runs in the editor's keystroke pump BEFORE default key
 * handling. When the overlay is open it maps the key to an FSM event, runs
 * one transition against the LIVE row snapshot (derived from the model), and
 * applies the effects:
 *
 *   - `halt`        → set `payload.result.halt = true` (swallow the key).
 *   - `set-buffer`  → write `payload.result.buffer` (same-tick; the editor
 *                     reads it the instant we return — no bus round-trip).
 *   - footer paints → emitted on `editor.footer.set` (via `ctx.emit`).
 *   - `save`        → the model wrote to disk; we inject a scrollback
 *                     confirmation via `prompt.inject`? No — a notice would
 *                     re-enter as a user turn. Instead we just repaint the
 *                     header's "(saved)" chip. The save is silent + durable.
 *
 * When the overlay is closed this returns instantly (cheap Map-miss in the
 * FSM), leaving the key for the editor + other plugins (history, slash-menu).
 *
 * @module config/handlers/on_key
 */

import type { HookHandlerContext } from "../../../src/plugins/types.ts"
import { type Event, type KeyName, transition } from "../lib/fsm.ts"
import type { EditorKeyPayload } from "../lib/host-types.ts"
import { applyEffects, type ApplyDeps } from "../lib/runtime.ts"
import { getModel, getState, setModel, setState } from "../lib/state.ts"
import { fsmRows } from "../lib/view.ts"

const MAX_ROWS = 9

function isPayload(v: unknown): v is EditorKeyPayload {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return typeof o.key === "string" && typeof o.result === "object" && o.result !== null
}

function toFsmKey(key: string): KeyName | null {
  switch (key) {
    case "ArrowUp":
    case "ArrowDown":
    case "ArrowLeft":
    case "ArrowRight":
    case "Enter":
    case "Escape":
    case "Tab":
    case "Backspace":
      return key
    default:
      return null
  }
}

/**
 * Map a host `editor.key` payload to an FSM event. While the overlay owns
 * the input line (modal), the host routes EVERY key here, including printable
 * characters (single-char `key`) and Backspace. Nav keys become `key` events;
 * a printable char becomes a `char` event (appended to the edit draft). Keys
 * we don't model return `null` (the shell swallows them while owned so they
 * can't reach the hidden prompt).
 */
function toEvent(key: string): Event | null {
  const named = toFsmKey(key)
  if (named !== null) return { kind: "key", name: named }
  // A single printable character (the host sends these as the literal char
  // while a modal overlay is active). Append to the draft in edit phase.
  if (key.length === 1 && key >= " ") return { kind: "char", ch: key }
  return null
}

const handler = (payload: unknown, ctx: HookHandlerContext): void => {
  if (!isPayload(payload)) return
  const state = getState()
  if (state.kind === "closed") return // overlay not active; pass through.

  const event = toEvent(payload.key)
  if (event === null) {
    // A key we don't model (e.g. a function key) arrived while the overlay
    // owns input. Halt it so it can't leak into the hidden prompt buffer.
    payload.result.halt = true
    return
  }

  const model = getModel()
  if (!model) return

  const { state: next, effects } = transition(state, event, { rows: fsmRows(model) })
  setState(next)

  const deps: ApplyDeps = {
    emit: ctx.emit,
    cols: terminalCols(),
    maxRows: MAX_ROWS,
    getState,
    model,
  }
  const r = applyEffects(effects, deps)

  if (r.halt) payload.result.halt = true
  // On close, drop the live model so a stray later key is a clean no-op.
  // (The runtime already emitted editor.overlay.close to restore the prompt.)
  if (r.closed) setModel(null)
}

function terminalCols(): number {
  const c = (process.stdout as unknown as { columns?: number }).columns
  return typeof c === "number" && c > 0 ? c : 100
}

export default handler
