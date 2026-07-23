/**
 * Mode-style resolver.
 *
 * Bridges the *declarative* `ModeStyleRequest` from a plugin manifest to a
 * concrete `ResolvedModeStyle` the TUI can render without making any color
 * decisions of its own.
 *
 * Layering (see `work/mode-style-spec.md` §2):
 *
 *   manifest.json  ──parse──▶  ModeStyleRequest
 *                                    │
 *                          resolveModeStyle(request, env)
 *                                    │
 *                                    ▼
 *                              ResolvedModeStyle  ──▶  TUI render
 *
 * The resolver is the *policy* layer: it owns the palette, picks SGR
 * sequences from terminal capability, drops backgrounds that fail contrast,
 * truncates over-long labels, etc. Plugins never paint pixels.
 *
 * # MVP scope
 *
 * Per the user's instruction ("don't hardcode hexes now, use the ANSI ones
 * so it keeps as it renders now"), the resolver currently emits only the
 * SGR sequences from the existing `c.*` helpers in `agent.ts`. Semantic
 * tokens (`accent`, `accent-soft`, `danger`, `muted`) are mapped to legacy
 * ANSI names so the user's terminal theme stays in charge of the actual
 * pigment. Hex values from manifests are passed through as 24-bit truecolor
 * SGR; the contrast/identity guards still apply.
 *
 * The mdstream rainbow palette (`work/mode-style-spec.md` §4.4 future work)
 * is the planned upgrade path once we have theme detection and a real test
 * harness.
 *
 * @module utils/mode-style
 */

import type { ColorRequest, ModeStyleRequest, ThemeKey } from "../types/plugin.ts"
import { ANSI_CODES } from "./ansi.ts"
import { PALETTE, SEMANTIC } from "./palette.ts"
import { truncateDisplayWidth } from "./term-width.ts"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Concrete render output for one surface (label / arrow / status).
 *
 * `fgOpen` / `bgOpen` are pre-baked SGR open sequences. To render, the TUI
 * concatenates `fgOpen + bgOpen + (bold? "\x1b[1m" : "") + text + reset`.
 * `null` means "do not paint this attribute" — for `bg` that's the
 * transparent default; for `fg` it means "inherit terminal default".
 */
export interface ResolvedSurfaceStyle {
  fgOpen: string | null
  bgOpen: string | null
  bold: boolean
  dim: boolean
}

/** Concrete style for all three surfaces, plus the cached reset string. */
export interface ResolvedModeStyle {
  label: ResolvedSurfaceStyle
  arrow: ResolvedSurfaceStyle
  status: ResolvedSurfaceStyle
  /** SGR reset. Use after every painted run. */
  reset: string
}

