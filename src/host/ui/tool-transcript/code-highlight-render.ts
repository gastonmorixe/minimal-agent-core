import { ANSI_CODES } from "@minimal-agent/plugin-api/utils/ansi"
import { PALETTE } from "@minimal-agent/plugin-api/utils/palette"

import type { CodeHighlighter, UnifiedDiffColors } from "../formatter/mdstream-code-highlighter.ts"
import { c } from "../style/ansi.ts"

const { BOLD, RESET } = ANSI_CODES

/** Highlight a Read result while leaving its cat-n line-number column untouched. */
export async function highlightReadBody(
  numberedBody: string,
  language: string,
  highlighter: CodeHighlighter,
): Promise<string | null> {
  const rows = numberedBody.split("\n")
  const parsed = rows.map((row) => row.match(/^(\d+)\t(.*)$/s))
  if (parsed.some((match) => match === null)) return null

  const code = parsed.map((match) => match![2]).join("\n")
  const ansi = await highlighter.highlight({ language, code })
  if (ansi === null) return null
  const highlighted = splitLogicalLines(ansi)
  if (highlighted.length !== parsed.length) return null

  return highlighted.map((line, index) => `${c.dim(parsed[index]![1]!)}\t${line}`).join("\n")
}

/**
 * Compose syntax token foregrounds with unified-diff semantics. The one-cell
 * +/- marker keeps the bright semantic color, while changed payload rows get a
 * soft background wash and retain the highlighter's token foregrounds.
 */
export async function highlightUnifiedDiff(
  patch: string,
  language: string,
  highlighter: CodeHighlighter,
  title?: string,
): Promise<string | null> {
  const palette = resolveDiffPalette()
  const native = highlighter.highlightUnifiedDiff
    ? await highlighter.highlightUnifiedDiff({
        language,
        code: patch,
        diffStyle: "bg-wash",
        colors: palette.colors,
      })
    : null
  if (native !== null) return withOptionalTitle(native, title)

  const lines = patch.split("\n")
  const oldPayload: string[] = []
  const newPayload: string[] = []
  for (const line of lines) {
    if (isFileHeader(line) || line.startsWith("@@")) continue
    if (line.startsWith("-")) oldPayload.push(line.slice(1))
    else if (line.startsWith("+")) newPayload.push(line.slice(1))
    else if (line.startsWith(" ")) {
      oldPayload.push(line.slice(1))
      newPayload.push(line.slice(1))
    }
  }

  const oldCode = oldPayload.join("\n")
  const newCode = newPayload.join("\n")
  const [oldAnsi, newAnsi] = await Promise.all([
    oldCode.length === 0 ? Promise.resolve("") : highlighter.highlight({ language, code: oldCode }),
    newCode.length === 0 ? Promise.resolve("") : highlighter.highlight({ language, code: newCode }),
  ])
  if (oldAnsi === null || newAnsi === null) return null
  const oldLines = oldPayload.length === 0 ? [] : splitLogicalLines(oldAnsi)
  const newLines = newPayload.length === 0 ? [] : splitLogicalLines(newAnsi)
  if (oldLines.length !== oldPayload.length || newLines.length !== newPayload.length) return null

  let oldIndex = 0
  let newIndex = 0
  const out: string[] = []
  if (title) {
    out.push(`${BOLD}${title}${RESET}`)
    out.push(`\x1b[2m${"─".repeat(Math.min(title.length + 4, 64))}${RESET}`)
  }
  for (const line of lines) {
    if (isFileHeader(line)) out.push(`${BOLD}${line}${RESET}`)
    else if (line.startsWith("@@")) out.push(`${palette.hunk}${line}${RESET}`)
    else if (line.startsWith("-")) {
      const payload = reassertBackground(oldLines[oldIndex++] ?? "", palette.removalWash)
      out.push(
        `${palette.removalWash}${palette.removal}-${RESET}${palette.removalWash}${payload}${RESET}`,
      )
    } else if (line.startsWith("+")) {
      const payload = reassertBackground(newLines[newIndex++] ?? "", palette.additionWash)
      out.push(
        `${palette.additionWash}${palette.addition}+${RESET}${palette.additionWash}${payload}${RESET}`,
      )
    } else if (line.startsWith(" ")) {
      const payload = newLines[newIndex++] ?? ""
      oldIndex++
      out.push(` ${payload}`)
    } else {
      out.push(line)
    }
  }
  return out.join("\n")
}

function splitLogicalLines(value: string): string[] {
  // `code` is assembled by joining one payload per source row. A final empty
  // source row therefore produces a trailing `\n`, and split()'s final empty
  // element is the real highlighted counterpart of that row — not an artifact
  // to discard. This is the common full-file Read case for source files ending
  // in a newline. Dropping it made the row-count guard fail closed, so bounded
  // reads highlighted while otherwise-identical full-file reads stayed plain.
  return value.split("\n")
}

