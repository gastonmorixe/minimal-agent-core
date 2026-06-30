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
import { describe, expect, it } from "bun:test"

import type { ToolUseBlock } from "../../../client/types.ts"
import { displayWidth } from "../../../term-width.ts"
import type { TruncationInfo } from "../../../tools/truncation.ts"

import {
  clampTranscriptRow,
  formatToolInput,
  formatToolInputContinuation,
  formatToolPreview,
} from "./format.ts"

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

  it("unknown tool renders compact key:value pairs (Option A)", () => {
    const out = formatToolInput(tu("Mystery", { action: "meta", sid: "019ec3a9" }))
    expect(out).toBe("action:meta · sid:019ec3a9")
  })

  it("long string values are truncated with …", () => {
    const big = { query: "x".repeat(100) }
    const out = formatToolInput(tu("Search", big))
    expect(out).toMatch(/^query:"x{60}…"$/)
  })

  it("booleans render as bare flags when true, skipped when false", () => {
    expect(formatToolInput(tu("Flags", { "-i": true, multiline: true }))).toBe("-i · multiline")
    expect(formatToolInput(tu("NoFlags", { "-i": false, multiline: false }))).toBe("")
  })

  it("numbers render as key:value", () => {
    expect(formatToolInput(tu("Meta", { offset: 5, limit: 20 }))).toBe("offset:5 · limit:20")
  })

  it("empty input renders empty string", () => {
    expect(formatToolInput(tu("Empty", {}))).toBe("")
  })

  it("mixed types render correctly", () => {
    const out = formatToolInput(
      tu("SessionHistory", { action: "search", query: "provider login auth", limit: 20 }),
    )
    expect(out).toBe('action:search · query:"provider login auth" · limit:20')
  })

  it("nested objects/arrays collapse", () => {
    const out = formatToolInput(tu("Foo", { items: [1, 2, 3], meta: { a: 1 } }))
    expect(out).toBe("items:[3] · meta:{…}")
  })

  it("overflows HEADER_JSON_MAX with truncHint", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`k${i}`, "x".repeat(10)]),
    )
    const out = formatToolInput(tu("Big", tooMany))
    expect(out).toContain("...(+")
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
  it("`multiline` lifts to `m` flag (alone and combinable with `i`)", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", multiline: true }))).toBe("/foo/m")
    expect(formatToolInput(tu("Grep", { pattern: "foo", "-i": true, multiline: true }))).toBe(
      "/foo/im",
    )
  })
  it("`-A/-B/-C/context` context flags → `↓N`/`↑N`/`↕N`, -C beats -A/-B", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", "-A": 5 }))).toBe("/foo/ · ↓5")
    expect(formatToolInput(tu("Grep", { pattern: "foo", "-B": 2 }))).toBe("/foo/ · ↑2")
    expect(formatToolInput(tu("Grep", { pattern: "foo", "-C": 3 }))).toBe("/foo/ · ↕3")
    expect(formatToolInput(tu("Grep", { pattern: "foo", context: 3 }))).toBe("/foo/ · ↕3")
    expect(formatToolInput(tu("Grep", { pattern: "foo", "-A": 5, "-B": 2, "-C": 3 }))).toBe(
      "/foo/ · ↕3",
    )
    expect(formatToolInput(tu("Grep", { pattern: "foo", "-A": 5, "-B": 2 }))).toBe(
      "/foo/ · ↓5 · ↑2",
    )
  })
  it("`head_limit` → `· ≤N`", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", head_limit: 100 }))).toBe("/foo/ · ≤100")
  })
  it("output_mode: count → `· count`, files_with_matches → `· paths`, content (default) → omitted", () => {
    expect(formatToolInput(tu("Grep", { pattern: "foo", output_mode: "count" }))).toBe(
      "/foo/ · count",
    )
    expect(formatToolInput(tu("Grep", { pattern: "foo", output_mode: "files_with_matches" }))).toBe(
      "/foo/ · paths",
    )
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
    expect(plain[0]).toMatch(/^\s*│\s/)
    expect(plain.at(-1)).toMatch(/^\s*╰\s/)
  })

  it("word-wraps long Task rows (hang-indented) instead of truncating", () => {
    // Task display rows are structured (col · col · title). A long title
    // must flow onto a hang-indented continuation line, NOT get clipped
    // with a `...(+Nch)` marker. Regression for the truncation the user
    // reported (`...(+42ch)` tails on every long task title).
    const display =
      " 4  ✔  #77829c  Update prompts/templates where appropriate (careful not to encourage overuse) 17s\n"
    const lines = formatToolPreview("compact for model", false, display, {
      tool: "Task",
      footer: "11 done · 0 doing · 0 todo",
      cols: 60,
    })
    const plain = lines.map(stripAnsi)
    // No truncation marker anywhere.
    expect(plain.some((l) => /\.\.\.\(\+\d+ch\)/.test(l))).toBe(false)
    // The single source row wrapped into 2+ body rows (+ footer).
    const bodyRows = plain.filter((l) => /[│╰]\s+\S/.test(l) && !/done ·/.test(l))
    expect(bodyRows.length).toBeGreaterThanOrEqual(2)
    // Every rendered row fits the terminal width (no soft-wrap into gutter).
    for (const line of plain) expect(displayWidth(line)).toBeLessThan(60)
    // First body row keeps the leading `4 ✔ #77829c` columns intact.
    expect(plain[0]).toMatch(/^\s*│\s+4\s+✔\s+#77829c\s+Update/)
    // The continuation row is hang-indented (leading spaces before text),
    // not flush against the gutter.
    expect(plain[1]).toMatch(/^\s*│\s{2,}\S/)
    // No title word is lost across the wrap.
    const joined = bodyRows.join(" ").replace(/\s+/g, " ")
    for (const word of ["Update", "prompts/templates", "appropriate", "encourage", "overuse"]) {
      expect(joined).toContain(word)
    }
  })

  it("still truncates genuinely tabular tools (ListAgents) with a marker", () => {
    // Fleet/diff/lock tables stay on per-line truncation because a wrap
    // would shear their columns apart. Confirms Task was carved out
    // WITHOUT changing the tabular tools' behavior.
    const display = `${"A1 worker running ".repeat(8)}tail\n`
    const lines = formatToolPreview("compact for model", false, display, {
      tool: "ListAgents",
      cols: 40,
    })
    const plain = lines.map(stripAnsi)
    // Tabular path clips to one row + marker, does not wrap into many rows.
    expect(plain.some((l) => /\.\.\.\(\+\d+ch\)/.test(l))).toBe(true)
    for (const line of plain) expect(displayWidth(line)).toBeLessThan(40)
  })

  it("word-wraps prose display lines for non-structured tools", () => {
    // Tools like AgentResult/SpawnAgent (not in STRUCTURED_DISPLAY_TOOLS)
    // should word-wrap long prose lines instead of truncating.
    const display =
      "Bun's tsconfig paths research: Bun natively reads the `paths` field in tsconfig.json " +
      "to re-write import paths at runtime. This works for both `bun run` and `bun test`."
    const lines = formatToolPreview("compact for model", false, display, {
      tool: "AgentResult",
      cols: 40,
    })
    const plain = lines.map(stripAnsi)
    // Should NOT contain truncation marker — should word-wrap instead
    for (const line of plain) {
      expect(displayWidth(line)).toBeLessThan(40)
    }
    expect(plain.some((l) => l.includes("..."))).toBe(false)
    // Should have multiple lines from wrapping
    expect(lines.length).toBeGreaterThan(1)
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
  it("clamps a single mega-line to the 300-cell hard cap with truncHint reserve", () => {
    const huge = "x".repeat(5_000)
    const lines = formatToolPreview(huge, false, undefined, { tool: "Bash" })
    // One body row.
    expect(lines.length).toBe(1)
    const visible = stripAnsi(lines[0])
    expect(visible).toContain("...(+")
    // Body must fit within the 300-cell cap : the trim reserves
    // `TOOL_PREVIEW_HINT_RESERVE_WIDTH` (12) cells for the hint marker,
    // so the x-run is 300 - 12 = 288 cells. The full body (xs + hint)
    // lands at ≤ 300 cells, which is the invariant the user cares
    // about (no terminal wrap on terminals ≥ 305 cols).
    const xs = visible.match(/x+/)?.[0] ?? ""
    expect(xs.length).toBe(288)
    // Body + gutter prefix ("  │ " = 4 cells) ≤ 304 cells.
    expect(displayWidth(visible)).toBeLessThanOrEqual(304)
  })

  it("does NOT clamp lines under the per-line cap", () => {
    const line = "x".repeat(250)
    const lines = formatToolPreview(line, false, undefined, { tool: "Bash" })
    expect(stripAnsi(lines[0])).not.toContain("...(+")
  })
})

describe("formatToolPreview — terminal-cols clamp on body lines", () => {
  // Regression for the May 2026 user-reported bug where a Bash result
  // containing a long JSON line soft-wrapped into the gutter
  //
  //   "  │ {\"v\":1,\"id\":\"5ba940\",\"parent\":null,\"status\":\"do
  //   ne\",\"title\":\"Scaffold rese
  //   arch/...
  //
  // because `formatToolPreview` only clamped at the 300-cell hard cap
  // and a 200-char body line in a 90-col terminal fits the 300 cap but
  // overflows the visible width. The fix : clamp to
  // `min(terminal_cols - gutter - safety, 300)` at render time.
  it("clamps body lines to terminal width when cols is passed (no terminal wrap)", () => {
    // 200-char line, cols=90 → effective width = 90 - 4 - 1 = 85.
    // The trim reserves 12 cells for the truncHint marker, so the y-run
    // is 85 - 12 = 73 cells. Body (ys + hint) = 85 cells; +4 gutter =
    // ≤ 89 cells visible, comfortably under the 90-col terminal width.
    const line = "y".repeat(200)
    const lines = formatToolPreview(line, false, undefined, { tool: "Bash", cols: 90 })
    expect(lines.length).toBe(1)
    const visible = stripAnsi(lines[0])
    // The load-bearing assertion : the rendered row fits the terminal.
    expect(displayWidth(visible)).toBeLessThanOrEqual(90)
    // truncHint marker present : the line WAS clamped.
    expect(visible).toContain("...(+")
    const ys = visible.match(/y+/)?.[0] ?? ""
    expect(ys.length).toBe(73)
  })

  it("uses the 300-cell hard cap when terminal cols are wider than 305", () => {
    // 5_000-char line, cols=400 → effective width = min(395, 300) = 300.
    // Hint reserve cuts the z-run to 300 - 12 = 288. Same shape as the
    // "no cols" test (where cols defaults to 300).
    const huge = "z".repeat(5_000)
    const lines = formatToolPreview(huge, false, undefined, { tool: "Bash", cols: 400 })
    expect(lines.length).toBe(1)
    const visible = stripAnsi(lines[0])
    expect(visible).toContain("...(+")
    const zs = visible.match(/z+/)?.[0] ?? ""
    expect(zs.length).toBe(288)
    // Body + gutter ≤ 304 cells (under the 400-col terminal).
    expect(displayWidth(visible)).toBeLessThanOrEqual(304)
  })

  it("does NOT trim a body line that fits in the terminal", () => {
    // 60-char line in a 100-col terminal : fits under 100 - 4 - 1 = 95.
    const line = "k".repeat(60)
    const lines = formatToolPreview(line, false, undefined, { tool: "Bash", cols: 100 })
    expect(stripAnsi(lines[0])).not.toContain("...(+")
  })

  it("clamps the display channel too when cols is passed (Edit/Write diffs in narrow terminal)", () => {
    // A 200-char synthetic diff line in an 80-col terminal MUST clamp,
    // even though it's the "display" branch (where 300-cell preview cap
    // doesn't apply : but the terminal-cols rule still does).
    const display = `+${"a".repeat(199)}`
    const lines = formatToolPreview("model-compact", false, display, {
      tool: "Edit",
      cols: 80,
    })
    expect(lines.length).toBe(1)
    const visible = stripAnsi(lines[0])
    expect(displayWidth(visible)).toBeLessThanOrEqual(80)
    // `clampToolPreviewBodyLine` now delegates to `clampBodyWithHint`
    // so the display branch produces the SAME `...(+Nch)` marker the
    // content-path body lines have. One canonical truncation idiom
    // across both branches.
    expect(visible).toContain("...(+")
    expect(visible).toMatch(/\.{3}\(\+\d+ch\)/)
  })

  it("ignores cols=0 / NaN / negative and falls back to the 300-cell hard cap", () => {
    const huge = "w".repeat(5_000)
    // Each pathological cols input falls back to the hard cap so the
    // body always renders with a visible content slice.
    for (const cols of [0, -10, Number.NaN, Number.POSITIVE_INFINITY]) {
      const lines = formatToolPreview(huge, false, undefined, { tool: "Bash", cols })
      const visible = stripAnsi(lines[0])
      expect(visible).toContain("...(+")
      const ws = visible.match(/w+/)?.[0] ?? ""
      // 288 for all of the above : finite-but-≤0 collapses to the
      // 300-cell hard cap, Infinity goes to the cap via Math.min, and
      // both then reserve 12 cells for the hint marker → 288 body.
      expect(ws.length).toBe(288)
    }
  })

  it("body width depends ONLY on `opts.cols` (not process.stdout.columns) when supplied", () => {
    // The helper prefers opts.cols when it's a positive finite number.
    // Pass cols explicitly and assert the slice : independent of the
    // host process's TTY width.
    const huge = "q".repeat(5_000)
    const lines = formatToolPreview(huge, false, undefined, { tool: "Bash", cols: 50 })
    const visible = stripAnsi(lines[0])
    // 50 - 4 - 1 = 45 cells of body budget, minus 12 cells of hint
    // reserve = 33 cells of body content. Total rendered row ≤ 50.
    const qs = visible.match(/q+/)?.[0] ?? ""
    expect(qs.length).toBe(33)
    expect(displayWidth(visible)).toBeLessThanOrEqual(50)
  })

  // Regression for the May 2026 user-reported bug where a Read tool
  // line containing a `<linenum>\t<content>` body overflowed the
  // visible cols by 1–8 cells and the trailing `...(+Nch)` hint wrapped
  // into the gutter. Root cause: `displayWidth` counts `\t` (HT, 0x09)
  // as 0 cells (it's a control char), but the terminal expands it to
  // an advance to the next tab stop (1–8 cells depending on the
  // current column). Fix: `expandTabs(line, gutterWidth)` runs before
  // `clampBodyWithHint` so the width math accounts for the tab.
  it("clamps a Read-style `<linenum>\\t<content>` line without overflowing visible cols", () => {
    // The reported scenario: a 1-digit line number + tab + long body
    // at cols=137. Before the fix this rendered 138 visible cells (1
    // past the terminal width) and the closing `)` of the truncHint
    // wrapped to a new row.
    const longBody =
      "How to express classic design patterns idiomatically in TypeScript 5.x. " +
      "Covers `satisfies`, `const` type parameters, " +
      "x".repeat(300)
    const line = `3\t${longBody}`
    const lines = formatToolPreview(line, false, undefined, { tool: "Read", cols: 137 })
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const visible = stripAnsi(lines[0])
    // Load-bearing : after the fix, no rendered row exceeds the visible
    // cols (the body's `displayWidth` matches what the terminal paints
    // because `expandTabs` already turned `\t` into the right run of
    // ASCII spaces).
    expect(displayWidth(visible)).toBeLessThanOrEqual(137)
    // Clamp happened (line was much longer than 137 cells).
    expect(visible).toContain("...(+")
    // Verify the tab was expanded (no literal `\t` survives into the
    // rendered transcript output).
    expect(visible).not.toContain("\t")
  })

  it("clamps a Read-style body with a 4-digit line number (worst-case tab advance)", () => {
    // For "1234\t<content>" at cols=137: after the 4-cell gutter and
    // 4 digits, cursor is at col 8. The tab from col 8 advances to
    // col 16 → 8 cells of fill (the worst case). Pre-fix, displayWidth
    // saw 0 cells for the tab; post-fix, it sees 8.
    const line = `1234\t${"y".repeat(500)}`
    const lines = formatToolPreview(line, false, undefined, { tool: "Read", cols: 137 })
    const visible = stripAnsi(lines[0])
    expect(displayWidth(visible)).toBeLessThanOrEqual(137)
    expect(visible).toContain("...(+")
    expect(visible).not.toContain("\t")
  })

  it("Read body line with tab passes through unmodified when it fits", () => {
    // Short Read line with one tab : no clamp triggers, the line
    // still has its tab expanded to spaces in the rendered output.
    // (We don't want a literal `\t` leaking into the transcript even
    // for short lines, since the underlying terminal would still draw
    // it as a tab-stop advance and any downstream consumer measuring
    // the rendered output would mis-count it.)
    const line = `12\tshort content`
    const lines = formatToolPreview(line, false, undefined, { tool: "Read", cols: 100 })
    const visible = stripAnsi(lines[0])
    // No clamp marker (line fits).
    expect(visible).not.toContain("...(+")
    // Tab was still expanded.
    expect(visible).not.toContain("\t")
    // Width sanity : 4-cell gutter + 2 digits (cursor at col 6) +
    // 2-cell tab fill (advance to col 8) + 13 chars body = 21 cells.
    expect(displayWidth(visible)).toBe(21)
  })
})

describe("clampTranscriptRow — outer-row width clamp for header lines", () => {
  // Regression for the May 2026 user-reported HEADER overflow:
  //
  //     ╭ » Bash  $ cat ~/.minimal-agent/sessions/21fd455d-082b-40fe-a8a4-edfe1c16a
  //   1ff.tasks.jsonl 2>&1 | head -50 · 07:30:26
  //
  // The Bash header for a NO-operator long command (or one with a
  // single `|` pipe that the soft-split rule rejects below its
  // overflow trigger) used to soft-wrap into the next physical row,
  // breaking the bordered block. `clampTranscriptRow` catches every
  // case the inner soft-split machinery doesn't.

  it("passes a fitting row through verbatim", () => {
    const row = "  ╭ » Bash  $ ls -la"
    expect(clampTranscriptRow(row, 80)).toBe(row)
  })

  it("clamps a too-long row to cols with truncHint marker", () => {
    const row = `  ╭ » Bash  $ cat ${"/very/long/path".repeat(20)}`
    const clamped = clampTranscriptRow(row, 90)
    expect(clamped).toContain("...(+")
    expect(displayWidth(clamped)).toBeLessThanOrEqual(90)
  })

  it("preserves the leading gutter glyph (`╭ ` / `│ ` / `╰ `) when clamping", () => {
    const row = `  ╭ » Bash  $ ${"x".repeat(500)}`
    const clamped = clampTranscriptRow(row, 80)
    // The gutter `  ╭ ` is preserved verbatim at the row's start —
    // never clipped (we trim from the right end, which holds the
    // command body).
    expect(clamped.startsWith("  ╭ ")).toBe(true)
  })

  it("returns the row unmodified when cols is undefined / NaN / ≤ 0", () => {
    const row = `  ╭ » Bash  $ ${"y".repeat(200)}`
    for (const cols of [undefined, Number.NaN, 0, -10]) {
      expect(clampTranscriptRow(row, cols)).toBe(row)
    }
  })

  it("handles ANSI escapes inside the row (icon color, label bold) without breaking width math", () => {
    // Build a realistic header row with the same ANSI shape the live
    // agent emits : dim-cyan gutter, orange bold label, dim body.
    const ansiRow =
      "  \x1b[2;36m╭\x1b[22;39m \x1b[38;5;208m»\x1b[39m " +
      "\x1b[1;38;5;208mBash\x1b[22;39m  " +
      `\x1b[2m$ ${"z".repeat(200)}\x1b[22m`
    const clamped = clampTranscriptRow(ansiRow, 90)
    // ANSI escapes don't contribute to display width : the rendered
    // row fits within the cap.
    expect(displayWidth(clamped)).toBeLessThanOrEqual(90)
    expect(clamped).toContain("...(+")
  })
})

describe("formatToolPreview — error coloring", () => {
  it("uses red wrap when isError=true (smoke check on ANSI presence)", () => {
    const lines = formatToolPreview("oops", true, undefined, { tool: "Bash" })
    // Red SGR open + red close in the rendered line.
    expect(lines[0]).toMatch(/\x1b\[31m.*\x1b\[39m/)
  })
})
