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
import {
  formatToolInput,
  formatToolInputContinuation,
  formatToolPreview,
  toolContinuationIndentCells,
} from "./agent.ts"
import type { ToolUseBlock } from "./client.ts"
import { displayWidth } from "./term-width.ts"
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

  it("Grep shows /pattern/ with optional ` · in PATH`", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo" }))).toBe("/foo/")
    // The "in PATH" form uses the project-wide ` · ` separator — same one
    // used in the truncation footer (`shown 15/1831 L · 8.0 KB/1.5 MB ·
    // cut at L1000`), keeping a single visual language inside the block.
    expect(formatToolInput(tu("Grep", { pattern: "foo", path: "/src" }))).toBe("/foo/ · in /src")
  })

  it("unknown tool falls back to JSON.stringify with 200-char hard cap", () => {
    const big = { stuff: "x".repeat(500) }
    const out = formatToolInput(tu("Mystery", big))
    expect(out).toContain("...(+")
    expect(out).toMatch(/^\{"stuff":"x{1,250}\.\.\.\(\+\d+ch\)$/)
  })
})

// ---------------------------------------------------------------------------
// formatToolInput — Style A subordinate-input vocabulary
//
// "Style A" is the programmer-native shorthand approved May 2026: regex
// flags inline (`/foo/i`), context as arrows (`↑↓↕N`), head limit as `≤N`,
// `replace_all` as sed `· g`, line-range as `· L<a>-<b>` (1-indexed). All
// chunks separated by ` · ` — same separator the truncation footer uses,
// keeping the tool block in one visual language.
// ---------------------------------------------------------------------------

describe("formatToolInput — Read with offset/limit (Style A `· L<a>-<b>`)", () => {
  it("bare Read renders byte-identical to no-extras form", () => {
    expect(formatToolInput(tu("Read", { file_path: "/x" }))).toBe("/x")
  })
  it("`limit` only → 1-indexed closed range starting at L1", () => {
    // Common case the user reported: model asks for "first 4 lines",
    // header should reflect it. `execRead` body prints 1-indexed line
    // numbers, so the header range matches what the user sees in the body.
    expect(formatToolInput(tu("Read", { file_path: "/x", limit: 4 }))).toBe("/x · L1-4")
  })
  it("`offset` only → open-ended `· from L<n>` (n is 1-indexed)", () => {
    // `offset` is zero-based in the schema; we lift it to 1-indexed for
    // the header (offset=100 → "from L101") so the user's mental model
    // stays consistent with the body's line gutter.
    expect(formatToolInput(tu("Read", { file_path: "/x", offset: 100 }))).toBe("/x · from L101")
  })
  it("offset + limit → closed range, both 1-indexed", () => {
    expect(formatToolInput(tu("Read", { file_path: "/x", offset: 100, limit: 5 }))).toBe(
      "/x · L101-105",
    )
  })
  it("offset=0 + limit → identical to limit-only form", () => {
    // Edge case: explicit offset=0 should not differ from omitted offset.
    expect(formatToolInput(tu("Read", { file_path: "/x", offset: 0, limit: 4 }))).toBe("/x · L1-4")
  })
})

describe("formatToolInput — Edit replace_all (Style A `· g`)", () => {
  it("default Edit (no replace_all) renders byte-identical to no-extras form", () => {
    expect(formatToolInput(tu("Edit", { file_path: "/x", old_string: "a", new_string: "b" }))).toBe(
      "/x",
    )
  })
  it("replace_all=true appends sed-style `· g`", () => {
    expect(
      formatToolInput(
        tu("Edit", { file_path: "/x", old_string: "a", new_string: "b", replace_all: true }),
      ),
    ).toBe("/x · g")
  })
  it("replace_all=false renders byte-identical to no-extras form (the schema default)", () => {
    expect(
      formatToolInput(
        tu("Edit", { file_path: "/x", old_string: "a", new_string: "b", replace_all: false }),
      ),
    ).toBe("/x")
  })
})

describe("formatToolInput — Glob with path", () => {
  it("`path` appends as `· in <path>`", () => {
    expect(formatToolInput(tu("Glob", { pattern: "*.ts", path: "/src" }))).toBe("*.ts · in /src")
  })
})

