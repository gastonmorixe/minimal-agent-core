/**
 * TUI rendering of tool calls — `formatToolInput` (header) and
 * `formatToolPreview` (body + footer).
 *
 * These tests cover the May 2026 redesign where:
 *
 *  - Bash header dropped the 80-char hard slice for a 500-char
 *    word-boundary trim (so commands no longer get cut mid-token like the
 *    user's reported `head...(+4ch)` regression).
 *  - Body preview is per-tool (Bash 10 lines, Read 15, Grep 12, Glob 25)
 *    instead of a flat 200-char slice.
 *  - The trailing `[truncated: …]` notice that lives inside `content` for
 *    the model is stripped from the displayed body and replaced with a
 *    bare-facts footer (`shown N/M L · X/Y B · cut at L`) — no model-facing
 *    action verbs in the human-facing transcript.
 *  - Per-line display-width is capped at 300 cells so a single 10_000-char
 *    minified blob doesn't dominate the preview.
 *
 * Audience split (this is the load-bearing invariant):
 *   - `tool_result.content` (sent to the API) keeps the verbose notice
 *     with the action verb hint — that's the model's resume signal.
 *   - `formatToolPreview` output (the TUI transcript) shows facts only.
 */
import { describe, it, expect } from "bun:test"
import { formatToolInput, formatToolInputContinuation, formatToolPreview } from "./agent.ts"
import type { ToolUseBlock } from "./client.ts"
import type { TruncationInfo } from "./tools/truncation.ts"

/** Strip ANSI escapes so assertions don't fight against the SGR wrap. */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
}

function tu(name: string, input: Record<string, unknown>): ToolUseBlock {
  return { type: "tool_use", id: "test", name, input } as ToolUseBlock
}

// ---------------------------------------------------------------------------
// formatToolInput
// ---------------------------------------------------------------------------

describe("formatToolInput — Bash word-boundary trim", () => {
  it("does NOT trim short single-line commands", () => {
    const out = formatToolInput(tu("Bash", { command: "echo hello" }))
    expect(out).toBe("$ echo hello")
  })

  it("does NOT trim a command around 80 chars (the old hard-cap regression)", () => {
    // The user's reported regression: `… | head -50` with the old slice
    // would cut as `… | head...(+4ch)`. With the new 500-char budget
    // and word-boundary trim, this stays intact.
    const cmd =
      'cd /Users/gaston/Projects/minimal-agent && grep -n "input\\." src/tools.ts | head -50'
    const out = formatToolInput(tu("Bash", { command: cmd }))
    expect(out).toBe(`$ ${cmd}`)
    expect(out).not.toContain("...(+")
    // And specifically: `head -50` is fully present.
    expect(out).toContain("head -50")
  })

  it("trims at a word boundary when a command exceeds 500 chars", () => {
    // Build a command that overflows the 500-char header budget but has
    // plenty of whitespace inside the trailing 15% window.
    const head = "echo " + "alpha ".repeat(80) // ~485 chars of "alpha "
    const tail = "FINALWORD_PAST_BUDGET"
    const cmd = head + tail
    expect(cmd.length).toBeGreaterThan(500)

    const out = formatToolInput(tu("Bash", { command: cmd }))
    expect(out).toContain("...(+")
    // Word-boundary trim: the visible portion ends at a complete `alpha`
    // token (possibly with trailing space), NOT mid-token like `alph`,
    // `alp`, or `al`. We assert this by checking the boundary explicitly:
    // the last non-whitespace span before the elide marker is a full
    // `alpha`, not a strict prefix of it.
    const visible = out.replace(/\.\.\.\(\+\d+ch\).*$/, "").replace(/^\$ /, "")
    // Last token (anchored to end, ignoring trailing whitespace).
    const lastToken = visible.trimEnd().match(/\S+$/)?.[0] ?? ""
    expect(lastToken).toBe("alpha")
    // FINALWORD_PAST_BUDGET must not appear (it's beyond the budget).
    expect(visible).not.toContain("FINALWORD")
  })

  it("falls back to hard-cut when no whitespace exists in the trim window", () => {
    // Single contiguous token with no spaces — word-boundary backoff
    // can't help, so we hard-cut at the budget. Critically: the result
    // does NOT exceed the budget itself (no ballooning).
    const cmd = "x".repeat(800)
    const out = formatToolInput(tu("Bash", { command: cmd }))
    expect(out).toContain("...(+")
    const visible = out.replace(/\.\.\.\(\+\d+ch\).*$/, "").replace(/^\$ /, "")
    // Visible portion should be exactly 500 chars (or close — within the
    // word-boundary slack window). Definitely not the full 800.
    expect(visible.length).toBeLessThanOrEqual(500)
    expect(visible.length).toBeGreaterThan(400)
  })
})

