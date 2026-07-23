/**
 * Pure renderer for the mode-change scrollback chip.
 *
 * A single line pushed to the compositor at send time AND replayed
 * inline by session-replay when walking historical `<mode-change>`
 * blocks. Layout:
 *
 *     `  · ✦ mode →  ASK   2026-05-22 17:52  from default`
 *        ▲ ▲     ▲     ▲           ▲                ▲
 *        │ │     │     │           │                └─ dim "from <X>"
 *        │ │     │     │           └─ faint-white `YYYY-MM-DD HH:MM`
 *        │ │     │     └─ target label in target mode color, bold
 *        │ │     └─ dim "mode →" connector
 *        │ └─ lime `✦` sparkle (matches existing chrome family)
 *        └─ dim `·` chip-lead (matches `· memory saved …` convention)
 *
 * Pure : no I/O, no closure state, no clock reads. The caller supplies
 * the `Date` (live: `new Date()` at send time; replay: the parent
 * user-record's `ts`).
 *
 * SGR wrapper policy comes from `@minimal-agent/plugin-api/utils/ansi`, the
 * same source used by plugin renderers. The caller still supplies resolved
 * mode foreground opens; this renderer only decides layout.
 *
 * @module mode-change-chip
 */

import { ANSI_CODES, ansiStyle as c } from "@minimal-agent/plugin-api/utils/ansi"

import type { ModeChangeEvent, PendingModeAttachment } from "../../../modes/modes.ts"
import type { ManifestMode } from "../../../plugins/types.ts"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Fully-resolved input to {@link buildModeChangeChip}. Built once per
 * event by the caller; the renderer never touches the manifest or
 * resolved-style cache.
 *
 * `fromLabel` / `toLabel` are display strings. `"default"` is the
 * conventional spelling for "no mode active". The renderer paints them
 * as-is : no clampLabel, no toUpper. Callers handle casing.
 *
 * `fromFgOpen` / `toFgOpen` are SGR open sequences for the source /
 * target modes' accent colors. `null` means "no color" : that side
 * falls back to dim (source) or bold faint-white (target). Live
 * callers resolve `"default"` / no-mode via `ModeManager.resolvedForId(null)`
 * which supplies the brand primary (same pigment as the prompt `❯`),
 * so the pure fallback is only for modes that truly declare no style.
 */
export interface ChipRenderInput {
  fromLabel: string
  toLabel: string
  /** SGR open string for the source mode's accent color, or `null` for none. */
  fromFgOpen: string | null
  /** SGR open string for the target mode's accent color, or `null` for none. */
  toFgOpen: string | null
  /** Wall-clock the change took effect. */
  at: Date
}

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------

/**
 * Format a Date as `YYYY-MM-DD HH:MM` in the host's local timezone.
 *
 * Both date AND time are always rendered : the user explicitly asked for
 * this format. Seconds are dropped to keep the chip narrow.
 *
 * Pure. No timezone tricks, no locale dependence beyond what the JS
 * runtime gives us : we extract Y/M/D/h/m from the local-time getters,
 * not from `toISOString` (which is UTC).
 */
