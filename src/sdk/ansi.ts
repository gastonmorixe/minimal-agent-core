/**
 * Minimal ANSI style helpers for the SDK core.
 *
 * Self-contained copy of the subset of `src/ui/style/ansi.ts` that the
 * agent core needs for transcript output. The full ANSI module lives in
 * the host package; the SDK core only depends on this minimal subset so
 * it stays free of UI imports.
 *
 * @module sdk/ansi
 */

const ANSI_CODES = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  DIM: "\x1b[2m",
  ITALIC: "\x1b[3m",
  FG_RESET: "\x1b[39m",
  FG_BLACK: "\x1b[30m",
  FG_RED: "\x1b[31m",
  FG_GREEN: "\x1b[32m",
  FG_YELLOW: "\x1b[33m",
  FG_BLUE: "\x1b[34m",
  FG_MAGENTA: "\x1b[35m",
  FG_CYAN: "\x1b[36m",
  FG_WHITE: "\x1b[37m",
  FG_BRIGHT_BLACK: "\x1b[90m",
  FG_BRIGHT_RED: "\x1b[91m",
  FG_BRIGHT_GREEN: "\x1b[92m",
  FG_BRIGHT_YELLOW: "\x1b[93m",
  FG_BRIGHT_BLUE: "\x1b[94m",
  FG_BRIGHT_MAGENTA: "\x1b[95m",
  FG_BRIGHT_CYAN: "\x1b[96m",
  FG_BRIGHT_WHITE: "\x1b[97m",
} as const

function wrap(code: string, text: string): string {
  return `${code}${text}${ANSI_CODES.RESET}`
}

export const c = {
  reset: (text: string) => wrap(ANSI_CODES.RESET, text),
  bold: (text: string) => wrap(ANSI_CODES.BOLD, text),
  dim: (text: string) => wrap(ANSI_CODES.DIM, text),
  italic: (text: string) => wrap(ANSI_CODES.ITALIC, text),
  red: (text: string) => wrap(ANSI_CODES.FG_RED, text),
  green: (text: string) => wrap(ANSI_CODES.FG_GREEN, text),
  yellow: (text: string) => wrap(ANSI_CODES.FG_YELLOW, text),
  blue: (text: string) => wrap(ANSI_CODES.FG_BLUE, text),
  magenta: (text: string) => wrap(ANSI_CODES.FG_MAGENTA, text),
  cyan: (text: string) => wrap(ANSI_CODES.FG_CYAN, text),
  white: (text: string) => wrap(ANSI_CODES.FG_WHITE, text),
  boldRed: (text: string) => wrap(`${ANSI_CODES.BOLD}${ANSI_CODES.FG_RED}`, text),
  boldGreen: (text: string) => wrap(`${ANSI_CODES.BOLD}${ANSI_CODES.FG_GREEN}`, text),
  boldYellow: (text: string) => wrap(`${ANSI_CODES.BOLD}${ANSI_CODES.FG_YELLOW}`, text),
  boldCyan: (text: string) => wrap(`${ANSI_CODES.BOLD}${ANSI_CODES.FG_CYAN}`, text),
  dimCyan: (text: string) => wrap(`${ANSI_CODES.DIM}${ANSI_CODES.FG_CYAN}`, text),
  faintWhite: (text: string) => wrap(`${ANSI_CODES.DIM}${ANSI_CODES.FG_WHITE}`, text),
  pink: (text: string) => wrap(ANSI_CODES.FG_BRIGHT_MAGENTA, text),
}