function isFileHeader(line: string): boolean {
  return line.startsWith("---") || line.startsWith("+++")
}

function withOptionalTitle(body: string, title: string | undefined): string {
  if (!title) return body
  return `${BOLD}${title}${RESET}\n\x1b[2m${"─".repeat(Math.min(title.length + 4, 64))}${RESET}\n${body}`
}

function resolveDiffPalette(): {
  removal: string
  addition: string
  hunk: string
  removalWash: string
  additionWash: string
  colors: UnifiedDiffColors
} {
  let configured: Record<string, string> = {}
  try {
    configured = JSON.parse(process.env.MINIMAL_AGENT_PALETTE ?? "{}") as Record<string, string>
  } catch {
    // Palette environment is optional presentation data.
  }
  const removal = configured.removal ?? configured.error ?? configured.pink ?? PALETTE.pink
  const addition = configured.addition ?? configured.success ?? configured.lime ?? PALETTE.lime
  const hunk = configured["accent-soft"] ?? configured.cyan ?? PALETTE.cyan
  const deleted = sgrForegroundToHex(removal) ?? "#ff5fd7"
  const inserted = sgrForegroundToHex(addition) ?? "#87ff00"
  return {
    removal,
    addition,
    hunk,
    removalWash: backgroundEscape(darkenHex(deleted, "#59163d")),
    additionWash: backgroundEscape(darkenHex(inserted, "#2f5900")),
    // mdstream owns wash strength in bg-wash mode: it keeps these bright
    // semantic colors on the +/- marker and derives the same 22% background
    // tint used by the local compositor fallback.
    colors: { deleted, inserted },
  }
}

function reassertBackground(value: string, background: string): string {
  return value.replaceAll(RESET, `${RESET}${background}`)
}

function darkenHex(color: string | undefined, fallback: string): string {
  const hex = color ?? fallback
  const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!match) return fallback
  return rgbHex(
    Math.floor(Number.parseInt(match[1]!, 16) * 0.22),
    Math.floor(Number.parseInt(match[2]!, 16) * 0.22),
    Math.floor(Number.parseInt(match[3]!, 16) * 0.22),
  )
}

function backgroundEscape(hex: string): string {
  const match = hex.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i)
  if (!match) return ""
  return `\x1b[48;2;${Number.parseInt(match[1]!, 16)};${Number.parseInt(match[2]!, 16)};${Number.parseInt(match[3]!, 16)}m`
}

function sgrForegroundToHex(sgr: string): string | undefined {
  const truecolor = sgr.match(/\x1b\[38;2;(\d+);(\d+);(\d+)m/)
  if (truecolor) {
    return `#${[truecolor[1], truecolor[2], truecolor[3]]
      .map((part) => Number(part).toString(16).padStart(2, "0"))
      .join("")}`
  }

  const indexed = sgr.match(/\x1b\[38;5;(\d+)m/)
  if (indexed) return indexedColorToHex(Number(indexed[1]))

  const legacy = sgr.match(/\x1b\[(3[0-7]|9[0-7])m/)
  if (legacy) return legacyColorToHex(Number(legacy[1]))
  return undefined
}

function indexedColorToHex(index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index > 255) return undefined
  if (index < 16) {
    const code = index < 8 ? 30 + index : 90 + (index - 8)
    return legacyColorToHex(code)
  }
  if (index >= 232) {
    const channel = 8 + (index - 232) * 10
    return rgbHex(channel, channel, channel)
  }
  const value = index - 16
  const levels = [0, 95, 135, 175, 215, 255]
  return rgbHex(
    levels[Math.floor(value / 36)]!,
    levels[Math.floor((value % 36) / 6)]!,
    levels[value % 6]!,
  )
}

function legacyColorToHex(code: number): string | undefined {
  const normal = [
    [0, 0, 0],
    [205, 49, 49],
    [13, 188, 121],
    [229, 229, 16],
    [36, 114, 200],
    [188, 63, 188],
    [17, 168, 205],
    [229, 229, 229],
  ] as const
  const bright = [
    [102, 102, 102],
    [241, 76, 76],
    [35, 209, 139],
    [245, 245, 67],
    [59, 142, 234],
    [214, 112, 214],
    [41, 184, 219],
    [255, 255, 255],
  ] as const
  const entry = code >= 90 ? bright[code - 90] : normal[code - 30]
  return entry ? rgbHex(entry[0], entry[1], entry[2]) : undefined
}

function rgbHex(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
}
