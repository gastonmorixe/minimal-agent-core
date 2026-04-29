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
