/**
 * `editor.key` hook handler — drive the `/usage` overlay with the keyboard.
 *
 * Only acts while the overlay is open; otherwise every key passes through
 * untouched (cheap boolean check). Runs at priority 80 (matching /config) so
 * it claims its keys before history / slash-menu when the overlay is up.
 *
 *   ← / →  (or h / l)  switch period (wraps)
 *   1 - 6              jump to a period
 *   Esc / q            close the overlay
 *
 * Repaints by emitting `editor.footer.set`; close clears it with `[]`.
 *
 * @module usage/handlers/on_key
 */

import type { HookHandlerContext } from "@minimal-agent/plugin-api/types/plugin"

import { jumpIndex, renderOverlayFrame, stepIndex } from "../lib/overlay.ts"
import { closeOverlay, getOverlayState, USAGE_OVERLAY_OWNER } from "../lib/state.ts"

const MAX_ROWS = 6

interface EditorKeyPayload {
  key: string
  result: { halt?: boolean; buffer?: string; cursor?: { row: number; col: number } }
}

function isPayload(v: unknown): v is EditorKeyPayload {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return typeof o.key === "string" && typeof o.result === "object" && o.result !== null
}

function terminalCols(): number {
  const c = (process.stdout as { columns?: number }).columns
  return typeof c === "number" && c > 0 ? c : 80
}

const handler = (payload: unknown, ctx: HookHandlerContext): void => {
  if (!isPayload(payload)) return
  const state = getOverlayState()
  if (!state.open || !state.reports) return // overlay not active; pass through.

  const { key, result } = payload
  const repaint = (): void => {
    const lines = renderOverlayFrame(state.reports!, state.index, terminalCols(), MAX_ROWS)
    ctx.emit("editor.footer.set", { lines })
  }
  const close = (): void => {
    closeOverlay()
    ctx.emit("editor.footer.set", { lines: [] })
    // Release modal input ownership; the host restores the prompt + cursor.
    ctx.emit("editor.overlay.close", { owner: USAGE_OVERLAY_OWNER })
  }

  switch (key) {
    case "ArrowRight":
    case "l":
      state.index = stepIndex(state.index, 1)
      result.halt = true
      repaint()
      return
    case "ArrowLeft":
    case "h":
      state.index = stepIndex(state.index, -1)
      result.halt = true
      repaint()
      return
    case "Escape":
    case "q":
      result.halt = true
      close()
      return
    default: {
      const jump = jumpIndex(key)
      if (jump !== null) {
        state.index = jump
        result.halt = true
        repaint()
      }
      return
    }
  }
}

export default handler