describe("formatToolInput — Bash multi-line", () => {
  it("returns header line ONLY (no `· +NL` indicator — continuation handled separately)", () => {
    const out = formatToolInput(
      tu("Bash", {
        command: "cat <<EOF\nfoo\nbar\nbaz\nEOF",
      }),
    )
    // First line is the header; the rest is rendered by
    // formatToolInputContinuation as separate `│` rows.
    expect(out).toBe("$ cat <<EOF")
    // No more inline `· +NL` indicator — superseded by actual rendered rows.
    expect(out).not.toContain("·")
    expect(out).not.toContain("+L)")
  })

  it("never injects raw newlines into the header (would shred the bordered block)", () => {
    const out = formatToolInput(tu("Bash", { command: "line1\nline2\nline3" }))
    expect(out).not.toContain("\n")
  })
})

// ---------------------------------------------------------------------------
// formatToolInputContinuation — multi-line Bash continuation rows
// ---------------------------------------------------------------------------

describe("formatToolInputContinuation — Bash", () => {
  it("returns [] for single-line Bash", () => {
    const cont = formatToolInputContinuation(tu("Bash", { command: "echo hi" }))
    expect(cont).toEqual([])
  })

  it("returns [] for non-Bash tools (Read/Write/Grep/etc.)", () => {
    expect(formatToolInputContinuation(tu("Read", { file_path: "/a" }))).toEqual([])
    expect(formatToolInputContinuation(tu("Grep", { pattern: "x" }))).toEqual([])
    expect(formatToolInputContinuation(tu("Glob", { pattern: "*.ts" }))).toEqual([])
  })

  it("returns continuation rows with `> ` bash secondary-prompt prefix", () => {
    const cont = formatToolInputContinuation(
      tu("Bash", { command: 'cat > /tmp/x.txt << "EOF"\nfoo\nbar\nEOF' }),
    )
    // Three continuation lines: foo, bar, EOF — each prefixed `> `.
    expect(cont).toEqual(["> foo", "> bar", "> EOF"])
  })

  it("preserves leading whitespace in continuation lines (heredoc bodies, indented code)", () => {
    const cont = formatToolInputContinuation(
      tu("Bash", { command: "for i in 1 2 3; do\n  echo $i\ndone" }),
    )
    expect(cont).toEqual([">   echo $i", "> done"])
  })

  it("caps at BASH_CONT_MAX_LINES=8 with synthetic `... +NL more` last row", () => {
    // 12 continuation lines → render 8, elide 4.
    const lines = ["echo first"]
    for (let i = 1; i <= 12; i++) lines.push(`echo line${i}`)
    const cmd = lines.join("\n")
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }))
    expect(cont.length).toBe(9) // 8 visible + 1 synthetic
    expect(cont[0]).toBe("> echo line1")
    expect(cont[7]).toBe("> echo line8")
    expect(cont[8]).toBe("> ...(+4L) more")
  })

  it("does NOT add a synthetic last row when continuation fits exactly within the cap", () => {
    // 8 continuation lines = exactly the cap → no elision row.
    const lines = ["first"]
    for (let i = 1; i <= 8; i++) lines.push(`l${i}`)
    const cont = formatToolInputContinuation(tu("Bash", { command: lines.join("\n") }))
    expect(cont.length).toBe(8)
    expect(cont[7]).toBe("> l8")
    expect(cont.some((l) => l.includes("more"))).toBe(false)
  })

  it("word-boundary trims a single very-long continuation line", () => {
    // Continuation line longer than 500 chars — should trim with hint,
    // NOT throw, NOT pass the budget.
    const longTail = "echo " + "abc ".repeat(200) // ~805 chars
    const cmd = `if true; then\n${longTail}\nfi`
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }))
    expect(cont.length).toBe(2) // long line + `fi`
    expect(cont[0]).toMatch(/^> /)
    expect(cont[0]).toContain("...(+")
    expect(cont[0].length).toBeLessThan(550) // budget + small hint overhead
    expect(cont[1]).toBe("> fi")
  })
})