describe("formatToolInput — Grep flags (Style A)", () => {
  it("`-i` lifts to a JS-regex `i` flag on the pattern (NOT a separate chunk)", () => {
    // Critical: case-insensitivity is a property of the regex, so it
    // attaches inline to the pattern atom rather than floating as a
    // separate chunk. `/foo/i · in /src` — not `/foo/ · -i · in /src`.
    expect(formatToolInput(tu("Grep", { pattern: "foo", "-i": true }))).toBe("/foo/i")
  })
  it("`multiline` lifts to `m` flag (combinable with i → `im`)", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", "-i": true, multiline: true }))).toBe(
      "/foo/im",
    )
  })
  it("multiline alone → `/foo/m`", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", multiline: true }))).toBe("/foo/m")
  })
  it("`-A N` → `· ↓N` (after)", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", "-A": 5 }))).toBe("/foo/ · ↓5")
  })
  it("`-B N` → `· ↑N` (before)", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", "-B": 2 }))).toBe("/foo/ · ↑2")
  })
  it("`-C N` → `· ↕N` (around)", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", "-C": 3 }))).toBe("/foo/ · ↕3")
  })
  it("`context` (alias for -C) → `· ↕N`", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", context: 3 }))).toBe("/foo/ · ↕3")
  })
  it("`-C` takes precedence when both -C and -A/-B set (symmetric beats asymmetric)", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", "-A": 5, "-B": 2, "-C": 3 }))).toBe(
      "/foo/ · ↕3",
    )
  })
  it("renders both ↓ and ↑ when -A and -B are set without -C", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", "-A": 5, "-B": 2 }))).toBe(
      "/foo/ · ↓5 · ↑2",
    )
  })
  it("`head_limit` → `· ≤N`", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", head_limit: 100 }))).toBe("/foo/ · ≤100")
  })
  it("output_mode: count → `· count`", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", output_mode: "count" }))).toBe(
      "/foo/ · count",
    )
  })
  it("output_mode: files_with_matches → `· paths`", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", output_mode: "files_with_matches" }))).toBe(
      "/foo/ · paths",
    )
  })
  it("output_mode: content (default) → omitted from header", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", output_mode: "content" }))).toBe("/foo/")
  })
  it("`glob` filter renders as a bare chunk after path", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", path: "/src", glob: "*.ts" }))).toBe(
      "/foo/ · in /src · *.ts",
    )
  })
  it("composed: pattern with flags, path, glob, context, head, mode (full chain)", () => {
    expect(
      formatToolInput(
        tu("Grep", {
          pattern: "foo",
          "-i": true,
          path: "/src",
          glob: "*.ts",
          "-C": 3,
          head_limit: 100,
          output_mode: "count",
        }),
      ),
    ).toBe("/foo/i · in /src · *.ts · ↕3 · ≤100 · count")
  })
  it("`-n` (line numbers) is intentionally NOT surfaced — it's the default", () => {
    // Surfacing -n would clutter the header for zero information gain
    // (it's on by default; the body already shows numbers via the gutter).
    expect(formatToolInput(tu("Grep", { pattern: "foo", "-n": true }))).toBe("/foo/")
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

  it("uses a supplied display footer as the close row", () => {
    const display = "  1  ○  #a7b3c4  first\n"
    const lines = formatToolPreview("compact for model", false, display, {
      tool: "Task",
      footer: "0 done · 0 doing · 1 todo",
    })
    const plain = lines.map(stripAnsi)
    expect(plain[0]).toMatch(/^\s*│\s+1\s+○/)
    expect(plain[1]).toMatch(/^\s*│\s*$/)
    expect(plain[2]).toMatch(/^\s*╰\s0 done/)
  })

  it("keeps footer-framed display rows below terminal width", () => {
    const display =
      "       ╰  ○  #26843da  Audit existing addSessionUsage callers\n" +
      "   2  ○  #a6b6e5  Add contextSize tracking with cache reads\n"
    const lines = formatToolPreview("compact for model", false, display, {
      tool: "Task",
      footer: "0 done · 0 doing · 2 todo",
      cols: 65,
    })
    const plain = lines.map(stripAnsi)
    for (const line of plain) {
      expect(displayWidth(line)).toBeLessThan(65)
    }
    expect(plain[0]).toContain("...")
    expect(plain[0]).toMatch(/^\s*│\s/)
    expect(plain.at(-1)).toMatch(/^\s*╰\s/)
  })
})