export function formatModeTimestamp(at: Date): string {
  const y = at.getFullYear()
  const mo = pad2(at.getMonth() + 1)
  const d = pad2(at.getDate())
  const h = pad2(at.getHours())
  const mi = pad2(at.getMinutes())
  return `${y}-${mo}-${d} ${h}:${mi}`
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

// ---------------------------------------------------------------------------
// Scrollback chip (variant D)
// ---------------------------------------------------------------------------

/**
 * Render the single-row scrollback chip for a mode transition.
 *
 * The returned string includes NO trailing newline : callers append
 * `\n` (live) or `\n\n` (replay, for breathing room between historical
 * blocks). Two leading spaces match the agent's existing 2-cell left
 * margin convention (memory saves, tool transcripts, banners all use it).
 *
 * Chip-lead is the dim `·` middle dot, matching the established
 * `· memory saved …` chip family : same vocabulary, reader knows
 * "this is a chrome announcement, not user content". The transition
 * reads left-to-right as `<from> → <to>` with each label in its own
 * accent color (or dim for "default"), and the TARGET is bold so the
 * eye lands on "where you ended up".
 *
 * Layout:
 *
 *     `  · mode   default → ASK   2026-05-22 17:52`
 *        ▲ ▲      ▲       ▲ ▲     ▲
 *        │ │      │       │ │     └─ faint-white timestamp
 *        │ │      │       │ └─ target label, bold, in target's accent
 *        │ │      │       └─ dim separator
 *        │ │      └─ source label, non-bold, in source's accent (or dim)
 *        │ └─ dim category word
 *        └─ dim chip-lead `·`
 *
 * Width estimate ≈ 41 cells, well under 60 cols.
 */
export function buildModeChangeChip(input: ChipRenderInput): string {
  const leadDot = c.dim("·")
  const fromLbl = paintFlat(input.fromLabel, input.fromFgOpen)
  const toLbl = paintBold(input.toLabel, input.toFgOpen)
  const arrow = c.dim("→")
  const stamp = c.faintWhite(formatModeTimestamp(input.at))
  // Spaces: `  · mode   <FROM> → <TO>   <STAMP>`
  // Triple space between `mode` and the transition, and between the
  // transition and the stamp, gives natural column separation between
  // the three info groups (category / transition / time).
  return `  ${leadDot} ${c.dim("mode")}   ${fromLbl} ${arrow} ${toLbl}   ${stamp}`
}

/**
 * Paint `text` in `fgOpen` (non-bold). Falls back to dim when the mode
 * has no accent color (unstyled modes only — `"default"` is resolved to
 * brand primary by the caller), matching the sibling pending-decoration
 * renderer.
 */
function paintFlat(text: string, fgOpen: string | null): string {
  if (fgOpen) return `${fgOpen}${text}${ANSI_CODES.FG_RESET}`
  return c.dim(text)
}

/**
 * Paint `text` bold in `fgOpen`. Falls back to bold faint-white when the
 * mode has no accent color (unstyled modes only). `"default"` is resolved
 * to brand primary by the caller so it matches the prompt arrow. Matches
 * the pending-decoration renderer byte-for-byte.
 */
function paintBold(text: string, fgOpen: string | null): string {
  if (fgOpen) return `${ANSI_CODES.BOLD}${fgOpen}${text}${ANSI_CODES.RESET}`
  return c.boldWhite(text)
}

// ---------------------------------------------------------------------------
// Send-time scrollback chip from a peeked PendingModeAttachment
// ---------------------------------------------------------------------------

/**
 * Build the scrollback chip for a peeked {@link PendingModeAttachment}.
 *
 * Same byte output as {@link buildModeChangeChip}: convenience adapter
 * the live-area REPL uses on its "flush pending change at send time"
 * path so callers don't have to fabricate a full ChipRenderInput.
 *
 * The chip is NOT emitted on every toggle. It lands once per consume,
 * carrying the NET (lastAdvertised → active) transition. Net-zero
 * sequences (ASK → default → ASK with no send) yield `pending = null`
 * and this returns `null`, so no chip is ever written for them.
 *
 * @param pending - The pending mode transition to render, or null.
 * @param resolveLabel - Maps a mode id (or null) to its display label.
 * @param resolveFgOpen - Maps a mode id (or null) to its ANSI fg-open
 *   sequence, or null for the default color.
 * @param at - Wall-clock at the moment of send. The caller captures
 *   this once; replay uses the user-record's `ts` and calls
 *   {@link buildModeChangeChip} directly.
 */
export function buildPendingModeChangeChip(
  pending: PendingModeAttachment | null,
  resolveLabel: (id: string | null) => string,
  resolveFgOpen: (id: string | null) => string | null,
  at: Date,
): string | null {
  if (pending == null) return null
  return buildModeChangeChip({
    fromLabel: resolveLabel(pending.fromId),
    toLabel: resolveLabel(pending.toId),
    fromFgOpen: resolveFgOpen(pending.fromId),
    toFgOpen: resolveFgOpen(pending.toId),
    at,
  })
}

// ---------------------------------------------------------------------------
// Adapter: ModeChangeEvent → ChipRenderInput
// ---------------------------------------------------------------------------

/**
 * Pull display-ready fields out of a {@link ModeChangeEvent}.
 *
 * Label rules:
 *   - `null` mode  → label `"default"` (lowercase, conventional)
 *   - has `label`  → use as-is (e.g. `"ASK"`)
 *   - no `label`   → fall back to uppercased `id`
 *
 * Color extraction is a callback because the resolved-style cache lives
 * on `ModeManager` and we don't want this module to depend on it. The
 * caller passes `(id) => modeManager.resolvedForId(id)?.label.fgOpen ?? null`
 * or equivalent.
 */
export function eventToChipInput(
  event: ModeChangeEvent,
  resolveFgOpen: (mode: ManifestMode | null) => string | null,
): ChipRenderInput {
  return {
    fromLabel: labelFor(event.from),
    toLabel: labelFor(event.to),
    fromFgOpen: resolveFgOpen(event.from),
    toFgOpen: resolveFgOpen(event.to),
    at: event.at,
  }
}

/**
 * Display label for a mode (or `"default"` for null). Public so
 * session-replay can build the same labels without re-implementing the
 * fallback chain.
 */
export function labelFor(mode: ManifestMode | null): string {
  if (mode == null) return "default"
  if (mode.label && mode.label.length > 0) return mode.label
  return mode.id.toUpperCase()
}