/** Inputs to the resolver. */
export interface StyleEnv {
  theme: ThemeKey
  capability: "truecolor" | "ansi256" | "ansi16"
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESET = ANSI_CODES.RESET

/**
 * Maximum visible label length before truncation. Picked at 8 because the
 * common cases (`ASK`, `PLAN`, `REVIEW`, `RECORD`) all fit and the prompt
 * stays compact on narrow terminals.
 */
export const MAX_LABEL_WIDTH = 8

/**
 * SGR open sequences per legacy color name. Mirrors the bodies of the
 * `c.*` helpers in `agent.ts`. Kept in sync by hand — there are only 12
 * entries and they don't change often.
 *
 * Keeping the open sequence (not a wrapper function) lets us compose with
 * background and bold/dim without nesting resets.
 */
// SGR open sequences per palette name. Sourced from the shared plugin-api
// palette so host UI and plugin chrome can never drift.
const LEGACY_FG_OPEN: Record<string, string> = {
  cyan: PALETTE.cyan,
  blue: PALETTE.blue,
  magenta: PALETTE.magenta,
  yellow: PALETTE.yellow,
  green: PALETTE.green,
  red: PALETTE.red,
  orange: PALETTE.orange,
  pink: PALETTE.pink,
  purple: PALETTE.purple,
  lime: PALETTE.lime,
  sky: PALETTE.sky,
  gold: PALETTE.gold,
}

/**
 * Semantic token → palette color name. Subset of `SEMANTIC` in
 * the shared plugin-api palette — the resolver only honors tokens that map
 * to a color name we expose for mode style. Override locally if a mode-style
 * surface should pick a different pigment than the broad semantic.
 */
const SEMANTIC_TO_LEGACY: Record<string, string> = {
  accent: "blue", // mode-style prefers calm blue over the brand sky
  "accent-soft": SEMANTIC["accent-soft"],
  // Brand primary — same pigment as the default prompt arrow (`❯`).
  brand: SEMANTIC.brand,
  danger: SEMANTIC.danger,
  muted: SEMANTIC.muted,
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect the resolver's environment from process state.
 *
 * - `theme` from `MINIMAL_AGENT_THEME` (`dark` | `light` | `high-contrast`),
 *   defaulting to `dark` when unset/invalid. We don't sniff `COLORFGBG` or
 *   OSC 11 yet; that's a future hook.
 * - `capability` from `COLORTERM` (truecolor) and `TERM` (256-color
 *   substring), falling back to `ansi16`.
 */
export function detectStyleEnv(env: NodeJS.ProcessEnv = process.env): StyleEnv {
  let theme: ThemeKey = "dark"
  const t = env.MINIMAL_AGENT_THEME
  if (t === "light" || t === "dark" || t === "high-contrast") theme = t

  let capability: StyleEnv["capability"] = "ansi16"
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") {
    capability = "truecolor"
  } else if ((env.TERM ?? "").includes("256")) {
    capability = "ansi256"
  }

  return { theme, capability }
}

/**
 * Resolve a mode's declarative style request to concrete ANSI sequences.
 *
 * Steps:
 *
 * 1. Merge the base request with the active theme override (theme wins
 *    surface-by-surface, surface-by-key).
 * 2. Resolve `fg`/`bg` color requests to SGR open strings using the palette
 *    and capability.
 * 3. Apply policy: identity guard (`bg == fg` → drop bg), contrast guard
 *    (currently a no-op in ANSI-only mode — we don't know hex values for
 *    legacy colors), label width cap is enforced at the call site
 *    in `ModeManager.promptPrefix`.
 * 4. **No implicit inheritance** between surfaces. If a mode wants its
 *    arrow blue, it must say so. This keeps the A/B knob honest: "label
 *    only" means *only* the label is repainted; the agent's default arrow
 *    styling stays in charge. (Earlier drafts inherited `arrow.fg` from
 *    `label.fg`; that defeated the toggle and was reverted.)
 */
export function resolveModeStyle(
  request: ModeStyleRequest,
  env: StyleEnv = detectStyleEnv(),
): ResolvedModeStyle {
  // 1. Theme merge.
  const merged = mergeWithTheme(request, env.theme)

  // 2. Resolve each surface independently. No implicit inheritance — a
  //    mode that sets only `label` does NOT also recolor arrow/status.
  const label = resolveSurface(merged.label ?? {}, env)
  const arrow = resolveSurface(merged.arrow ?? {}, env)
  const status = resolveSurface(merged.status ?? {}, env)

  return { label, arrow, status, reset: RESET }
}

/**
 * Synthesize a `ModeStyleRequest` from the legacy `color` shorthand.
 *
 * Pre-style-block rendering colored the *label only* — the arrow and
 * status stayed at the agent's defaults. Mirror that exactly so manifests
 * that only declare `color` render bit-identically before/after this
 * change. Plugin authors who want a colored arrow opt in by upgrading to
 * `style.arrow.fg`.
 *
 * Returns `null` when `color` is null/undefined.
 */
export function styleFromLegacyColor(color: string | null | undefined): ModeStyleRequest | null {
  if (!color) return null
  return { label: { fg: color, bold: true } }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Merge a `ModeStyleRequest`'s base shape with its `theme[active]` override.
 * Per-surface, per-key, with the theme override taking precedence. Returns
 * a flattened request without the `theme` field.
 */
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
    if (base || over) {
      merged[surface] = { ...(base ?? {}), ...(over ?? {}) }
    }
  }
  return merged
}

function resolveSurface(
  req: { fg?: ColorRequest; bg?: ColorRequest; bold?: boolean; dim?: boolean },
  env: StyleEnv,
): ResolvedSurfaceStyle {
  const fgOpen = req.fg !== undefined ? colorRequestToFgSgr(req.fg, env) : null
  let bgOpen = req.bg !== undefined ? colorRequestToBgSgr(req.bg, env) : null

  // Identity guard: if fg and bg resolve to the *same* sequence, drop bg.
  if (fgOpen && bgOpen && sameColorPayload(fgOpen, bgOpen)) bgOpen = null

  return {
    fgOpen,
    bgOpen,
    bold: req.bold ?? false,
    dim: req.dim ?? false,
  }
}

