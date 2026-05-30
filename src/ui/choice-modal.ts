/**
 * Generic choice modal for the live area.
 *
 * Renders a title, a wrapped body paragraph, and N labelled options the
 * user picks between via Left/Right (or Tab) + Enter. Esc returns null
 * (cancel). Single-character shortcuts on each option label's first
 * letter are also accepted when unambiguous.
 *
 * This is a pure {@link LiveOverlay} : it renders strings and consumes
 * normalized keys, no I/O. Hosts (e.g. `runReplLiveArea`) drive it by
 * routing keys via the {@link InputCaptureStack} and painting the
 * `render()` output into the footer overlay layer.
 *
 * Result shape: `string | null` (the chosen option's `id`, or null on
 * Esc). The host promise wrapper translates `null` into a cancel signal.
 *
 * @module ui/choice-modal
 */

import { displayWidth } from "../term-width.ts"

import type { LiveOverlay, OverlayKey } from "./overlay.ts"

export interface ChoiceOption {
  /** Stable id returned to the caller when this option is picked. */
  id: string
  /** Short button caption. Used to compute the single-char shortcut. */
  label: string
  /** Optional one-line explanation rendered beneath the label group. */
  description?: string
  /** True if picking this would lose state; renders with a warning glyph. */
  destructive?: boolean
}

export interface ChoiceModalOpts {
  /** One-line title at the top of the modal. */
  title: string
  /**
   * Body text. Lines split on `\n`; each line is then word-wrapped to
   * the modal's available width at render time.
   */
  body: string
  /** Two or more options. */
  options: ChoiceOption[]
  /** Initial selection (0-indexed). Defaults to 0. */
  defaultIndex?: number
}

const FOCUS_LEFT = "❮"
const FOCUS_RIGHT = "❯"
const WARN_GLYPH = "⚠"
const FRAME_TOP_LEFT = "╭"
const FRAME_TOP_RIGHT = "╮"
const FRAME_BOT_LEFT = "╰"
const FRAME_BOT_RIGHT = "╯"
const FRAME_H = "─"
const FRAME_V = "│"

const DEFAULT_WIDTH = 60
const MIN_INNER_WIDTH = 30

// ANSI helpers ; kept local so the module doesn't pull in the agent palette.
const ANSI = {
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  fgYellow: "\x1b[33m",
  fgPink: "\x1b[38;5;213m",
  fgGray: "\x1b[38;5;244m",
}

function color(s: string, code: string): string {
  return `${code}${s}${ANSI.reset}`
}

export class ChoiceModal implements LiveOverlay {
  private selectedIndex: number
  private readonly opts: ChoiceModalOpts
  /** Width passed to the most recent `render()`. Used by `rowsHint()`. */
  private lastWidth = DEFAULT_WIDTH

  constructor(opts: ChoiceModalOpts) {
    if (opts.options.length < 1) {
      throw new Error("ChoiceModal: at least one option required")
    }
    this.opts = opts
    const def = opts.defaultIndex ?? 0
    this.selectedIndex = Number.isInteger(def) && def >= 0 && def < opts.options.length ? def : 0
  }

  /** Currently selected option (read-only access for tests/diagnostics). */
  get currentIndex(): number {
    return this.selectedIndex
  }

