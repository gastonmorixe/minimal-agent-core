/**
 * Display style slots for plugin code (spec S41).
 *
 * Headless plugin code (tools, hooks, commands) must not hold terminal
 * escape bytes. It reads its display styles from a {@link StyleSlots}
 * object instead. Every slot is plain by default: a code is `""`, a style
 * returns its text unchanged, and the diff renderer returns the patch as
 * it is. So a headless host (the web host, a test) gets plain text.
 *
 * The terminal host (the CLI) loads a plugin's `ui.setup` module. That
 * module gets the {@link TerminalKit} through `ctx.tui.kit` and calls
 * {@link StyleSlots.install}. From then on the slots give terminal styles.
 *
 * This module holds no escape bytes. The terminal kit lives in the CLI.
 *
 * @module plugin-api/utils/style-slots
 */

/** A text style: returns the text with its style codes around it. */
export type TextStyle = (text: string) => string

/** Names of the raw SGR codes in a {@link TerminalKit}. */
export const TERMINAL_CODE_NAMES = [
  "RESET",
  "FG_RESET",
  "BG_RESET",
  "ERASE_LINE",
  "BOLD",
  "DIM",
  "ITALIC",
  "UNDERLINE",
  "INVERSE",
  "STRIKE",
  "BOLD_CLOSE",
  "DIM_CLOSE",
  "ITALIC_CLOSE",
  "UNDERLINE_CLOSE",
  "INVERSE_CLOSE",
  "STRIKE_CLOSE",
  "BRIGHT_BLACK",
  "DARK_GRAY",
  "LIGHT_GRAY",
  "FAINT_WHITE",
  "BOLD_WHITE",
  "BOLD_BRIGHT_RED",
  "DIM_LIME",
  "DIM_SKY",
  "DIM_GOLD",
  "DIM_RED",
  "DIM_VIOLET",
  "BOLD_SKY",
  "BOLD_LIME",
  "BOLD_GOLD",
  "BOLD_PINK",
] as const

/** Names of the text styles in a {@link TerminalKit}. */
export const TERMINAL_STYLE_NAMES = [
  "dim",
  "cyan",
  "blue",
  "magenta",
  "yellow",
  "green",
  "red",
  "white",
  "gray",
  "bold",
  "italic",
  "underline",
  "inverse",
  "brightCyan",
  "brightYellow",
  "brightGreen",
  "brightRed",
  "brightMagenta",
  "boldCyan",
  "boldGreen",
  "boldRed",
  "boldYellow",
  "boldWhite",
  "boldBrightWhite",
  "dimCyan",
  "dimRed",
  "dimViolet",
  "faintWhite",
  "strike",
  "orange",
  "pink",
  "purple",
  "lime",
  "sky",
  "violet",
  "gold",
  "redPill",
] as const

/** Names of the palette colors in a {@link TerminalKit}. */
export const TERMINAL_PALETTE_NAMES = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightCyan",
  "brightMagenta",
  "orange",
  "pink",
  "purple",
  "lime",
  "sky",
  "violet",
  "gold",
] as const

/** Raw SGR codes, by name. */
export type TerminalCodes = Record<(typeof TERMINAL_CODE_NAMES)[number], string>

/** Text styles, by name. */
export type TerminalStyles = Record<(typeof TERMINAL_STYLE_NAMES)[number], TextStyle>

/** Palette foreground codes, by color name. */
export type TerminalPalette = Record<(typeof TERMINAL_PALETTE_NAMES)[number], string>

/**
 * The display helpers of the terminal host. The CLI builds it in its
 * terminal-kit and grants it through `ctx.tui.kit` to `ui` entries only.
 */
export interface TerminalKit {
  /** Raw SGR codes. */
  readonly codes: Readonly<TerminalCodes>
  /** Text styles. */
  readonly styles: Readonly<TerminalStyles>
  /** The host palette. */
  readonly palette: Readonly<TerminalPalette>
  /** A truecolor background SGR open code. */
  bgRgb(r: number, g: number, b: number): string
  /** Render a unified diff patch as styled terminal text. */
  renderUnifiedDiff(patch: string, title?: string): string
}

/**
 * Mutable style slots for one plugin. Read a slot at call time (for
 * example `slots.styles.dim(text)`), never at module load, so a later
 * {@link StyleSlots.install} takes effect.
 */
export interface StyleSlots {
  /** Raw SGR codes. Plain: `""`. */
  readonly codes: TerminalCodes
  /** Text styles. Plain: the text unchanged. */
  readonly styles: TerminalStyles
  /** Palette codes. Plain: `""`. */
  readonly palette: TerminalPalette
  /** Truecolor background code. Plain: `""`. */
  bgRgb(r: number, g: number, b: number): string
  /** Unified diff renderer. Plain: the patch unchanged. */
  renderUnifiedDiff(patch: string, title?: string): string
  /**
   * Wrap `text` in `open` and a full reset when `on` is true. Plain slots
   * give the text unchanged.
   */
  color(on: boolean, open: string, text: string): string
  /** True after {@link StyleSlots.install} and before {@link StyleSlots.reset}. */
  installed(): boolean
  /** Fill every slot from the terminal kit. */
  install(kit: TerminalKit): void
  /** Set every slot back to plain. */
  reset(): void
}

/** The plain text style. */
const plainStyle: TextStyle = (text) => text

/** Fill `codes`, `styles`, and `palette` with plain values. */
function fillPlain(codes: TerminalCodes, styles: TerminalStyles, palette: TerminalPalette): void {
  for (const k of TERMINAL_CODE_NAMES) codes[k] = ""
  for (const k of TERMINAL_STYLE_NAMES) styles[k] = plainStyle
  for (const k of TERMINAL_PALETTE_NAMES) palette[k] = ""
}

/** Make a new set of style slots. All slots start plain. */
export function createStyleSlots(): StyleSlots {
  const codes = {} as TerminalCodes
  const styles = {} as TerminalStyles
  const palette = {} as TerminalPalette
  fillPlain(codes, styles, palette)
  let kit: TerminalKit | null = null
  return {
    codes,
    styles,
    palette,
    bgRgb: (r, g, b) => (kit ? kit.bgRgb(r, g, b) : ""),
    renderUnifiedDiff: (patch, title) => (kit ? kit.renderUnifiedDiff(patch, title) : patch),
    color: (on, open, text) => (on && kit ? `${open}${text}${codes.RESET}` : text),
    installed: () => kit !== null,
    install(next) {
      kit = next
      for (const k of TERMINAL_CODE_NAMES) codes[k] = next.codes[k]
      for (const k of TERMINAL_STYLE_NAMES) styles[k] = next.styles[k]
      for (const k of TERMINAL_PALETTE_NAMES) palette[k] = next.palette[k]
    },
    reset() {
      kit = null
      fillPlain(codes, styles, palette)
    },
  }
}
