/**
 * Host-neutral mode style resolver.
 *
 * Turns the declarative `ModeStyleRequest` from a plugin manifest into
 * {@link ModeStyle}: per-surface color tokens plus bold/dim flags. Core
 * holds no terminal code (rule 14), so this module never makes an escape
 * sequence. A host maps the tokens to its own output. The CLI maps them to
 * SGR in `minimal-agent-cli/src/terminal-kit/mode-style.ts`. A web host can
 * map them to CSS.
 *
 *   manifest.json  ──parse──▶  ModeStyleRequest
 *                                    │
 *                    resolveModeStyleTokens(request, theme)
 *                                    │
 *                                    ▼
 *                       ModeStyle (tokens)  ──▶  host render
 *
 * Core does these steps: merge the active theme override, drop
 * `transparent`, drop unknown tokens and malformed hex strings, and keep
 * each surface separate (no implicit inheritance). The host does the
 * steps that depend on its output: pick a color form (for example
 * truecolor or 256-color), and drop a background that is the same as
 * the foreground.
 *
 * @module modes/mode-style
 */

import type {
  ColorRequest,
  ModeStyleRequest,
  SurfaceStyleRequest,
  ThemeKey,
} from "@minimal-agent/core/plugin-api/types/plugin"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Palette color names a mode style can use (the manifest `color` set). */
export const MODE_COLOR_NAMES = [
  "cyan",
  "blue",
  "magenta",
  "yellow",
  "green",
  "red",
  "orange",
  "pink",
  "purple",
  "lime",
  "sky",
  "gold",
] as const

/** Semantic tokens a mode style can use. The host picks the pigment. */
export const MODE_SEMANTIC_TOKENS = ["accent", "accent-soft", "brand", "danger", "muted"] as const

/** One palette color name. */
export type ModeColorName = (typeof MODE_COLOR_NAMES)[number]

/** One semantic token. */
export type ModeSemanticToken = (typeof MODE_SEMANTIC_TOKENS)[number]

/** A named color: a palette name or a semantic token. */
export type ModeColorToken = ModeColorName | ModeSemanticToken

/**
 * One color, with every form the manifest gave. `null` means "the
 * manifest gave no usable value of this form". At least one field is not
 * `null`. The host picks the form it can show.
 *
 * - `token`: a palette name or a semantic token.
 * - `hex`: a `#rrggbb` string. From the string form it is always valid.
 *   From the object form it is kept as written, and the host must check it.
 * - `ansi256`: a 256-color index, from the object form only.
 */
export interface ModeColor {
  token: ModeColorToken | null
  hex: string | null
  ansi256: number | null
}

/**
 * Style for one surface (label, arrow, or status). `fg` / `bg` are `null`
 * when the host must not paint that attribute (terminal default for `fg`,
 * transparent for `bg`).
 */
export interface ModeSurfaceStyle {
  fg: ModeColor | null
  bg: ModeColor | null
  bold: boolean
  dim: boolean
}

/** Host-neutral style for all three surfaces of a mode. */
export interface ModeStyle {
  label: ModeSurfaceStyle
  arrow: ModeSurfaceStyle
  status: ModeSurfaceStyle
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the theme from `MINIMAL_AGENT_THEME` (`dark` | `light` |
 * `high-contrast`). Returns `dark` when the value is not set or not valid.
 */
export function detectModeTheme(env: Record<string, string | undefined> = process.env): ThemeKey {
  const t = env.MINIMAL_AGENT_THEME
  if (t === "light" || t === "dark" || t === "high-contrast") return t
  return "dark"
}

/**
 * Resolve a mode's declarative style request to host-neutral tokens.
 *
 * Merges the base request with the `theme[theme]` override (the override
 * wins per surface and per key). Each surface resolves alone: a mode that
 * sets only `label` does not also color `arrow` or `status`.
 */
export function resolveModeStyleTokens(request: ModeStyleRequest, theme: ThemeKey): ModeStyle {
  const merged = mergeWithTheme(request, theme)
  return {
    label: resolveSurface(merged.label ?? {}),
    arrow: resolveSurface(merged.arrow ?? {}),
    status: resolveSurface(merged.status ?? {}),
  }
}

/**
 * Make a `ModeStyleRequest` from the legacy `color` shorthand.
 *
 * The legacy shorthand colors the label only, in bold. The arrow and the
 * status stay at the host defaults. Returns `null` when `color` is empty.
 */
export function styleFromLegacyColor(color: string | null | undefined): ModeStyleRequest | null {
  if (!color) return null
  return { label: { fg: color, bold: true } }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

const COLOR_NAMES: ReadonlySet<string> = new Set(MODE_COLOR_NAMES)
const SEMANTIC_TOKENS: ReadonlySet<string> = new Set(MODE_SEMANTIC_TOKENS)
const HEX_RE = /^#[0-9a-fA-F]{6}$/

function isColorToken(value: string): value is ModeColorToken {
  return COLOR_NAMES.has(value) || SEMANTIC_TOKENS.has(value)
}

function mergeWithTheme(req: ModeStyleRequest, theme: ThemeKey): ModeStyleRequest {
  const override = req.theme?.[theme]
  if (!override) {
    const { theme: _drop, ...rest } = req
    return rest
  }
  const merged: ModeStyleRequest = {}
  for (const surface of ["label", "arrow", "status"] as const) {
    const base = req[surface]
    const over = override[surface]
    if (base || over) merged[surface] = { ...(base ?? {}), ...(over ?? {}) }
  }
  return merged
}

function resolveSurface(req: SurfaceStyleRequest): ModeSurfaceStyle {
  return {
    fg: req.fg !== undefined ? resolveColor(req.fg) : null,
    bg: req.bg !== undefined ? resolveColor(req.bg) : null,
    bold: req.bold ?? false,
    dim: req.dim ?? false,
  }
}

function resolveColor(req: ColorRequest): ModeColor | null {
  if (req === "transparent") return null
  if (typeof req === "string") {
    if (isColorToken(req)) return { token: req, hex: null, ansi256: null }
    if (HEX_RE.test(req)) return { token: null, hex: req, ansi256: null }
    return null
  }
  const token = typeof req.token === "string" && isColorToken(req.token) ? req.token : null
  const hex = typeof req.hex === "string" && req.hex.length > 0 ? req.hex : null
  const ansi256 = typeof req.ansi256 === "number" ? req.ansi256 : null
  if (token === null && hex === null && ansi256 === null) return null
  return { token, hex, ansi256 }
}