describe("formatToolInput — non-Bash tools", () => {
  it("Read/Write/Edit show file_path as-is (no trim under typical paths)", () => {
    const path = "/Users/gaston/Projects/minimal-agent/src/tools.ts"
    expect(formatToolInput(tu("Read", { file_path: path }))).toBe(path)
    expect(formatToolInput(tu("Write", { file_path: path, content: "x" }))).toBe(path)
    expect(formatToolInput(tu("Edit", { file_path: path, old_string: "a", new_string: "b" }))).toBe(
      path,
    )
  })

  it("Glob shows the pattern", () => {
    expect(formatToolInput(tu("Glob", { pattern: "**/*.ts" }))).toBe("**/*.ts")
  })

  it("Grep shows /pattern/ with optional ` in PATH`", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo" }))).toBe("/foo/")
    expect(formatToolInput(tu("Grep", { pattern: "foo", path: "/src" }))).toBe("/foo/ in /src")
  })

  it("unknown tool falls back to JSON.stringify with 200-char hard cap", () => {
    const big = { stuff: "x".repeat(500) }
    const out = formatToolInput(tu("Mystery", big))
    expect(out).toContain("...(+")
    expect(out).toMatch(/^\{"stuff":"x{1,250}\.\.\.\(\+\d+ch\)$/)
  })
})

// ---------------------------------------------------------------------------
// formatToolPreview
// ---------------------------------------------------------------------------

describe("formatToolPreview — display channel (Edit/Write diffs)", () => {
  it("renders ANSI display string verbatim with no truncation", () => {
    const display = "\x1b[32m+added\x1b[39m\n\x1b[31m-removed\x1b[39m\nctx"
    const lines = formatToolPreview("compact for model", false, display, { tool: "Edit" })
    expect(lines.length).toBe(3)
    // Last line uses ╰, others │.
    expect(stripAnsi(lines[lines.length - 1])).toMatch(/^\s*╰\s/)
    expect(stripAnsi(lines[0])).toMatch(/^\s*│\s\+added/)
  })
})

describe("formatToolPreview — body preview budget", () => {
  it("uses Bash budget (10 lines) for tool=Bash", () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    const lines = formatToolPreview(content, false, undefined, { tool: "Bash" })
    // Body lines + at most one footer line. With 50 source lines and a
    // budget of 10, the TUI elides 40 — that triggers the footer.
    // Visible body = 10; footer = 1; total = 11.
    expect(lines.length).toBe(11)
    // First 10 lines render line content; 11th is the footer.
    expect(stripAnsi(lines[0])).toMatch(/^\s*│\sline 0$/)
    expect(stripAnsi(lines[9])).toMatch(/^\s*│\sline 9$/)
    expect(stripAnsi(lines[10])).toMatch(/^\s*╰\sshown\s/)
  })

  it("uses Read budget (15 lines) for tool=Read", () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    const lines = formatToolPreview(content, false, undefined, { tool: "Read" })
    expect(lines.length).toBe(16) // 15 body + 1 footer
    expect(stripAnsi(lines[14])).toMatch(/^\s*│\sline 14$/)
    expect(stripAnsi(lines[15])).toMatch(/^\s*╰\sshown\s/)
  })

  it("uses default budget (10 lines) for unknown tool", () => {
    const content = Array.from({ length: 30 }, (_, i) => `r${i}`).join("\n")
    const lines = formatToolPreview(content, false, undefined, { tool: "Mystery" })
    expect(lines.length).toBe(11)
  })

  it("does NOT add a footer when body fits within budget", () => {
    const content = "one\ntwo\nthree"
    const lines = formatToolPreview(content, false, undefined, { tool: "Bash" })
    expect(lines.length).toBe(3)
    // Last line uses ╰, no footer row.
    expect(stripAnsi(lines[2])).toMatch(/^\s*╰\sthree$/)
  })

  it("renders `(no output)` for empty content", () => {
    const lines = formatToolPreview("", false, undefined, { tool: "Bash" })
    expect(lines.length).toBe(1)
    expect(stripAnsi(lines[0])).toMatch(/^\s*╰\s\(no output\)$/)
  })
})

