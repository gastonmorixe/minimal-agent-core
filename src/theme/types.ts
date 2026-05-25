/**
 * Theme module — core type primitives.
 *
 * # Patterns applied
 *
 * - **Branded types** for `Hex`, `Sgr`, `TokenName`, `Hue`, `Step`. The
 *   TypeScript structural type system would otherwise let any `string`
 *   flow anywhere a `Hex` is wanted. Branding gives us nominal typing
 *   without runtime cost: `parseHex("#ff0000")` is the only constructor;
 *   downstream code that takes `Hex` can't be called with a random string.
 *
 * - **Discriminated unions** for `ColorRef`, `ColorMod`, `Capability`,
 *   `ThemeVariant`, `ThemeError`. Each variant carries exactly the fields
 *   valid for its kind. `switch (ref.kind)` is exhaustive: adding a new
 *   variant breaks every non-exhaustive consumer at compile time.
 *
 * - **Result type** for `resolveToken` / `resolveHex` failures. Errors
 *   are values, not exceptions, so consumers can choose to degrade
 *   gracefully (typo in a renderer → identity wrap, not crash).
 *
 * - **Encoder Strategy interface** declared here so concrete encoders
 *   (`encode/truecolor.ts`, `encode/ansi256.ts`, …) can be swapped at
 *   construction time without consumer code knowing which is active.
 *
 * # Why no I/O in this file
 *
 * Pure type declarations + a couple of safe constructors. No env reads,
 * no `Date.now()`, no `process.*`. Importable from anywhere, including
 * subprocess plugins, without dragging in node-only globals.
 *
 * @module theme/types
 */

// ---------------------------------------------------------------------------
// Branded primitives — nominal typing in a structural type system
// ---------------------------------------------------------------------------

declare const __brand: unique symbol

/**
 * Phantom-marker brand. The `__brand` field exists only at the type level;
 * the runtime value is a plain primitive. Two branded types built from the
 * same primitive shape are NOT assignable to each other.
 */
type Brand<T, B extends string> = T & { readonly [__brand]: B }

/** A `#RRGGBB`-shaped lowercase hex color string. Construct via {@link parseHex}. */
export type Hex = Brand<string, "Hex">

/** A complete ANSI SGR escape sequence, e.g. `\x1b[38;2;239;68;68m`. */
export type Sgr = Brand<string, "Sgr">

/**
 * A theme token name — either a base color (`"red.base"`) or a semantic
 * alias (`"danger"`, `"quota-good"`). Construction-gated so typos
 * surface as `ThemeError.unknown_token` (see {@link ThemeError}) rather
 * than silently rendering an arbitrary string.
 */
export type TokenName = Brand<string, "TokenName">

/**
 * Parse a `#rrggbb` or `#RRGGBB` string into a {@link Hex}. Three-char
 * shorthand (`#f0a`) is rejected — explicit is better, and the brand's
 * job is to guarantee a stable byte shape downstream.
 *
 * @returns the branded hex, or `null` if the input is not a valid 6-char
 *   `#rrggbb`. Never throws — keeps the type story clean for callers.
 */
export function parseHex(s: string): Hex | null {
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null
  return s.toLowerCase() as Hex
}

/**
 * Unsafe brand. Use ONLY when the source is guaranteed by a static
 * literal (`BASE_PALETTE` definitions) or by a prior {@link parseHex}.
 * Module-internal API; do not export from the public barrel.
 *
 * @internal
 */
export function unsafeHex(s: string): Hex {
  return s.toLowerCase() as Hex
}

/**
 * Brand a string as a {@link TokenName}. The actual existence check
 * happens at resolution time ({@link Theme.resolveToken}); branding
 * here just lets callers express intent in their signatures.
 */
export function asToken(s: string): TokenName {
  return s as TokenName
}

