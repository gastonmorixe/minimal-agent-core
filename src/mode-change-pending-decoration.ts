/**
 * Pure renderer for the "mode change pending delivery" widget shown
 * in the live-area decoration band between the status row and the
 * editor prompt.
 *
 * Why this exists:
 *
 * - When the user toggles modes WHILE a turn is in flight, the new
 *   mode does not reach the model immediately. It rides the next
 *   safe boundary (tool result or stream end). Until that boundary
 *   fires, the model is operating under the OLD mode.
 *
 * - The user needs a visible signal that "your change is queued but
 *   not yet delivered." Otherwise the only feedback is the prompt
 *   prefix repainting (cosmetic, easy to miss when scrollback is
 *   moving), which is misleading because the *model's* understanding
 *   hasn't caught up.
 *
 * - The widget also surfaces the explicit escape hatch: pressing
 *   **Alt+M** aborts the in-flight request and ships the change
 *   immediately as a tiny mode-change-only user turn. The widget
 *   makes that affordance discoverable.
 *
 * Layout (single row):
 *
 *     `  ⏳ mode   default → ASK   pending · ⌥M to apply now`
 *        ▲        ▲       ▲ ▲     ▲                ▲
 *        │        │       │ │     │                └─ dim hint
 *        │        │       │ │     └─ dim "pending"
 *        │        │       │ └─ target label, accent + bold
 *        │        │       └─ dim separator
 *        │        └─ source label, accent (or dim for "default")
 *        └─ violet ⏳ glyph, matching the user-text queue family
 *
 * Returns `null` when no change is pending (active matches
 * lastAdvertised). Pure: no I/O, no closure state.
 *
 * The TARGET label re-uses the same color logic as the scrollback
 * chip (`mode-change-chip.ts`): accent color + bold for the
 * destination, plain accent (or dim) for the source. This keeps the
 * "where you ended up" cue visually consistent across both surfaces.
 *
 * @module mode-change-pending-decoration
 */

import type { PendingModeAttachment } from "./modes.ts"

// ---------------------------------------------------------------------------
// SGR primitives (mirror src/mode-change-chip.ts so the two renderers stay
// byte-aligned without a cross-file import cycle)
// ---------------------------------------------------------------------------

const RESET = "\x1b[0m"
const FG_RESET = "\x1b[39m"

/** SGR dim. */
const dim = (s: string): string => `\x1b[2m${s}\x1b[22m`

/**
 * SGR violet (truecolor `rgb(180, 140, 255)` = `#B48CFF`). Matches
 * the `⏳` glyph color used by `buildQueueDecorationLines` so the
 * mode-change pending widget reads as a sibling of the queued-text
 * decoration above it. Keep in sync with `PALETTE.violet`.
 */
const violet = (s: string): string => `\x1b[38;2;180;140;255m${s}\x1b[39m`

// ---------------------------------------------------------------------------
// Public renderer
// ---------------------------------------------------------------------------

/**
 * Render the single-row pending-mode-change widget for the live-area
 * decoration band.
 *
 * @param pending - The pending attachment from
 *   {@link ModeManager.peekPendingAttachment}. `null` returns `null`
 *   (net-zero / nothing-to-show case).
 * @param resolveLabel - Maps a mode id (or `null` for "no mode
 *   active") to its display label. Conventional spelling for `null`
 *   is `"default"`.
 * @param resolveFgOpen - Maps a mode id (or `null`) to the SGR open
 *   string for its accent color. `null` means "no accent" : the
 *   side falls back to dim (source) or bold faintWhite (target).
 *
 * @returns The rendered line (no trailing newline) or `null` when
 *   nothing is pending.
 */
export function buildPendingModeChangeDecoration(
  pending: PendingModeAttachment | null,
  resolveLabel: (id: string | null) => string,
  resolveFgOpen: (id: string | null) => string | null,
): string | null {
  if (pending == null) return null
  const fromLbl = paintFlat(resolveLabel(pending.fromId), resolveFgOpen(pending.fromId))
  const toLbl = paintBold(resolveLabel(pending.toId), resolveFgOpen(pending.toId))
  // Layout: `  ⏳ mode   <FROM> → <TO>   pending · ⌥M to apply now`
  return (
    `  ${violet("⏳")} ${dim("mode")}   ` +
    `${fromLbl} ${dim("→")} ${toLbl}   ` +
    `${dim("pending")} ${dim("·")} ${dim("⌥M to apply now")}`
  )
}

/** Paint `text` in `fgOpen` (non-bold). Dim fallback when no accent. */
function paintFlat(text: string, fgOpen: string | null): string {
  if (fgOpen) return `${fgOpen}${text}${FG_RESET}`
  return dim(text)
}

/** Paint `text` bold in `fgOpen`. Bold + faint white when no accent. */
function paintBold(text: string, fgOpen: string | null): string {
  if (fgOpen) return `\x1b[1m${fgOpen}${text}${RESET}`
  return `\x1b[1;37m${text}${RESET}`
}
