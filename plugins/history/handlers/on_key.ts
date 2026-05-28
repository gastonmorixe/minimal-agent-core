/**
 * `editor.key` hook handler.
 *
 * Subscribed via `manifest.hooks` on the broadcast-sync `editor.key`
 * channel. Called BEFORE the editor's default key handling for the
 * intercept-eligible keys (currently ArrowUp / ArrowDown / Ctrl+R).
 *
 * The hook payload includes the current buffer text, the cursor's
 * logical row/col, AND wrap-aware visual coordinates. We use the
 * visual coordinates to decide when ↑/↓ should "steal" the key:
 *
 *  - ↑ steals ⟺ cursor is on the FIRST visual row of the first logical line
 *  - ↓ steals ⟺ cursor is on the LAST visual row of the last logical line
 *
 * Anywhere else, the user is navigating WITHIN a multi-line buffer and
 * we let the default handler do its job.
 *
 * Mutations land in `payload.result`:
 *
 *   - `result.halt = true` → the editor skips its default action
 *   - `result.buffer = "..."` → the editor calls `setBuffer(text)`
 *   - `result.cursor = {row, col}` → cursor placed after setBuffer parks it
 *
 * @module plugins/history/handlers/on_key
 */

import type { HookHandlerContext } from "../../../src/plugins/types.ts"
import { recallFor } from "../lib/session.ts"
import { isDisabled } from "../lib/store.ts"

/** Payload shape — mirror of `EditorKeyPayload` in `src/editor-controller.ts`. */
interface EditorKeyPayload {
  key: string
  buffer: string
  cursor: {
    row: number
    col: number
    visualRow: number
    rowsInLogicalLine: number
    totalLines: number
  }
  result: {
    halt?: boolean
    buffer?: string
    cursor?: { row: number; col: number }
  }
}

function isPayload(v: unknown): v is EditorKeyPayload {
  if (!v || typeof v !== "object") return false
  const o = v as Record<string, unknown>
  return (
    typeof o.key === "string" &&
    typeof o.buffer === "string" &&
    typeof o.cursor === "object" &&
    o.cursor !== null &&
    typeof o.result === "object" &&
    o.result !== null
  )
}

/**
 * `true` when the cursor sits on the FIRST visual row of the buffer —
 * i.e. logical row 0 AND visual chunk 0. ↑ steals only when both hold.
 */
function isAtTop(c: EditorKeyPayload["cursor"]): boolean {
  return c.row === 0 && c.visualRow === 0
}

/**
 * `true` when the cursor sits on the LAST visual row of the buffer —
 * i.e. last logical row AND last visual chunk within it.
 */
function isAtBottom(c: EditorKeyPayload["cursor"]): boolean {
  return c.row === c.totalLines - 1 && c.visualRow === c.rowsInLogicalLine - 1
}

const handler = (payload: unknown, ctx: HookHandlerContext): void => {
  if (isDisabled()) return
  if (!isPayload(payload)) return
  const { key, buffer, cursor, result } = payload

  // Polite-listener convention: an earlier higher-priority listener
  // already claimed this key (e.g. the slash-menu overlay halts
  // ArrowUp/Down for selection nav when its menu is open). Yield
  // silently — recall now would overwrite their `result.buffer` and
  // double-handle the keystroke.
  if (result.halt === true) return

  if (key === "ArrowUp") {
    if (!isAtTop(cursor)) return // pass-through — cursor isn't on top row
    const r = recallFor(ctx.cwd).up(buffer)
    if (r.halt) {
      result.halt = true
      if (r.buffer !== undefined) {
        result.buffer = r.buffer
        // Park the cursor at end of recalled text (readline convention).
        // setBuffer's default lands us there already, but we set it
        // explicitly for clarity and to be robust against setBuffer
        // changes upstream.
        const lines = r.buffer.split("\n")
        result.cursor = {
          row: lines.length - 1,
          col: lines[lines.length - 1]?.length ?? 0,
        }
      }
    }
    return
  }

  if (key === "ArrowDown") {
    if (!isAtBottom(cursor)) return // pass-through
    const r = recallFor(ctx.cwd).down(buffer)
    if (r.halt) {
      result.halt = true
      if (r.buffer !== undefined) {
        result.buffer = r.buffer
        const lines = r.buffer.split("\n")
        result.cursor = {
          row: lines.length - 1,
          col: lines[lines.length - 1]?.length ?? 0,
        }
      }
    }
    return
  }

  if (key === "Ctrl+R") {
    // Reserved for the future incremental search modal. For v0.1 we
    // silently swallow the key so it doesn't fall through to the
    // editor's default (which would insert nothing — see the comment
    // in editor-controller.ts at the `\x12` branch). Halt = true to
    // make this explicit; no buffer/cursor mutation.
    //
    // When the modal lands, this branch will paint the search prompt
    // into the editor's decoration band and start consuming keystrokes
    // via a session-scoped state object.
    result.halt = true
    return
  }
}

export default handler