/**
 * Brand a fully-formed SGR sequence as {@link Sgr}. Module-internal —
 * only the encoder strategy implementations and the SGR constants
 * (`RESET`, `FG_RESET`) construct these.
 *
 * @internal
 */
export function unsafeSgr(s: string): Sgr {
  return s as Sgr
}

// ---------------------------------------------------------------------------
// Hue / Step — the structure of the base palette
// ---------------------------------------------------------------------------

/**
 * The 13 base hues. Each carries a 5-step scale (see {@link Step}).
 *
 * Naming convention: lowercase color noun. Avoid intermediate names
 * (e.g. "indigo" vs "blue") that overlap perceptually — every hue here
 * is at least 30° apart in OKLCH hue angle.
 */
export type Hue =
  | "red"
  | "orange"
  | "yellow"
  | "lime"
  | "green"
  | "teal"
  | "cyan"
  | "blue"
  | "indigo"
  | "violet"
  | "magenta"
  | "pink"
  | "gray"

export const HUES: readonly Hue[] = [
  "red",
  "orange",
  "yellow",
  "lime",
  "green",
  "teal",
  "cyan",
  "blue",
  "indigo",
  "violet",
  "magenta",
  "pink",
  "gray",
] as const

/**
 * Scale steps within a hue. Symmetric around `base` so derivations like
 * `lighten(base) ≈ bright` are conceptually meaningful.
 *
 * Why 5 steps and not Tailwind's 11? Terminal UIs rarely need fine-grained
 * shading — most paint a single fg/bg per glyph. Five steps cover
 * "background fill / text foreground / accent / emphasis / hover".
 * Callers wanting finer steps can derive on demand via {@link ColorMod}.
 */
export type Step = "darker" | "dark" | "base" | "bright" | "brighter"

export const STEPS: readonly Step[] = ["darker", "dark", "base", "bright", "brighter"] as const

// ---------------------------------------------------------------------------
// ColorRef — how a semantic token points at a concrete color
// ---------------------------------------------------------------------------

/**
 * A reference to a color value. Three variants:
 *
 * - `base` — direct pointer into `BASE_PALETTE[hue][step]`. Most common.
 * - `derived` — apply a {@link ColorMod} to another ref. Composable.
 * - `literal` — embed a hex literal directly. Escape hatch for one-offs
 *   (e.g. a brand color that doesn't belong in the general palette).
 *
 * Discriminated by `kind`. The pattern shows up wherever the codebase
 * needs to know "where this color came from" without losing the value.
 */
export type ColorRef =
  | { readonly kind: "base"; readonly hue: Hue; readonly step: Step }
  | { readonly kind: "derived"; readonly from: ColorRef; readonly mod: ColorMod }
  | { readonly kind: "literal"; readonly hex: Hex }

/**
 * A unary color transformation. Discriminated by `kind`. All modifications
 * operate in OKLCH (perceptually uniform) — see `derive/ops.ts`.
 *
 * `amount` ranges are conventionally `0..1`. Out-of-range values are
 * clamped, never thrown — the derivation pipeline never crashes a render.
 */
export type ColorMod =
  | { readonly kind: "lighten"; readonly amount: number }
  | { readonly kind: "darken"; readonly amount: number }
  | { readonly kind: "saturate"; readonly amount: number }
  | { readonly kind: "desaturate"; readonly amount: number }
  | { readonly kind: "mix"; readonly with: ColorRef; readonly t: number }
  | {
      readonly kind: "alpha"
      readonly against: ColorRef
      readonly opacity: number
    }

// ---------------------------------------------------------------------------
// Capability — what the active terminal can actually display
// ---------------------------------------------------------------------------