describe("formatToolPreview — body preview budget", () => {
  it("uses Bash budget (10 lines) for tool=Bash", () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    const lines = formatToolPreview(content, false, undefined, { tool: "Bash" })
    // Body lines + truncation separator + footer line. With 50 source lines
    // and a budget of 10, the TUI elides 40 — that triggers the footer,
    // which is now preceded by a `┊` "something cut here" divider.
    // Visible body = 10; ┊ separator = 1; footer = 1; total = 12.
    expect(lines.length).toBe(12)
    // First 10 lines render line content; 11th is the `┊`; 12th is `╰ shown…`.
    expect(stripAnsi(lines[0])).toMatch(/^\s*│\sline 0$/)
    expect(stripAnsi(lines[9])).toMatch(/^\s*│\sline 9$/)
    expect(stripAnsi(lines[10])).toMatch(/^\s*┊\s*$/)
    expect(stripAnsi(lines[11])).toMatch(/^\s*╰\sshown\s/)
  })

  it("uses Read budget (15 lines) for tool=Read", () => {
    const content = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n")
    const lines = formatToolPreview(content, false, undefined, { tool: "Read" })
    expect(lines.length).toBe(17) // 15 body + 1 ┊ + 1 footer
    expect(stripAnsi(lines[14])).toMatch(/^\s*│\sline 14$/)
    expect(stripAnsi(lines[15])).toMatch(/^\s*┊\s*$/)
    expect(stripAnsi(lines[16])).toMatch(/^\s*╰\sshown\s/)
  })

  it("uses default budget (10 lines) for unknown tool", () => {
    const content = Array.from({ length: 30 }, (_, i) => `r${i}`).join("\n")
    const lines = formatToolPreview(content, false, undefined, { tool: "Mystery" })
    expect(lines.length).toBe(12) // 10 body + 1 ┊ + 1 footer
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
    expect(lines.length).toBe(12) // 10 body + 1 ┊ + 1 footer
    expect(stripAnsi(lines[10])).toMatch(/^\s*┊\s*$/)
    const footer = stripAnsi(lines[11])
    expect(footer).toMatch(/shown \d+\/30 L/)
    expect(footer).not.toMatch(/cut at L/) // TUI-only — no API cut.
  })
})

