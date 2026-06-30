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

// ─── Square pair for size-pulse rotors ──────────────────────────────────────
// Both square codepoints have `Emoji_Presentation = No` in Unicode
// emoji-data, so they default to text presentation in every terminal — no
// VS-15 dance required. An earlier iteration used ◼ U+25FC + ◾ U+25FE with
// `\uFE0E` suffixes, but iTerm (and other terminals) do not reliably honor
// VS-15 for those "medium square" codepoints, causing the `tool.running`
// label column to slide 1 cell between rotor frames when one rendered as
// text (1 cell) and the other as color emoji (2 cells). Sticking to
// `Emoji_Presentation=No` codepoints avoids the whole question.
//
// `ICON_PAUSE` (⏸ U+23F8) still has `Emoji_Presentation=Yes`, so it
// retains its VS-15 suffix. Our `effectiveDisplayWidth` treats `U+FE0E` as
// zero-width (see `src/term-width.ts:44`, `src/nerd-glyph-width.ts:123`),
// so the pad math for the spinner's off-frame matches the rendered text
// width when the suffix IS honored. If the same iTerm/VS-15 issue ever
// shows up for the pause icon, swap to a non-emoji alternative.

/** Black square (big) — pair with `ICON_SQUARE_SMALL` for size-pulse. */
export const ICON_SQUARE_BIG = "■" // U+25A0 — Emoji_Presentation=No, 1-cell text

/** Black small square (small) — pair with `ICON_SQUARE_BIG`. */
export const ICON_SQUARE_SMALL = "▪" // U+25AA — Emoji_Presentation=No, 1-cell text

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