/**
 * Terminal color capability. Discriminated by `kind` for exhaustive
 * matching at the encoder selection site (`encode/index.ts`).
 *
 * - `truecolor` — 24-bit RGB SGRs (`\x1b[38;2;r;g;b m`). Universal on
 *   modern terminals (iTerm, kitty, Alacritty, WezTerm, recent Terminal.app,
 *   Windows Terminal). Signaled by `COLORTERM=truecolor` / `=24bit`.
 * - `ansi256` — 256-color cube + grayscale ramp. Older xterm-256color.
 * - `ansi16` — legacy 4-bit colors (30-37, 90-97). VT100-class.
 * - `mono` — no color at all (CI logs, dumb terminals, NO_COLOR honoured).
 */
export type Capability =
  | { readonly kind: "truecolor" }
  | { readonly kind: "ansi256" }
  | { readonly kind: "ansi16" }
  | { readonly kind: "mono" }

// ---------------------------------------------------------------------------
// ThemeVariant — dark / light / high-contrast overrides
// ---------------------------------------------------------------------------

/**
 * Active theme variant. Drives which override map (`semantic/variants.ts`)
 * shadows the base `SEMANTIC_TOKENS` map. The default is `"dark"`; the
 * user can override via `MINIMAL_AGENT_THEME` env.
 */
export type ThemeVariant = "dark" | "light" | "high-contrast"

export const THEME_VARIANTS: readonly ThemeVariant[] = ["dark", "light", "high-contrast"] as const

// ---------------------------------------------------------------------------
// Result — typed errors for the resolution path
// ---------------------------------------------------------------------------

/**
 * A tagged `Result<T, E>` for theme resolution. Callers `switch` on `ok`
 * (TypeScript narrows the union). Errors are values; no exceptions
 * cross the theme module's boundary.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error })

/**
 * Closed error union for the theme module. The `kind` discriminant
 * lets consumers branch precisely and surface targeted diagnostics.
 *
 * `unknown_token` is the typo case — most renderers degrade to identity.
 * `invalid_hex` is the malformed-literal case — encoder rejects.
 * `derive_failed` is the math-edge case (e.g. mixing two literals where
 * one is a non-color); rare but possible at edge cases.
 */
export type ThemeError =
  | { readonly kind: "unknown_token"; readonly token: string }
  | { readonly kind: "invalid_hex"; readonly value: string }
  | { readonly kind: "derive_failed"; readonly cause: string }

// ---------------------------------------------------------------------------
// Encoder strategy — pluggable hex → SGR
// ---------------------------------------------------------------------------

/**
 * One encoder implementation. Pure: `(hex) => Sgr`. Three concrete
 * impls ship (`truecolor`, `ansi256`, `ansi16`) plus a `mono` no-op.
 *
 * Selected by {@link Capability} at theme construction. Swap-friendly
 * for testing — tests inject a fake encoder to assert what the theme
 * tried to render without depending on the encoder's own correctness.
 */
export interface Encoder {
  /**
   * Encode a hex color as the foreground-setting SGR sequence.
   * Returns a complete sequence including the leading `\x1b[`.
   */
  fg(hex: Hex): Sgr
  /** Encode a hex color as the background-setting SGR sequence. */
  bg(hex: Hex): Sgr
  /** This encoder's capability tag — for introspection / logging. */
  readonly capability: Capability
}

// ---------------------------------------------------------------------------
// SGR constants — module-wide invariants
// ---------------------------------------------------------------------------

/** Full SGR reset. Brand-safe because constructed from a literal. */
export const RESET: Sgr = unsafeSgr("\x1b[0m")
/** Foreground-color reset only. Preserves bold/dim/italic state. */
export const FG_RESET: Sgr = unsafeSgr("\x1b[39m")
/** Background-color reset only. */
export const BG_RESET: Sgr = unsafeSgr("\x1b[49m")
/** Bold open. */
export const BOLD: Sgr = unsafeSgr("\x1b[1m")
/** Bold/dim close (paired with both opens; SGR 22 resets weight). */
export const WEIGHT_RESET: Sgr = unsafeSgr("\x1b[22m")
/** Dim open. */
export const DIM: Sgr = unsafeSgr("\x1b[2m")
/** Italic open. */
export const ITALIC: Sgr = unsafeSgr("\x1b[3m")
/** Italic close. */
export const ITALIC_RESET: Sgr = unsafeSgr("\x1b[23m")
/** Underline open. */
export const UNDERLINE: Sgr = unsafeSgr("\x1b[4m")
/** Underline close. */
export const UNDERLINE_RESET: Sgr = unsafeSgr("\x1b[24m")
/** Strikethrough open. */
export const STRIKE: Sgr = unsafeSgr("\x1b[9m")
/** Strikethrough close. */
export const STRIKE_RESET: Sgr = unsafeSgr("\x1b[29m")