describe("formatToolPreview — `┊` truncation separator", () => {
  // Standalone coverage of the dotted divider: it appears IFF the footer
  // appears, sits exactly above `╰`, and is absent on clean runs (so it
  // doesn't get confused with a literal blank output line).
  it("emits a `┊` row immediately before `╰ <footer>` when API truncated", () => {
    const body = "row 0\nrow 1\nrow 2"
    const lines = formatToolPreview(body, false, undefined, {
      tool: "Read",
      info: {
        tool: "Read",
        truncated: true,
        shownBytes: 100,
        shownLines: 3,
        totalBytes: 5_000,
        totalLines: 200,
        cutLine: 3,
      },
    })
    // Last two rows are `┊` and `╰ <footer>`, in that order.
    const sepIdx = lines.length - 2
    const footIdx = lines.length - 1
    expect(stripAnsi(lines[sepIdx])).toMatch(/^\s*┊\s*$/)
    expect(stripAnsi(lines[footIdx])).toMatch(/^\s*╰\s/)
    expect(stripAnsi(lines[footIdx])).toContain("cut at L3")
  })

  it("emits `┊` for a TUI-only elision footer too (body bigger than budget, API clean)", () => {
    const content = Array.from({ length: 30 }, (_, i) => `n${i}`).join("\n")
    const lines = formatToolPreview(content, false, undefined, { tool: "Bash" })
    expect(stripAnsi(lines[lines.length - 2])).toMatch(/^\s*┊\s*$/)
    expect(stripAnsi(lines[lines.length - 1])).toMatch(/^\s*╰\sshown/)
  })

  it("does NOT emit `┊` on a clean run (body fits, no API clamp)", () => {
    const lines = formatToolPreview("one\ntwo\nthree", false, undefined, { tool: "Bash" })
    // No ┊ anywhere — the body just closes with `╰`.
    expect(lines.some((l) => stripAnsi(l).match(/^\s*┊\s*$/))).toBe(false)
    expect(stripAnsi(lines[lines.length - 1])).toMatch(/^\s*╰\sthree$/)
  })

  it("does NOT emit `┊` for the `(no output)` close line", () => {
    // Empty content renders a single `╰ (no output)` row — that's not a
    // truncation indicator, so no dotted divider above it.
    const lines = formatToolPreview("", false, undefined, { tool: "Bash" })
    expect(lines.length).toBe(1)
    expect(lines.some((l) => stripAnsi(l).match(/^\s*┊\s*$/))).toBe(false)
  })

  it("does NOT emit `┊` for the display channel (Edit/Write diffs)", () => {
    // Diffs render verbatim with no truncation, so the `┊` divider is
    // never appropriate here even when the diff is long.
    const display = "+a\n+b\n+c\n+d\n+e\n+f"
    const lines = formatToolPreview("compact", false, display, { tool: "Edit" })
    expect(lines.some((l) => stripAnsi(l).match(/^\s*┊\s*$/))).toBe(false)
    expect(stripAnsi(lines[lines.length - 1])).toMatch(/^\s*╰\s/)
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

// ---------------------------------------------------------------------------
// formatToolInput — Bash soft-split (width-aware, single-line overflow)
// ---------------------------------------------------------------------------

describe("formatToolInput — Bash soft-split (width-aware)", () => {
  it("does NOT soft-split when the command fits the available width", () => {
    // "ls | wc -l" + 14-cell prefix = ~24 cells. At cols=80 it fits.
    const out = formatToolInput(tu("Bash", { command: "ls | wc -l" }), 80)
    expect(out).toBe("$ ls | wc -l")
  })

  it("does NOT soft-split when cols is undefined (test default = no overflow)", () => {
    // Existing tests don't pass cols. Default must be wide enough to never
    // trigger soft-split, otherwise the legacy 80-char test commands break.
    const longCmd = "cd /a && grep -n foo bar | head -10"
    const out = formatToolInput(tu("Bash", { command: longCmd }))
    expect(out).toBe(`$ ${longCmd}`)
  })

  it("returns lead-only when the single-line command would overflow", () => {
    const cmd = "cd /Users/gaston/Projects/mdstream && grep -n -i pat file.md | head -10"
    const out = formatToolInput(tu("Bash", { command: cmd }), 60)
    // Only the lead segment makes it into the header.
    expect(out).toBe("$ cd /Users/gaston/Projects/mdstream")
  })

  it("falls back to the full first line when no top-level operators exist", () => {
    // Long single-segment command (no &&, ||, |, ;): no split is possible,
    // header keeps full first line and lets the terminal wrap as before.
    const cmd = "very-long-single-token-with-no-operators-at-all-x".repeat(3)
    const out = formatToolInput(tu("Bash", { command: cmd }), 60)
    expect(out).toBe(`$ ${cmd}`)
  })

  it("DOES soft-split the first \\n-line when it overflows (heredoc/inline-script tail keeps PS2)", () => {
    // Regression guard: the previous design gated soft-split on
    // `firstNl === -1`, which made multi-line commands (python3 -c with
    // embedded \n, heredocs, for-loops) bypass soft-split entirely and
    // let the long first line truncate+wrap. The first \n-line should
    // soft-split independently of whether there are more \n-lines after
    // it. Reported by user (Gaston, May 2026).
    const cmd = "cat <<EOF && echo done && echo more && echo extra\nfoo\nEOF"
    const out = formatToolInput(tu("Bash", { command: cmd }), 60)
    expect(out).toBe("$ cat <<EOF")
  })
})

// ---------------------------------------------------------------------------
// formatToolInputContinuation — Bash soft-split rows (↳ prefix)
// ---------------------------------------------------------------------------

describe("formatToolInputContinuation — Bash soft-split (↳ rows)", () => {
  it("returns [] for non-overflowing single-line commands", () => {
    const cont = formatToolInputContinuation(tu("Bash", { command: "ls | wc -l" }), 80)
    expect(cont).toEqual([])
  })

  it("returns [] when cols is undefined (test default = no overflow)", () => {
    // Same default rule as formatToolInput.
    const cont = formatToolInputContinuation(tu("Bash", { command: "a && b | c" }))
    expect(cont).toEqual([])
  })

  it("returns ↳ rows for an overflowing single-line pipeline (operator leads each row)", () => {
    const cmd = "cd /Users/gaston/Projects/mdstream && grep -n foo bar.md | head -10"
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 60)
    expect(cont).toEqual(["↳ && grep -n foo bar.md", "↳ | head -10"])
  })

  it("returns [] when overflow exists but no operators do (terminal wraps as before)", () => {
    const cmd = "very-long-single-token-with-no-operators-at-all-x".repeat(3)
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 60)
    expect(cont).toEqual([])
  })

  it("renders the user's reported real-world example with three logical rows", () => {
    // Header is rendered separately by formatToolInput; this asserts the
    // continuation rows that go below it.
    const cmd =
      'cd /Users/gaston/Projects/mdstream && grep -n -i "single mega-cell\\|mega.cell\\|mega cell" tmp/markdown-tables-mock-002.md | head -10'
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 107)
    expect(cont).toEqual([
      '↳ && grep -n -i "single mega-cell\\|mega.cell\\|mega cell" tmp/markdown-tables-mock-002.md',
      "↳ | head -10",
    ])
  })

  it("emits PS2 > rows for tail \\n-lines, with first-line soft-split when first overflows", () => {
    // First \n-line `cat > /tmp/x.txt << "EOF" && echo done` overflows at
    // 40 cols AND contains `&&` → soft-splits into a single `↳` row.
    // Tail \n-lines keep their PS2 `> ` prefix. Combined sequence is
    // `[↳, >, >, >]`. (Earlier design erroneously emitted only `>` rows
    // here; that was the user-reported bug, fixed May 2026.)
    const cmd = 'cat > /tmp/x.txt << "EOF" && echo done\nfoo\nbar\nEOF'
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 40)
    expect(cont).toEqual(["↳ && echo done", "> foo", "> bar", "> EOF"])
  })

  it("emits PURE > rows when first \\n-line does NOT overflow (no soft-split needed)", () => {
    // No `&&`/`|` on the first line, no overflow → tail keeps PS2 only.
    const cmd = 'cat > /tmp/x.txt << "EOF"\nfoo\nbar\nEOF'
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 40)
    expect(cont).toEqual(["> foo", "> bar", "> EOF"])
    expect(cont.every((l) => l.startsWith("> "))).toBe(true)
  })

  it('does NOT split a quote-protected operator (echo "a && b" stays one segment)', () => {
    // Long enough to overflow a 30-col terminal, but the only operator
    // is inside double quotes — no split possible, return [].
    const cmd = 'echo "a && b && c && d && e && f && g"'
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 30)
    expect(cont).toEqual([])
  })

  it("respects subshell depth — pipe inside $(...) does NOT count as a top-level split point", () => {
    const cmd = "echo $(date | tr A-Z a-z) && ls /tmp/some/long/path/here"
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 40)
    // Only the outer && splits; the inner | stays inside the subshell.
    expect(cont).toEqual(["↳ && ls /tmp/some/long/path/here"])
  })

  it("caps soft-split rows at BASH_CONT_MAX_LINES with synthetic '↳ ...(+NL) more' last row", () => {
    // 10 segments → 1 lead + 9 rest; cap is 8 visible + 1 elision row.
    const segments = Array.from({ length: 10 }, (_, i) => `cmd${i}`)
    const cmd = segments.join(" | ")
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 40)
    expect(cont.length).toBe(9) // 8 visible + 1 elision
    expect(cont[0]).toBe("↳ | cmd1")
    expect(cont[7]).toBe("↳ | cmd8")
    expect(cont[8]).toBe("↳ ...(+1L) more")
  })

  it("word-boundary-trims a single very-long soft-split segment", () => {
    const longBody = "abc ".repeat(200) // ~800 chars
    const cmd = `cd /tmp && echo ${longBody}`
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 40)
    expect(cont.length).toBe(1)
    expect(cont[0]).toMatch(/^↳ && echo /)
    expect(cont[0]).toContain("...(+")
    // Budget cap = HEADER_BASH_MAX (500) + small hint overhead.
    expect(cont[0].length).toBeLessThan(550)
  })
})