/** Strip the leading "3" or "4" of an SGR color so fg and bg compare. */
function sameColorPayload(fg: string, bg: string): boolean {
  // Cheap: drop the first numeric character of the sequence body.
  // `\x1b[34m` ↔ `\x1b[44m`, `\x1b[38;5;199m` ↔ `\x1b[48;5;199m`.
  const norm = (s: string) => s.replace(/\x1b\[([34])(8?;?)/, "X")
  return norm(fg) === norm(bg)
}

function colorRequestToFgSgr(req: ColorRequest, env: StyleEnv): string | null {
  if (req === "transparent") return null
  if (typeof req === "string") {
    // Legacy or token or hex.
    if (req in LEGACY_FG_OPEN) return LEGACY_FG_OPEN[req]
    if (req in SEMANTIC_TO_LEGACY) return LEGACY_FG_OPEN[SEMANTIC_TO_LEGACY[req]]
    if (/^#[0-9a-fA-F]{6}$/.test(req)) return hexToFgSgr(req, env)
    return null
  }
  // Object form: prefer richest the terminal supports.
  if (env.capability === "truecolor" && req.hex) return hexToFgSgr(req.hex, env)
  if (req.ansi256 != null) return `\x1b[38;5;${req.ansi256}m`
  if (req.token) {
    if (req.token in LEGACY_FG_OPEN) return LEGACY_FG_OPEN[req.token]
    if (req.token in SEMANTIC_TO_LEGACY) return LEGACY_FG_OPEN[SEMANTIC_TO_LEGACY[req.token]]
  }
  if (req.hex) return hexToFgSgr(req.hex, env)
  return null
}

function colorRequestToBgSgr(req: ColorRequest, env: StyleEnv): string | null {
  if (req === "transparent") return null
  const fg = colorRequestToFgSgr(req, env)
  if (!fg) return null
  // Convert fg SGR → bg SGR. `\x1b[3Nm` → `\x1b[4Nm`; `\x1b[38;5;Nm` → `\x1b[48;5;Nm`;
  // `\x1b[38;2;R;G;Bm` → `\x1b[48;2;R;G;Bm`.
  return fg.replace("\x1b[3", "\x1b[4")
}

function hexToFgSgr(hex: string, env: StyleEnv): string | null {
  if (env.capability !== "truecolor") {
    // Future: nearest-256 fallback. For MVP, drop hex on non-truecolor terms
    // so the terminal default kicks in instead of a wrong color.
    return null
  }
  const m = hex.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/)
  if (!m) return null
  const r = parseInt(m[1], 16)
  const g = parseInt(m[2], 16)
  const b = parseInt(m[3], 16)
  return `\x1b[38;2;${r};${g};${b}m`
}

// ---------------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------------

/**
 * Paint `text` with a resolved surface style. Handles bold, dim, fg, bg,
 * and a clean SGR reset.
 */
export function paint(text: string, style: ResolvedSurfaceStyle): string {
  const opens: string[] = []
  if (style.bold) opens.push("\x1b[1m")
  if (style.dim) opens.push("\x1b[2m")
  if (style.fgOpen) opens.push(style.fgOpen)
  if (style.bgOpen) opens.push(style.bgOpen)
  if (opens.length === 0) return text
  return `${opens.join("")}${text}${RESET}`
}

/**
 * Truncate a label to {@link MAX_LABEL_WIDTH} *display cells* with an ellipsis.
 * Plugin authors are not expected to hit this in practice — it's a guardrail
 * against a misbehaving manifest stuffing the prompt full of text.
 *
 * Measures and cuts by terminal display width, not `.length` (B-072): the old
 * code-unit math counted a 2-cell CJK glyph as 1 (so a full-width label
 * overflowed the prompt) and sliced on a UTF-16 boundary (splitting a surrogate
 * pair into mojibake). `truncateDisplayWidth` counts real cells and never
 * splits a codepoint, while preserving the prior shape: a body of
 * `MAX_LABEL_WIDTH - 3` cells plus a 3-cell `"..."`.
 */
export function clampLabel(label: string): string {
  return truncateDisplayWidth(label, MAX_LABEL_WIDTH, "...")
}