// ---------------------------------------------------------------------------
// Theme facade interface — what plugins and renderers consume
// ---------------------------------------------------------------------------

/** A text-wrapping function. `theme.fg("danger")` returns one of these. */
export type Wrap = (s: string) => string

/**
 * The Theme facade. Hides palette, derivation, encoder, and memoization
 * behind a small, stable interface.
 *
 * # Patterns applied
 * - **Facade**: 11 methods cover all consumer needs; the underlying
 *   palette/derive/encode subsystems stay private.
 * - **Dependency injection**: passed through plugin contexts; never a
 *   module-level singleton.
 * - **Flyweight**: identical `(token, mod)` resolutions return the same
 *   SGR string by reference (per-Theme cache).
 *
 * Construct via {@link buildTheme} (see `theme.ts`).
 */
export interface Theme {
  /** Active capability — drives encoder selection. */
  readonly caps: Capability
  /** Active variant — drives semantic override selection. */
  readonly variant: ThemeVariant

  /**
   * Wrap text in a token's foreground color. Returns a wrapper that
   * prepends the SGR open and appends `FG_RESET`. Unknown tokens
   * degrade to identity (no color) — see {@link Theme.resolveToken}
   * for typed-error introspection.
   *
   * Token forms accepted: `"red.base"`, `"red"` (=> `red.base`),
   * semantic alias (`"danger"`), or a {@link TokenName} brand.
   */
  fg(token: TokenName | string): Wrap

  /** Wrap text in a token's background color. */
  bg(token: TokenName | string): Wrap

  /**
   * Wrap text in a token's foreground color, plus bold. Combined
   * SGR for compactness (one open instead of two).
   */
  fgBold(token: TokenName | string): Wrap

  /**
   * Wrap text in a token's foreground color, plus dim. Combined SGR.
   */
  fgDim(token: TokenName | string): Wrap

  /**
   * Derive a one-off color by applying `mod` to `token`, then wrap.
   * The resolution is memoized like the base methods, so repeated
   * derive calls with identical inputs return the same SGR string.
   *
   * Use sparingly — prefer adding a semantic token if the derivation
   * shows up in more than one consumer.
   */
  derive(token: TokenName | string, mod: ColorMod): Wrap

  /** Plain dim attribute (`\x1b[2m...\x1b[22m`). No color. */
  readonly dim: Wrap
  /** Plain bold attribute. */
  readonly bold: Wrap
  /** Plain italic attribute. */
  readonly italic: Wrap
  /** Plain underline attribute. */
  readonly underline: Wrap
  /** Plain strikethrough attribute. */
  readonly strike: Wrap

  /**
   * Resolve a token to its final foreground SGR (no wrapping). Returns
   * a `Result` so callers can distinguish "rendered nothing because
   * the token was unknown" from "rendered nothing because the token's
   * value happened to be an identity transform".
   */
  resolveToken(token: TokenName | string): Result<Sgr, ThemeError>

  /**
   * Resolve a token (post-variant override, post-derivation) to its
   * concrete hex value. Useful for compositing layers (e.g. alpha
   * blending fg onto bg).
   */
  resolveHex(token: TokenName | string): Result<Hex, ThemeError>
}