// ---------------------------------------------------------------------------
// formatToolInputContinuation — combined ↳ + > rows (first-line soft-split
// followed by PS2 tail). Regression coverage for the user-reported case
// where a long pipeline contains an embedded \n inside an inline script arg.
// ---------------------------------------------------------------------------

describe("formatToolInputContinuation — Bash combined soft-split + PS2 tail", () => {
  it("emits ↳ rows for first-line soft-split THEN > rows for tail \\n-lines", () => {
    // Shape of the user's reported case: long pipeline on line 1, embedded
    // \n in a python -c arg producing tail lines.
    const cmd = "ls | head && echo more && echo even-more-stuff && python3 -c 'a=1\nprint(a)'"
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 50)
    // First-line soft-split rows lead, PS2 rows follow.
    expect(cont[0]).toMatch(/^↳ /)
    // \n-line 2 is `print(a)'` (one trailing single quote — closes the
    // open quote that was opened on \n-line 1's last segment).
    expect(cont).toContain("> print(a)'")
    // Single zone transition: a contiguous prefix of ↳ rows, then a
    // contiguous suffix of > rows. Never interleaved.
    const lastSoftIdx = cont.findIndex((l) => l.startsWith("> "))
    expect(lastSoftIdx).toBeGreaterThan(0)
    expect(cont.slice(0, lastSoftIdx).every((l) => l.startsWith("↳ "))).toBe(true)
    expect(cont.slice(lastSoftIdx).every((l) => l.startsWith("> "))).toBe(true)
  })

  it("preserves PS2-only behavior when first \\n-line does NOT overflow", () => {
    // Short first line + tail \n-lines → no soft-split, just PS2.
    const cmd = "for i in 1 2; do\n  echo $i\ndone"
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 80)
    expect(cont).toEqual([">   echo $i", "> done"])
  })

  it("applies the cap across combined ↳ + > rows (single elision row, ↳ prefix when cut in soft-split zone)", () => {
    // Long first line → many ↳ rows. Then a few PS2 lines. Combined
    // length > 8 → cap with one trailing elision row whose prefix
    // matches whichever zone the cut landed in.
    const longFirst = Array.from({ length: 10 }, (_, i) => `cmd${i}`).join(" && ")
    const cmd = `${longFirst}\ntail1\ntail2\ntail3`
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 40)
    expect(cont.length).toBe(9) // 8 visible + 1 elision (BASH_CONT_MAX_LINES = 8)
    // Cap landed inside the ↳ zone (10 segments > 8) → elision prefix is ↳.
    expect(cont[cont.length - 1]).toMatch(/^↳ \.\.\.\(\+\d+L\) more$/)
  })

  it("uses > prefix on the elision row when the cut lands inside the PS2 zone", () => {
    // Short first line (3 ↳ rows) + 10 PS2 lines → cap at 8 means
    // [↳, ↳, ↳, >, >, >, >, >] visible. The cut is inside the PS2 zone,
    // so the elision row uses > to keep the eye oriented.
    const cmd = "a && b && c && d\n" + Array.from({ length: 10 }, (_, i) => `tail${i}`).join("\n")
    const cont = formatToolInputContinuation(tu("Bash", { command: cmd }), 30)
    expect(cont.length).toBe(9)
    expect(cont[cont.length - 1]).toMatch(/^> \.\.\.\(\+\d+L\) more$/)
  })
})