describe("formatToolPreview — strips trailing `[truncated:` notice", () => {
  it("notice is invisible in the displayed body", () => {
    const body = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n")
    const notice =
      "[truncated: shown 50 of 1000 bytes, 5/120 lines; cut at byte 50, line 5. " +
      "to continue, call Read with offset=5 (and limit as needed).]"
    const content = `${body}\n\n${notice}`
    const lines = formatToolPreview(content, false, undefined, { tool: "Read" })
    const stripped = lines.map(stripAnsi).join("\n")
    // Notice + action verb must NOT appear in the TUI render.
    expect(stripped).not.toContain("[truncated:")
    expect(stripped).not.toContain("call Read with offset=")
    // Body content still shown.
    expect(stripped).toContain("line 0")
    expect(stripped).toContain("line 4")
  })

  it("ALSO strips a trailing `[note: ...]` streak note appended after the [truncated:]", () => {
    // The streak tracker (Layer 3) appends `\n\n[note: ...]` AFTER the
    // `[truncated: ...]` line. Since our strip cuts at the first
    // `\n\n[truncated:` marker, both lines vanish from the TUI.
    const body = "row 0\nrow 1\nrow 2"
    const truncNotice =
      "[truncated: shown 50 of 1000 bytes, 3/120 lines; cut at byte 50, line 3. " +
      "to continue, call Read with offset=3.]"
    const streakNote =
      "[note: you've truncated 3 Read calls in a row. Use the totals from " +
      "the last [truncated: ...] notice to compute a single offset+limit.]"
    const content = `${body}\n\n${truncNotice}\n\n${streakNote}`
    const lines = formatToolPreview(content, false, undefined, { tool: "Read" })
    const stripped = lines.map(stripAnsi).join("\n")
    expect(stripped).not.toContain("[truncated:")
    expect(stripped).not.toContain("[note:")
    expect(stripped).not.toContain("you've truncated 3")
    expect(stripped).toContain("row 0")
  })
})

