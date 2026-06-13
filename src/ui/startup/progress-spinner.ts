/**
 * Shared startup progress spinner chrome.
 *
 * Startup/bootstrap modules decide what work to do and which phase labels to
 * show; this UI helper owns the terminal drawing, glyphs, and TTY gating.
 *
 * @module ui/startup/progress-spinner
 */

import { ansiStyle as A, ANSI_CODES } from "@minimal-agent/plugin-api/utils/ansi"

import { BREATHING_DOT } from "../spinner/library/frames.ts"
import { ANSI_PALETTE_RAINBOW } from "../spinner/library/palettes.ts"

interface SpinnerStream {
  isTTY?: boolean
  write(chunk: string): unknown
}

/** Mutating handle returned by {@link startStartupProgressSpinner}. */
export interface StartupProgressSpinner {
  setPhase(label: string): void
  done(finalLine: string): void
  fail(errorLine: string): void
}

/** Options for {@link startStartupProgressSpinner}. */
export interface StartupProgressSpinnerOptions {
  /** Master switch for callers with config/env gates. Defaults to true. */
  enabled?: boolean
  /** Output stream. Defaults to stderr; tests pass a collector. */
  stream?: SpinnerStream
}

/** Shared tree-prefix used by startup rows. */
export const STARTUP_PIPE = `  ${A.faintWhite("│")} `

const NOOP_SPINNER: StartupProgressSpinner = {
  setPhase() {},
  done() {},
  fail() {},
}

/**
 * Start an animated breathing-dot spinner that overwrites a single output line.
 *
 * Each frame of `BREATHING_DOT` (`· ∙ • ● • ∙`) is painted with the shared
 * rainbow palette so all startup fetch/install flows use identical chrome.
 */
export function startStartupProgressSpinner(
  initialLabel: string,
  opts: StartupProgressSpinnerOptions = {},
): StartupProgressSpinner {
  const stream = opts.stream ?? process.stderr
  const enabled = opts.enabled ?? true
  if (!enabled || stream.isTTY !== true) return NOOP_SPINNER

  let phase = initialLabel
  let frameIdx = 0
  let colorIdx = 0

  function coloredFrame(): string {
    const char = BREATHING_DOT[frameIdx] ?? "·"
    const colorize = ANSI_PALETTE_RAINBOW[colorIdx % ANSI_PALETTE_RAINBOW.length]!
    return colorize(char)
  }

  function renderLine(): string {
    return `\r${STARTUP_PIPE} ${coloredFrame()} ${phase}`
  }

  stream.write(`${STARTUP_PIPE}\n`)
  stream.write(renderLine())

  const timer = setInterval(() => {
    frameIdx = (frameIdx + 1) % BREATHING_DOT.length
    colorIdx++
    stream.write(renderLine())
  }, 160)

  function stop(finalGlyph: string, finalLabel: string): void {
    clearInterval(timer)
    stream.write(`\r${ANSI_CODES.ERASE_LINE}${STARTUP_PIPE} ${finalGlyph} ${finalLabel}\n`)
    stream.write(`${STARTUP_PIPE}\n`)
  }

  return {
    setPhase(label) {
      phase = label
    },
    done(finalLine) {
      stop(A.boldGreen("✔"), finalLine)
    },
    fail(errorLine) {
      stop(A.boldRed("✗"), errorLine)
    },
  }
}