// ---------------------------------------------------------------------------
// Regression coverage: 2+ operator pipelines split at WIDE terminals
//
// User report (May 2026): two real-world commands rendered without any
// `↳` rows because they fit horizontally in a typical 130–160 cell
// iTerm window, even though both have 2+ top-level operators that the
// user wants to read row-by-row. Width-only predicate left them unsplit.
// New rule: 2+ operators ⇒ soft-split regardless of overflow.
// ---------------------------------------------------------------------------

describe("formatToolInput / formatToolInputContinuation — 2+ operator split at wide cols", () => {
  const userCmd1 =
    "cd /Users/gaston/Projects/inditex/work/inditex-supplier-management && cat Makefile 2>/dev/null | head -80"
  const userCmd2 =
    "cd /Users/gaston/Projects/inditex/work/inditex-supplier-management/api && npm run lint 2>&1 | tail -120"

  // Span a few realistic terminal widths. All three must split because
  // both commands have 2 top-level operators (&&, |) — the multi-op
  // rule fires regardless of width.
  for (const cols of [120, 140, 160, 200]) {
    it(`user-reported cmd #1 splits at cols=${cols} (2+ operators)`, () => {
      expect(formatToolInput(tu("Bash", { command: userCmd1 }), cols)).toBe(
        "$ cd /Users/gaston/Projects/inditex/work/inditex-supplier-management",
      )
      expect(formatToolInputContinuation(tu("Bash", { command: userCmd1 }), cols)).toEqual([
        "↳ && cat Makefile 2>/dev/null",
        "↳ | head -80",
      ])
    })

    it(`user-reported cmd #2 splits at cols=${cols} (2+ operators)`, () => {
      expect(formatToolInput(tu("Bash", { command: userCmd2 }), cols)).toBe(
        "$ cd /Users/gaston/Projects/inditex/work/inditex-supplier-management/api",
      )
      expect(formatToolInputContinuation(tu("Bash", { command: userCmd2 }), cols)).toEqual([
        "↳ && npm run lint 2>&1",
        "↳ | tail -120",
      ])
    })
  }

  it("single-operator pipelines still stay inline at wide cols (no over-splitting)", () => {
    // `ls | wc -l` is short and trivially scannable; splitting would be
    // visual noise. Multi-op rule requires 2+ operators, so 1-op stays inline.
    expect(formatToolInput(tu("Bash", { command: "ls | wc -l" }), 200)).toBe("$ ls | wc -l")
    expect(formatToolInputContinuation(tu("Bash", { command: "ls | wc -l" }), 200)).toEqual([])
  })

  it("non-TTY callers (no cols, no TTY) still get single-line headers — multi-op rule gated on finite cols", () => {
    // Mirrors `bun test`-style invocations where stdout isn't a TTY and
    // process.stdout.columns is undefined → effectiveCols becomes Infinity.
    // Multi-op rule must NOT fire here; otherwise piped/test output of
    // 2+ op commands changes shape. Existing tests at line ~674/720
    // depend on this.
    expect(formatToolInput(tu("Bash", { command: "a && b | c" }))).toBe("$ a && b | c")
    expect(formatToolInputContinuation(tu("Bash", { command: "a && b | c" }))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// toolContinuationIndentCells — alignment under command body
// ---------------------------------------------------------------------------

describe("toolContinuationIndentCells — Bash continuation alignment", () => {
  it("aligns ↳/> under the command body when icon is present (live agent)", () => {
    // Live agent header: `  ╭ » Bash  $ cd …`
    //   - "  ╭ "  = 4 cells (frame, not counted)
    //   - "» "    = 2 cells (icon + trailing space)
    //   - "Bash"  = 4 cells
    //   - "  "    = 2 cells (label→content gap)
    //   - "$ "    = 2 cells (Bash sigil from formatToolInput)
    //   = 10 cells past the frame → continuation rows need 10 spaces
    //   of indent after `  │ ` for `↳`/`>` to land at col 14 (under
    //   the `c` of `cd …`).
    expect(toolContinuationIndentCells("Bash", "»")).toBe(10)
  })

  it("aligns ↳/> under the command body when no icon is present (session replay)", () => {
    // Replay header: `  ╭ Bash  $ cd …` (no icon)
    //   - "Bash"  = 4 cells
    //   - "  "    = 2 cells (gap)
    //   - "$ "    = 2 cells
    //   = 8 cells past the frame
    expect(toolContinuationIndentCells("Bash")).toBe(8)
  })

  it("returns 0 for non-Bash tools (no continuation rows there today)", () => {
    expect(toolContinuationIndentCells("Read", "★")).toBe(0)
    expect(toolContinuationIndentCells("Grep")).toBe(0)
    expect(toolContinuationIndentCells("Glob", "*")).toBe(0)
    expect(toolContinuationIndentCells("Edit")).toBe(0)
    expect(toolContinuationIndentCells("Write")).toBe(0)
  })

  it("scales the icon width via displayWidth (wide icons add an extra cell)", () => {
    // If a future Bash icon were 2 cells wide (e.g. a CJK glyph), the
    // indent must absorb that extra cell so the alignment stays under
    // the command body. NOTE: PUA codepoints like Nerd Font glyphs are
    // intentionally treated as 1 cell by `displayWidth` because PUA cell
    // width depends on the active font (see term-width.ts comment) — so
    // we exercise the wide-glyph path here with a real East-Asian Wide
    // codepoint instead.
    const wideIcon = "中" // U+4E2D, 2 cells per UAX #11
    expect(displayWidth(wideIcon)).toBe(2)
    // 2 (wide icon) + 1 (trailing space) + 4 (Bash) + 2 (gap) + 2 ($ ) = 11
    expect(toolContinuationIndentCells("Bash", wideIcon)).toBe(11)
  })
})