describe("formatToolPreview — bare-facts footer", () => {
  function infoTrunc(over: Partial<TruncationInfo> = {}): TruncationInfo {
    return {
      tool: "Read",
      truncated: true,
      shownBytes: 412,
      shownLines: 10,
      totalBytes: 1024,
      totalLines: 18,
      cutLine: 10,
      ...over,
    }
  }

  it("renders `shown V/T L · X/Y B · cut at L<line>` when info.truncated", () => {
    // Body has 5 lines, all visible (under any budget). info says model
    // saw 10 of 18, source total 18. Footer shows "5 visible / 18 total".
    const body = Array.from({ length: 5 }, (_, i) => `r${i}`).join("\n")
    const lines = formatToolPreview(body, false, undefined, {
      tool: "Read",
      info: infoTrunc(),
    })
    const footer = stripAnsi(lines[lines.length - 1])
    // No model-facing verbs.
    expect(footer).not.toMatch(/call|narrow|re-run|piping|head -c/i)
    // Bare facts only.
    expect(footer).toMatch(/^\s*╰\s/)
    expect(footer).toContain("L")
    expect(footer).toContain("·")
    expect(footer).toContain("cut at L")
    // Numerator is TUI-visible count (5), denominator is source total (18).
    expect(footer).toMatch(/shown 5\/18 L/)
    expect(footer).toMatch(/cut at L10/)
  })

  it("numerator reflects what's visible in the TUI right now (not what model saw)", () => {
    // 60 body lines — Read budget caps at 15 visible — info says source
    // had 1831 total lines and model saw 1000. Footer should read
    // `shown 15/1831 L` — TUI visible (15) vs. source total (1831).
    const body = Array.from({ length: 60 }, (_, i) => `${i}\tline`).join("\n")
    const lines = formatToolPreview(body, false, undefined, {
      tool: "Read",
      info: {
        tool: "Read",
        truncated: true,
        shownBytes: 64_000,
        shownLines: 1000,
        totalBytes: 90_000,
        totalLines: 1831,
        cutLine: 1000,
      },
    })
    const footer = stripAnsi(lines[lines.length - 1])
    expect(footer).toMatch(/shown 15\/1831 L/)
    expect(footer).toContain("cut at L1000")
  })

  it("uses K/M suffixes for large byte counts", () => {
    const body = "x"
    const lines = formatToolPreview(body, false, undefined, {
      tool: "Bash",
      info: infoTrunc({
        shownBytes: 64_000,
        totalBytes: 2_500_000,
      }),
    })
    const footer = stripAnsi(lines[lines.length - 1])
    expect(footer).toMatch(/62\.5 KB/)
    expect(footer).toMatch(/2\.4 MB/)
  })

  it("does NOT render a footer when info.truncated is false AND body fits in budget", () => {
    const body = "one\ntwo"
    const lines = formatToolPreview(body, false, undefined, {
      tool: "Bash",
      info: {
        tool: "Bash",
        truncated: false,
        shownBytes: 7,
        shownLines: 2,
        totalBytes: 7,
        totalLines: 2,
        cutLine: 2,
      },
    })
    expect(lines.length).toBe(2)
    expect(stripAnsi(lines[1])).toMatch(/^\s*╰\stwo$/)
  })

  it("renders a TUI-only footer when body exceeds budget but API didn't clamp", () => {
    // Tool returned 30 lines, API didn't truncate (info.truncated=false),
    // but our 10-line TUI budget elides 20. We still want the user to
    // see "this got cut for display, here's the real total".
    const body = Array.from({ length: 30 }, (_, i) => `n${i}`).join("\n")
    const lines = formatToolPreview(body, false, undefined, {
      tool: "Bash",
      info: {
        tool: "Bash",
        truncated: false,
        shownBytes: Buffer.byteLength(body, "utf8"),
        shownLines: 30,
        totalBytes: Buffer.byteLength(body, "utf8"),
        totalLines: 30,
        cutLine: 30,
      },
    })
    expect(lines.length).toBe(11) // 10 body + 1 footer
    const footer = stripAnsi(lines[10])
    expect(footer).toMatch(/shown \d+\/30 L/)
    expect(footer).not.toMatch(/cut at L/) // TUI-only — no API cut.
  })
})

describe("formatToolPreview — per-line display-width clamp", () => {
  it("clamps a single mega-line to 300 cells with truncHint", () => {
    const huge = "x".repeat(5_000)
    const lines = formatToolPreview(huge, false, undefined, { tool: "Bash" })
    // One body row.
    expect(lines.length).toBe(1)
    const visible = stripAnsi(lines[0])
    // The connector + space prefix is 4 chars; the body itself is the
    // clamped line + truncHint marker.
    expect(visible).toContain("...(+")
    // The trimmed-x portion is exactly 300 chars (display-width slice).
    const xs = visible.match(/x+/)?.[0] ?? ""
    expect(xs.length).toBe(300)
  })

  it("does NOT clamp lines under the per-line cap", () => {
    const line = "x".repeat(250)
    const lines = formatToolPreview(line, false, undefined, { tool: "Bash" })
    expect(stripAnsi(lines[0])).not.toContain("...(+")
  })
})

describe("formatToolPreview — error coloring", () => {
  it("uses red wrap when isError=true (smoke check on ANSI presence)", () => {
    const lines = formatToolPreview("oops", true, undefined, { tool: "Bash" })
    // Red SGR open + red close in the rendered line.
    expect(lines[0]).toMatch(/\x1b\[31m.*\x1b\[39m/)
  })
})
