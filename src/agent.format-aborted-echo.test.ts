/**
 * Unit tests for `formatAbortedEcho` (src/agent.ts).
 *
 * The function is a pure formatter: given the user's rolled-back prompt
 * text and an optional active mode label, it returns a single string
 * (multi-line via `\n`) carrying the dim-red `⊘` badge, the `ABORTED`
 * marker, the optional mode label, the bold `❯` arrow, and the user's
 * text wrapped in dim+strikethrough.
 *
 * No IO, no compositor coupling: the live-area wiring is exercised
 * separately in `src/agent.abort-repl.test.ts`.
 */
import { describe, expect, it } from "bun:test"
import { formatAbortedEcho } from "./agent.ts"

/** Strip ANSI escapes for substring assertions. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI strip
const ANSI_RE = /\x1b\[[0-9;]*m/g
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "")

describe("formatAbortedEcho", () => {
  it("renders a single header row for single-line text", () => {
    const out = formatAbortedEcho("hello world")
    const plain = stripAnsi(out)
    // Single physical line (no `\n` in the formatter output for single-line
    // input: the caller appends its own line terminator).
    expect(plain.includes("\n")).toBe(false)
    // Anchor + marker + arrow + body all present in the documented order.
    expect(plain).toContain("⊘")
    expect(plain).toContain("ABORTED")
    expect(plain).toContain("·")
    expect(plain).toContain("❯")
    expect(plain).toContain("hello world")
    // Specifically: marker comes before separator comes before arrow
    // comes before body.
    const i1 = plain.indexOf("ABORTED")
    const i2 = plain.indexOf("·")
    const i3 = plain.indexOf("❯")
    const i4 = plain.indexOf("hello world")
    expect(i1).toBeLessThan(i2)
    expect(i2).toBeLessThan(i3)
    expect(i3).toBeLessThan(i4)
  })

  it("multi-line text splits into header + indented continuation rows", () => {
    const out = formatAbortedEcho("first\nsecond\nthird")
    const lines = out.split("\n")
    expect(lines.length).toBe(3)
    // Header row has `⊘ ABORTED · ❯ first`.
    expect(stripAnsi(lines[0])).toContain("⊘ ABORTED")
    expect(stripAnsi(lines[0])).toContain("❯ first")
    // Continuation rows: indented (4 leading spaces), body visible,
    // NO repeat of the `⊘ ABORTED` header.
    expect(stripAnsi(lines[1])).toMatch(/^    second/)
    expect(stripAnsi(lines[2])).toMatch(/^    third/)
    expect(stripAnsi(lines[1])).not.toContain("⊘")
    expect(stripAnsi(lines[2])).not.toContain("ABORTED")
  })

  it("strips exactly one trailing newline (no phantom struck-through empty row)", () => {
    // Real-world input: `EditorController.text` often ends in `\n` because
    // the user typed multi-line content. We don't want the trailing newline
    // to render as an empty struck row.
    const out = formatAbortedEcho("foo\n")
    const lines = out.split("\n")
    expect(lines.length).toBe(1)
    expect(stripAnsi(lines[0])).toContain("foo")
  })

  it("preserves interior blank lines (only the final newline is stripped)", () => {
    // `"a\n\nb"` has an explicit blank middle line: keep it.
    const out = formatAbortedEcho("a\n\nb")
    const lines = out.split("\n")
    expect(lines.length).toBe(3)
    expect(stripAnsi(lines[0])).toContain("a")
    expect(stripAnsi(lines[1]).trim()).toBe("") // blank row preserved
    expect(stripAnsi(lines[2])).toContain("b")
  })

  it("renders the mode label segment when `activeModeLabel` is provided", () => {
    const out = formatAbortedEcho("hi", { activeModeLabel: "ask" })
    const plain = stripAnsi(out)
    // The label appears uppercased between the separator and the arrow.
    expect(plain).toMatch(/ABORTED · ASK ❯/)
  })

  it("uppercases the label (matches the live ASK/PLAN/etc prompt convention)", () => {
    const out = formatAbortedEcho("body", { activeModeLabel: "plan" })
    expect(stripAnsi(out)).toContain("· PLAN ❯")
  })

  it("omits the mode segment when `activeModeLabel` is null/undefined", () => {
    const a = stripAnsi(formatAbortedEcho("body"))
    const b = stripAnsi(formatAbortedEcho("body", {}))
    const c = stripAnsi(formatAbortedEcho("body", { activeModeLabel: null }))
    const d = stripAnsi(formatAbortedEcho("body", { activeModeLabel: undefined }))
    // All four shapes are identical and contain no extra segment between
    // `·` and `❯` other than the single space.
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(c).toBe(d)
    expect(a).toMatch(/ABORTED · ❯/) // separator → space → arrow
  })

  it("treats empty text as a header-only echo (no phantom body content)", () => {
    const out = formatAbortedEcho("")
    const plain = stripAnsi(out)
    // The header is still emitted (so the user sees that *something* was
    // aborted) but there's no visible body content. Single line.
    expect(plain.includes("\n")).toBe(false)
    expect(plain).toContain("⊘ ABORTED")
    expect(plain).toContain("❯")
    // After the arrow there is only the (empty) body: i.e. a single
    // space + nothing visible.
    const afterArrow = plain.slice(plain.indexOf("❯") + 1)
    expect(afterArrow.trim()).toBe("")
  })

  it("opens AND closes strikethrough per line (no SGR state leaking across `\\n`)", () => {
    // Each body line MUST contain its own `\x1b[9m` (open) … `\x1b[29m`
    // (close) pair so terminals that reset attributes at line boundaries
    // still render the strikethrough on every row. Some xterm-likes
    // historically didn't carry strikethrough across newlines.
    const out = formatAbortedEcho("a\nb\nc")
    const lines = out.split("\n")
    for (const line of lines) {
      // Each row carries `\x1b[9m` (strike on) somewhere.
      expect(line.includes("\x1b[9m")).toBe(true)
      // …and `\x1b[29m` (strike off) somewhere later in the same row.
      const onIdx = line.indexOf("\x1b[9m")
      const offIdx = line.indexOf("\x1b[29m", onIdx)
      expect(offIdx).toBeGreaterThan(onIdx)
    }
  })

  it("wraps every body line in dim+strikethrough (composes both SGR codes)", () => {
    // The body MUST be `c.dim(c.strike(line))`: both attributes open and
    // close on each line. We verify by counting the dim (`\x1b[2m` /
    // `\x1b[22m`) and strike (`\x1b[9m` / `\x1b[29m`) bracket pairs.
    const out = formatAbortedEcho("hello")
    // At least one dim-open and one dim-close on the row.
    expect(out.includes("\x1b[2m")).toBe(true)
    expect(out.includes("\x1b[22m")).toBe(true)
    // At least one strike-open and one strike-close on the row.
    expect(out.includes("\x1b[9m")).toBe(true)
    expect(out.includes("\x1b[29m")).toBe(true)
  })

  it("badge uses dim-red foreground (matches `c.dimRed`)", () => {
    // Visually, the `⊘` badge wears a dim-red wash to read as "rolled back
    // / undone". The exact SGR sequence is `\x1b[2;31m … \x1b[22;39m`.
    const out = formatAbortedEcho("x")
    expect(out).toContain("\x1b[2;31m") // dim + red foreground
    // The badge glyph follows the open code.
    const openIdx = out.indexOf("\x1b[2;31m")
    expect(out.slice(openIdx).startsWith("\x1b[2;31m⊘")).toBe(true)
  })

  it("does not crash on text containing ANSI escape sequences", () => {
    // Defensive: even if the user's draft accidentally contains escape
    // bytes (e.g. they pasted ANSI-colored content from elsewhere), the
    // formatter must still produce a well-formed string with the header
    // intact.
    const evil = "hello \x1b[31mred\x1b[0m world"
    const out = formatAbortedEcho(evil)
    const plain = stripAnsi(out)
    expect(plain).toContain("⊘ ABORTED")
    expect(plain).toContain("hello")
    expect(plain).toContain("red")
    expect(plain).toContain("world")
  })

  it("indentation of continuation rows matches the documented 4-space prefix", () => {
    // The docstring says: "Continuation lines: 4-space indent (2 outer + 2
    // inner) so they visually nest under the badge rather than aligning
    // under the content of line 1." Verify the indent is exactly 4 spaces.
    const out = formatAbortedEcho("first\nsecond")
    const lines = out.split("\n")
    expect(lines.length).toBe(2)
    const plain = stripAnsi(lines[1])
    // First 4 chars are spaces, 5th is non-space.
    expect(plain.slice(0, 4)).toBe("    ")
    expect(plain[4]).not.toBe(" ")
  })
})
