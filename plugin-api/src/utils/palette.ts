/**
 * Agent-owned color palette.
 *
 * Single source of truth for every named SGR-open string we paint with.
 * The agent's `c.*` helpers (`src/ui/style/ansi.ts`), the mode-style resolver
 * (`src/ui/style/mode.ts`), the theme tokens (`src/ui/theme/types.ts`), and the
 * diff-view plugin (`plugins/diff-view`) all consume from here.
 *
 * # Layers
 *
 * 1. **Legacy ANSI** — the eight 4-bit colors. Cheapest, and the user's
 *    terminal theme is authoritative over the actual pigment.
 * 2. **Modern "Cool Summer"** — saturated 256-color entries: `orange`,
 *    `pink`, `purple`, `lime`, `sky`, `violet`, `gold`. Used for the
 *    banner, prompt arrow, tool icons, and other agent-owned chrome.
 * 3. **Semantic aliases** — meaning-first tokens that point at a layer-1
 *    or layer-2 entry. Plugins should prefer these so the agent can
 *    re-skin globally without touching plugin code.
 *
 * # Plugin sharing
 *
 * Module plugins import these tokens from `@minimal-agent/plugin-api/utils/palette`.
 * Subprocess plugins receive the same data through {@link paletteEnvJson} as
 * `MINIMAL_AGENT_PALETTE` and can `JSON.parse(process.env.MINIMAL_AGENT_PALETTE)`
 * to read a `{tokenName: SGRopen}` map.
 *
 * Reuse is **opt-in, not mandatory** — every entry is a plain string, so
 * a plugin that needs bespoke terminal styling can still supply its own SGR
 * strings without importing host UI modules.
 *
 * @module palette
 */

// ---------------------------------------------------------------------------
// Layer 1: legacy ANSI (4-bit)
// ---------------------------------------------------------------------------

const LEGACY = {
  black: "\x1b[30m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightCyan: "\x1b[96m",
  brightMagenta: "\x1b[95m",
} as const

// ---------------------------------------------------------------------------
// Layer 2: modern "Cool Summer" palette (256-color, saturated)
// ---------------------------------------------------------------------------

const MODERN = {
  orange: "\x1b[38;5;208m",
  /** Hot pink / magenta. Used on the prompt arrow and `minimal-agent` banner. */
  pink: "\x1b[38;5;199m",
  purple: "\x1b[38;5;98m",
  /** Vivid spring green. Used as the modern "success / addition" green. */
  lime: "\x1b[38;5;118m",
  sky: "\x1b[38;5;45m",
  /**
   * Lavender / vivid violet. Truecolor `rgb(180, 140, 255)` (#B48CFF) —
   * matches mdstream's inline-code / H5 color so the queue-decoration
   * header reads as part of the same visual family as backtick spans
   * everywhere else. Previously 256-color 93 (#8700FF), which was too
   * dark to register against the dim-violet row numbers below it.
   */
  violet: "\x1b[38;2;180;140;255m",
  gold: "\x1b[38;5;214m",
} as const

// ---------------------------------------------------------------------------
// Combined palette (named colors)
// ---------------------------------------------------------------------------

/**
 * Named color → SGR open sequence. Keys are the strings used everywhere
 * that accepts a color name (mode style requests, `ToolColor`, etc.).
 */
export const PALETTE = {
  ...LEGACY,
  ...MODERN,
} as const

export type PaletteName = keyof typeof PALETTE

// ---------------------------------------------------------------------------
// Layer 3: semantic aliases
// ---------------------------------------------------------------------------

/**
 * Meaning-first tokens. Plugins should prefer these over picking a named
 * color, so the agent can swap the underlying pigment globally.
 *
 * - `addition` / `removal` — diff-style adds/removes. Modern pair.
 * - `success` / `error` — generic status. Modern pair.
 * - `accent` / `accent-soft` — agent chrome highlight.
 * - `muted` — de-emphasized text (use with `dim`).
 *
 * Values resolve to {@link PALETTE} entries.
 */
export const SEMANTIC: Record<string, PaletteName> = {
  addition: "lime",
  removal: "pink",
  success: "lime",
  error: "pink",
  accent: "sky",
  "accent-soft": "cyan",
  brand: "pink",
  warning: "gold",
  danger: "red",
  muted: "cyan",
}

/**
 * Resolve any token (named color or semantic alias) to its SGR open
 * string, or `null` if the token is unknown. Lookup order: literal
 * palette name → semantic alias → not found.
 */
export function resolvePaletteToken(token: string): string | null {
  if (token in PALETTE) return PALETTE[token as PaletteName]
  const aliased = SEMANTIC[token]
  if (aliased) return PALETTE[aliased]
  return null
}

/** SGR reset for foreground color only. */
export const FG_RESET = "\x1b[39m"
/** Full SGR reset. */
export const RESET = "\x1b[0m"

// ---------------------------------------------------------------------------
// Plugin env helpers
// ---------------------------------------------------------------------------

/**
 * Compact JSON of the merged palette + semantic aliases (resolved to
 * SGR open strings) suitable for injection into a plugin's environment.
 *
 * Shape: `{[token: string]: string}` — both palette names and semantic
 * aliases as keys, SGR open strings as values. Plus a `_reset` entry
 * carrying the SGR reset for convenience.
 */
export function paletteEnvJson(): string {
  const out: Record<string, string> = { ...PALETTE }
  for (const [token, name] of Object.entries(SEMANTIC)) {
    out[token] = PALETTE[name]
  }
  out._reset = RESET
  out._fgReset = FG_RESET
  return JSON.stringify(out)
}

/**
 * Parse a `MINIMAL_AGENT_PALETTE` JSON blob (as injected by the loader)
 * into a token → SGR map. Returns `null` for missing/malformed input so
 * callers can fall back to defaults.
 */
export function parsePaletteEnv(raw: string | undefined): Record<string, string> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
  } catch {
    /* fall through */
  }
  return null
}