  render(width: number): string[] {
    const effectiveWidth = Math.max(MIN_INNER_WIDTH + 4, width > 0 ? width : DEFAULT_WIDTH)
    this.lastWidth = effectiveWidth
    const innerWidth = effectiveWidth - 4 // 2 for borders, 2 for left/right padding
    const lines: string[] = []

    // Top border
    lines.push(`${FRAME_TOP_LEFT}${FRAME_H.repeat(effectiveWidth - 2)}${FRAME_TOP_RIGHT}`)

    // Title row
    lines.push(this.framedLine(color(this.opts.title, ANSI.bold), innerWidth))

    // Separator
    lines.push(`${FRAME_V} ${" ".repeat(innerWidth)} ${FRAME_V}`)

    // Body — split on \n then word-wrap each segment.
    const bodyParts = this.opts.body.split("\n")
    for (const part of bodyParts) {
      const wrapped = wrapText(part, innerWidth)
      for (const wline of wrapped) {
        lines.push(this.framedLine(wline, innerWidth))
      }
    }

    // Blank row before options
    lines.push(`${FRAME_V} ${" ".repeat(innerWidth)} ${FRAME_V}`)

    // Options row(s). If they fit on one line use single row, otherwise stack.
    const buttonStrings = this.opts.options.map((opt, idx) => this.renderButton(opt, idx))
    const buttonRowOneLine = buttonStrings.join("  ")
    const buttonRowWidth = displayWidth(buttonRowOneLine)

    if (buttonRowWidth <= innerWidth) {
      lines.push(this.framedLine(buttonRowOneLine, innerWidth))
    } else {
      for (const btn of buttonStrings) {
        lines.push(this.framedLine(btn, innerWidth))
      }
    }

    // Optional descriptions for the currently focused option only (keeps the
    // modal compact: hovering a different option swaps the description).
    const focused = this.opts.options[this.selectedIndex]
    if (focused?.description) {
      lines.push(`${FRAME_V} ${" ".repeat(innerWidth)} ${FRAME_V}`)
      const descLines = wrapText(focused.description, innerWidth)
      for (const dline of descLines) {
        lines.push(this.framedLine(color(dline, ANSI.dim), innerWidth))
      }
    }

    // Hint row: keybinding cheatsheet. Plain text is wrapped if it's
    // too wide, otherwise it lands on a single line. We wrap the plain
    // form, then color the resulting lines so the dim ANSI stays
    // per-line (otherwise reset codes confuse word-wrapping).
    lines.push(`${FRAME_V} ${" ".repeat(innerWidth)} ${FRAME_V}`)
    const hintPlain = "← →: navigate   Enter: confirm   Esc: cancel"
    const hintLines = wrapText(hintPlain, innerWidth)
    for (const hl of hintLines) {
      lines.push(this.framedLine(color(hl, ANSI.dim), innerWidth))
    }

    // Bottom border
    lines.push(`${FRAME_BOT_LEFT}${FRAME_H.repeat(effectiveWidth - 2)}${FRAME_BOT_RIGHT}`)

    return lines
  }

  onKey(key: OverlayKey): "stay" | { close: true; result: string | null } {
    switch (key.name) {
      case "left":
      case "up":
        this.selectedIndex =
          (this.selectedIndex - 1 + this.opts.options.length) % this.opts.options.length
        return "stay"
      case "right":
      case "down":
      case "tab":
        this.selectedIndex = (this.selectedIndex + 1) % this.opts.options.length
        return "stay"
      case "enter": {
        const chosen = this.opts.options[this.selectedIndex]
        return { close: true, result: chosen ? chosen.id : null }
      }
      case "escape":
        return { close: true, result: null }
      case "char": {
        // Single-char shortcut: match the first non-whitespace char of any
        // label, case-insensitive. Ambiguous shortcuts are ignored
        // (deterministic: do nothing rather than guess).
        const ch = key.ch.toLowerCase()
        if (ch.length !== 1) return "stay"
        const matches = this.opts.options.filter((o) => {
          const first = firstShortcutChar(o.label)
          return first !== null && first === ch
        })
        if (matches.length !== 1) return "stay"
        const matched = matches[0]
        return { close: true, result: matched.id }
      }
      default:
        return "stay"
    }
  }

  rowsHint(): number {
    return this.render(this.lastWidth).length
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private renderButton(opt: ChoiceOption, idx: number): string {
    const focused = idx === this.selectedIndex
    const warn = opt.destructive ? `${WARN_GLYPH} ` : ""
    const label = `${warn}${opt.label}`
    if (focused) {
      const colored = color(
        `${FOCUS_LEFT} ${label} ${FOCUS_RIGHT}`,
        opt.destructive ? ANSI.fgYellow + ANSI.bold : ANSI.fgPink + ANSI.bold,
      )
      return colored
    }
    return color(`  ${label}  `, ANSI.fgGray)
  }

  private framedLine(content: string, innerWidth: number): string {
    const w = displayWidth(content)
    const pad = Math.max(0, innerWidth - w)
    return `${FRAME_V} ${content}${" ".repeat(pad)} ${FRAME_V}`
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Word-wrap `text` to `width` cells (visual cells, ANSI-aware).
 * Splits on whitespace; long words that exceed `width` are placed on
 * their own row (no mid-word splitting).
 */
export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text]
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return [""]
  const lines: string[] = []
  let current = ""
  for (const word of words) {
    if (current.length === 0) {
      current = word
      continue
    }
    const candidate = `${current} ${word}`
    if (displayWidth(candidate) <= width) {
      current = candidate
    } else {
      lines.push(current)
      current = word
    }
  }
  if (current.length > 0) lines.push(current)
  return lines
}

function firstShortcutChar(label: string): string | null {
  // Skip the warning glyph + space if present, find first alphanumeric.
  for (const ch of label) {
    if (/[a-z0-9]/i.test(ch)) return ch.toLowerCase()
  }
  return null
}
