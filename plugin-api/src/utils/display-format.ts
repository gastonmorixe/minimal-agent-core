/**
 * Text formats of sideband display segments, for a dump (Markdown or XML).
 * Pure functions, no host import. The input is the `segments` of
 * `SidebandApi.display`. The format knows no kind: it writes the label and
 * the text of each node that the handler gave.
 *
 * @module utils/display-format
 */

import type { SidebandDisplaySegment } from "../types/sideband.ts"

/** A fence char of CommonMark. */
export type FenceChar = "`" | "~"

/** The length of the longest run of `char` in `s` (0 when none). */
function longestRun(s: string, char: FenceChar): number {
  const re = char === "`" ? /`+/g : /~+/g
  let longest = 0
  for (const m of s.matchAll(re)) longest = Math.max(longest, m[0].length)
  return longest
}

/**
 * A fence of `char` longer than each run of `char` in `body`, and 3 or more.
 *
 * @param body - The text inside the fence.
 * @param minRun - Optional. The fence is also longer than a run of this length.
 * @param char - Optional. The fence char. The default is a backtick.
 */
export function fenceFor(body: string, minRun = 0, char: FenceChar = "`"): string {
  return char.repeat(Math.max(3, longestRun(body, char) + 1, minRun + 1))
}

/** An opening fence line: 0 to 3 spaces, 3 or more backticks or tildes, then the info string. */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/

/**
 * The fenced code block that is open at the end of `text`, by the CommonMark
 * rules, or `null` when none is open. An opening line has 0 to 3 spaces of
 * indent and 3 or more backticks or tildes (the info string of a backtick
 * fence has no backtick). A later line with 0 to 3 spaces of indent, a run of
 * the same char that is as long or longer, and only white space after it
 * closes the fence. The last line counts also when it has no line end.
 * Container blocks (lists, block quotes) are not parsed.
 *
 * @param text - The Markdown before a point.
 */
export function openFence(text: string): { char: FenceChar; length: number } | null {
  let open: { char: FenceChar; length: number } | null = null
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (open === null) {
      const m = FENCE_OPEN_RE.exec(line)
      const run = m?.[1]
      if (run === undefined) continue
      const char: FenceChar = run.startsWith("`") ? "`" : "~"
      if (char === "`" && (m?.[2] ?? "").includes("`")) continue
      open = { char, length: run.length }
      continue
    }
    const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1]
    if (close !== undefined && close.startsWith(open.char) && close.length >= open.length) {
      open = null
    }
  }
  return open
}

/** Each char that XML 1.0 does not allow: C0 except TAB LF CR, U+FFFE, U+FFFF, a lone surrogate. */
const XML_BAD_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDFFF]/gu

/** `s` with each char that XML 1.0 does not allow removed. */
export function xmlSafe(s: string): string {
  return s.replace(XML_BAD_RE, "")
}

/**
 * Markdown of segments. A text segment does not change. A node becomes its
 * label. When the node has a `text`, a fenced block with that text follows
 * the label, and the label and the fence are on their own lines.
 *
 * The fence char depends on the fence that is open at the node (see
 * {@link openFence}, on the output before the node). In CommonMark, a run of
 * the same char that is as long or longer closes an open fence, so the node
 * fence never uses the char of the open fence:
 * 1. No open fence: backticks, longer than each backtick run in the text.
 * 2. An open backtick fence: tildes, longer than each tilde run in the text.
 * 3. An open tilde fence: backticks, longer than each backtick run in the text.
 *
 * Known limits:
 * 1. Inside an open user fence, a line of the node text can still close that
 *    fence (the text does not change).
 * 2. User text after a node that starts with 4 or more spaces or a TAB
 *    becomes an indented code block, because the fence ends a line.
 * 3. A node in a list item puts its fence at column 0, which ends the list.
 *
 * @param segments - The `segments` of `SidebandApi.display`.
 */
export function displayMarkdown(segments: readonly SidebandDisplaySegment[]): string {
  let out = ""
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]
    if (s === undefined) continue
    if (s.type === "text") {
      out += s.text
      continue
    }
    const body = s.display.text
    if (body === undefined) {
      out += s.display.label
      continue
    }
    const lead = out.length > 0 && !out.endsWith("\n") ? "\n" : ""
    const open = openFence(out)
    const fence = fenceFor(body, 0, open?.char === "`" ? "~" : "`")
    const bodyNl = body.length === 0 || body.endsWith("\n") ? "" : "\n"
    const next = segments[i + 1]
    const trail = next !== undefined && !(next.type === "text" && next.text.startsWith("\n"))
    out += `${lead}${s.display.label}\n${fence}\n${body}${bodyNl}${fence}${trail ? "\n" : ""}`
  }
  return out
}

/**
 * XML content of segments. Plain text goes through {@link xmlSafe}, then
 * `escape`. A node gives
 * `<display kind="k" label="l"[ missing="true"][ truncated="true"]>text</display>`,
 * or a self-closing `<display .../>` element when it has no text. Each attr
 * value and the node text also go through `xmlSafe`, then `escape`.
 *
 * @param segments - The `segments` of `SidebandApi.display`.
 * @param escape - The XML escape of the consumer (it must escape `"`, `<`, `&`).
 */
export function displayXml(
  segments: readonly SidebandDisplaySegment[],
  escape: (s: string) => string,
): string {
  const safe = (s: string): string => escape(xmlSafe(s))
  let out = ""
  for (const s of segments) {
    if (s.type === "text") {
      out += safe(s.text)
      continue
    }
    const d = s.display
    let attrs = `kind="${safe(s.kind)}" label="${safe(d.label)}"`
    if (d.missing === true) attrs += ` missing="true"`
    if (d.truncated === true) attrs += ` truncated="true"`
    out +=
      d.text === undefined ? `<display ${attrs}/>` : `<display ${attrs}>${safe(d.text)}</display>`
  }
  return out
}
