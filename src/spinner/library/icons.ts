/**
 * Icon library — single-glyph presets, both font-free Unicode and
 * Nerd Font (PUA) variants. Pair with `BlinkingNerdSpinner` for blink
 * behavior, or use as a fallback default icon.
 *
 * Naming:
 *
 * - `ICON_*` — font-free Unicode (works without a Nerd Font).
 * - `NF_*`   — Nerd Font glyphs (require a patched font).
 *
 * @module spinner/library/icons
 */

// ─── Font-free Unicode (always renders) ─────────────────────────────────────

export const ICON_DOT_FILLED = "●" // U+25CF
export const ICON_DOT_SMALL = "·" // U+00B7
export const ICON_DOT_MEDIUM = "•" // U+2022
export const ICON_CIRCLE_OUTLINE = "○" // U+25CB
export const ICON_DIAMOND = "◆" // U+25C6
export const ICON_DIAMOND_OUTLINE = "◇" // U+25C7
export const ICON_STAR = "★" // U+2605
export const ICON_STAR_OUTLINE = "☆" // U+2606
export const ICON_ARROW_RIGHT = "→" // U+2192
export const ICON_ARROW_HEAVY = "❯" // U+276F
export const ICON_WARN = "⚠" // U+26A0
export const ICON_LOCK = "🔒"
export const ICON_GEAR = "⚙" // U+2699
export const ICON_BOLT = "⚡" // U+26A1
export const ICON_HOURGLASS = "⌛" // U+231B
export const ICON_NETWORK = "◉" // U+25C9 — fisheye, reads as "transmitting"
export const ICON_SQUARE = "■" // U+25A0 — black square, BMP narrow, no emoji promotion
export const ICON_TRIANGLE_RIGHT = "▸" // U+25B8 — small triangle, "running"

// ─── BMP-narrow with VS-15 (force text presentation) ────────────────────────
// These codepoints have `Emoji_Presentation = Yes` in the Unicode emoji-data
// table, so terminals render them as 2-cell color emoji by default. The
// `\uFE0E` (Variation Selector-15) suffix forces text presentation (1
// cell). Our `effectiveDisplayWidth` treats `U+FE0E` as zero-width (see
// `src/term-width.ts:44`, `src/nerd-glyph-width.ts:123`), so the pad math
// for the spinner's off-frame matches the rendered text width.

/** Black medium square (big) — pair with `ICON_SQUARE_SMALL` for size-pulse. */
export const ICON_SQUARE_BIG = "\u25FC\uFE0E" // ◼ U+25FC + VS-15

/** Black medium-small square (small) — pair with `ICON_SQUARE_BIG`. */
export const ICON_SQUARE_SMALL = "\u25FE\uFE0E" // ◾ U+25FE + VS-15

/** Pause symbol — calm "waiting / cooldown" indicator. */
export const ICON_PAUSE = "\u23F8\uFE0E" // ⏸ U+23F8 + VS-15

// ─── Nerd Font (Material Design + FontAwesome ranges) ───────────────────────
// Codepoints kept in comments so they're greppable even on non-NF terminals.

export const NF_ROBOT = "󰒕" // U+F0495 — nf-md-robot_outline
export const NF_BRAIN = "󰧠" // U+F09E0 — nf-md-brain
export const NF_TOOLS = "󱁤" // U+F1064 — nf-md-tools
export const NF_LOCK = "󰌾" // U+F033E — nf-md-lock
export const NF_LIGHTBULB = "󰌵" // U+F0335 — nf-md-lightbulb
export const NF_CIRCLE = "" // U+F111 — nf-fa-circle (often invisible)
export const NF_DOT_FILL = "" // U+F444 — nf-oct-dot_fill
export const NF_FLASH = "" // U+F0E7 — nf-fa-flash
export const NF_WIFI = "" // U+F1EB — nf-fa-wifi
export const NF_TERMINAL = "" // U+F120 — nf-fa-terminal
