/**
 * Regression tests for the transcript-sink block-close discriminator.
 *
 * Bug context (user-reported, May 2026):
 *   The tasks plugin renders its body with `treeLast: "╰"` for the last
 *   child of a parent — the SAME glyph the agent uses for the outer
 *   frame closer in tool transcript blocks. The live-area sink at
 *   `runReplLiveArea`'s `onTranscriptLine` (src/agent.ts) was using
 *   `line.includes("╰")` to detect block-close, which collaterally fired
 *   on those subtask rows and emitted an extra `\n` after each — producing
 *   a bare blank line with no `│` gutter prefix between sibling tasks.
 *
 * Visible symptom:
 *
 *     ╭ ○ Tasks · ◐ started #22d9a4a · 0/N
 *     │
 *     │    1  ○  #22d9a4  Fix #1
 *     │        ├  ◐  #22d9a4a  Research
 *     │        ├  ○  #22d9a4b  Implement
 *     │        ╰  ○  #22d9a4c  Add regression test
 *                                                      ← BUG: bare blank, no │
 *     │    2  ○  #b3b64e  Fix #2
 *
 * These tests pin the discriminator semantics: `╰` is only a block-close
 * signal when it sits in the **outer-gutter position** (start of line,
 * after the 2 leading spaces and any ANSI prefix), not when it appears
 * inside the body as a tree-last connector / in titles / in filenames.
 *
 * Companion: the byte-stream regression at the bottom of this file
 * drives `formatToolPreview` + the sink logic end-to-end and asserts
 * "no bare blank between body rows" as the user-observable invariant.
 */

import { describe, expect, it } from "bun:test"

import { c, formatToolPreview, isOuterFrameClose } from "./agent.ts"

describe("isOuterFrameClose — outer-gutter ╰ recognition", () => {
  it("matches a plain outer frame closer (no ANSI)", () => {
    expect(isOuterFrameClose("  ╰ 5 done · 1 doing · 2 todo")).toBe(true)
  })

  it("matches the ANSI-wrapped outer frame closer (real shape)", () => {
    const line = `  ${c.dimCyan("╰")}  0 done · 1 doing · 17 todo`
    expect(isOuterFrameClose(line)).toBe(true)
  })

  it("matches a bare outer frame closer with no body", () => {
    const line = `  ${c.dimCyan("╰")}`
    expect(isOuterFrameClose(line)).toBe(true)
  })
})

describe("isOuterFrameClose — body rows containing ╰ must NOT be classified as close", () => {
  it("rejects a tasks treeLast subtask row (the user-reported bug)", () => {
    // Shape: 2 leading spaces, ANSI │ gutter, body indent, then `╰` as the
    // `treeLast` glyph from the tasks renderer.
    const line = `  ${c.dimCyan("│")}        ╰  ○  #22d9a4c  Add regression test`
    expect(isOuterFrameClose(line)).toBe(false)
  })

  it("rejects a tasks treeLast subtask row without ANSI", () => {
    const line = "  │        ╰  ○  #22d9a4c  Add regression test"
    expect(isOuterFrameClose(line)).toBe(false)
  })

  it("rejects a normal body row whose title content contains ╰", () => {
    const line = `  ${c.dimCyan("│")} note: file ╰.txt has the corner glyph`
    expect(isOuterFrameClose(line)).toBe(false)
  })

  it("rejects a Bash body row whose grep/cat output contains ╰ (user-reported)", () => {
    // Real example: `grep -n 'includes("╰")' src/agent.ts` returns matching
    // lines that contain the literal `╰` character. The streaming Bash
    // renderer wraps each as `  │ <line>`; the discriminator must NOT
    // misclassify these as block-closers.
    const lines = [
      `  ${c.dimCyan("│")} 3002:        const isBlockClose = line.includes("╰")`,
      `  ${c.dimCyan("│")} 3003:        compositor.writeStream(isBlockClose ? \`\${line}\\n\\n\` : \`\${line}\\n\`)`,
      `  ${c.dimCyan("│")} const a = 1 // boundary ╰ glyph in a comment`,
      `  ${c.dimCyan("│")} multiple ╰ ╰ ╰ in a single row`,
    ]
    for (const line of lines) expect(isOuterFrameClose(line)).toBe(false)
  })

  it("rejects an Edit-tool diff row containing ╰ in deleted/added content", () => {
    // Edit's diff render wraps each diff row with the `│` gutter. If the
    // diff itself contains `╰` (e.g. someone edited a file referencing
    // the glyph), the row still must not be classified as block-close.
    const line = `  ${c.dimCyan("│")} -  const isBlockClose = line.includes("╰")`
    expect(isOuterFrameClose(line)).toBe(false)
  })

  it("rejects a streamed `┊` pre-output connector row", () => {
    // The agent emits `  ┊` between the header and the first body row.
    // It must not be confused with the closer.
    const line = `  ${c.dimCyan("┊")}`
    expect(isOuterFrameClose(line)).toBe(false)
  })

  it("rejects a header row (╭ — sanity, no ╰ at all)", () => {
    const line = `  ${c.dimCyan("╭")} ○ Tasks · ◐ started #22d9a4a · 0/9`
    expect(isOuterFrameClose(line)).toBe(false)
  })

  it("rejects an empty-gutter row (just │ with no body)", () => {
    const line = `  ${c.dimCyan("│")}`
    expect(isOuterFrameClose(line)).toBe(false)
  })
})

describe("byte-stream regression — no bare blank between body rows", () => {
  // Mirrors the live-area sink's `\n\n` vs `\n` decision exactly. If the
  // discriminator misfires on a treeLast row, the joined output will
  // contain `\n\n` between body rows — i.e. a row that's just `""` after
  // splitting on `\n`. That's the user-visible artifact.
  function simulateSink(lines: readonly string[]): string {
    let out = ""
    for (const line of lines) {
      out += isOuterFrameClose(line) ? `${line}\n\n` : `${line}\n`
    }
    return out
  }

  it("produces exactly ONE bare blank, and only after the real ╰ closer", () => {
    // A realistic tasks-plugin transcript: header + body rows (some with
    // treeLast ╰) + trailing gutter-only row + real closer. This is the
    // exact pattern the user pasted.
    const lines = [
      `  ${c.dimCyan("╭")} ○ Tasks · ◐ started #22d9a4a · 0/4`,
      `  ${c.dimCyan("┊")}`,
      `  ${c.dimCyan("│")}    1  ○  #22d9a4  Fix #1`,
      `  ${c.dimCyan("│")}        ├  ◐  #22d9a4a  Research`,
      `  ${c.dimCyan("│")}        ├  ○  #22d9a4b  Implement`,
      `  ${c.dimCyan("│")}        ╰  ○  #22d9a4c  Add regression test`, // treeLast
      `  ${c.dimCyan("│")}    2  ○  #b3b64e  Fix #2`,
      `  ${c.dimCyan("│")}        ╰  ○  #b3b64ec  Implement`, // treeLast
      `  ${c.dimCyan("│")}    3  ○  #f64bf0  Fix #3`,
      `  ${c.dimCyan("│")}`,
      `  ${c.dimCyan("╰")}  0 done · 1 doing · 3 todo`, // real closer
    ]

    const stream = simulateSink(lines)
    const rows = stream.replace(/\x1b\[[0-9;]*m/g, "").split("\n")

    // Count bare blank rows (= "" entries in the split). The final
    // trailing "" from the last `\n` is always present; we care about
    // INTERIOR bares (between body rows). Real outer-closer adds ONE
    // bare blank after itself (the breathing-room invariant), then the
    // trailing terminator gives a second "" entry at the very end.
    const interiorBares: number[] = []
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i] === "") interiorBares.push(i)
    }

    // Interior bare blanks should appear ONLY after the real ╰ closer
    // (the very last non-empty row). If the discriminator misfires on
    // a treeLast subtask, there will be additional interior bares at
    // the positions of those rows.
    const closerIdx = rows.findIndex((r) => r.startsWith("  ╰"))
    expect(closerIdx).toBeGreaterThan(0)

    // The ONE legitimate blank is at closerIdx + 1.
    expect(interiorBares).toEqual([closerIdx + 1])
  })

  it("emits zero bare blanks when no outer closer is present", () => {
    // Body-only fragment (e.g. mid-stream tool body) — all rows have a
    // gutter glyph. Even if a treeLast `╰` appears, no `\n\n` should fire.
    const lines = [
      `  ${c.dimCyan("│")}    1  ○  #aaaaaa  parent`,
      `  ${c.dimCyan("│")}        ╰  ○  #aaaaaaa  last child`,
      `  ${c.dimCyan("│")}    2  ○  #bbbbbb  parent`,
    ]
    const stream = simulateSink(lines)
    const rows = stream.replace(/\x1b\[[0-9;]*m/g, "").split("\n")
    // Only the trailing "" from the final \n is allowed.
    const interiorBares = rows.slice(0, -1).filter((r) => r === "")
    expect(interiorBares).toEqual([])
  })

  it("user-reported Bash scenario: grep output containing ╰ doesn't blank-line-corrupt", () => {
    // Replays the user's exact Bash transcript from the bug report:
    //   $ grep -n 'includes("╰")' src/agent.ts
    // The grep results contain the literal `╰` character on body rows
    // and on the closer (which contains the matched grep line again).
    // BEFORE the fix: every body row containing `╰` got an extra `\n`,
    // producing bare blanks between the header/body/body/closer rows.
    const lines = [
      `  ${c.dimCyan("╭")} » Bash  $ grep -n 'includes("╰")' src/agent.ts`,
      `  ${c.dimCyan("┊")}`,
      `  ${c.dimCyan("│")} 3002:        const isBlockClose = line.includes("╰")`,
      `  ${c.dimCyan("╰")} 3003:        compositor.writeStream(isBlockClose ? line+'\\n\\n' : line+'\\n')`,
    ]
    const stream = simulateSink(lines)
    const rows = stream.replace(/\x1b\[[0-9;]*m/g, "").split("\n")

    // Header (╭ row) must NOT add a blank below (just \n, not \n\n).
    // The interior body row with `│ ... includes("╰") ...` must NOT add
    // a blank below. Only the real `  ╰ 3003:...` closer at the end
    // should add the breathing-room blank.
    const interiorBares: number[] = []
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i] === "") interiorBares.push(i)
    }
    const closerIdx = rows.findIndex((r) => r.startsWith("  ╰"))
    expect(closerIdx).toBeGreaterThan(0)
    expect(interiorBares).toEqual([closerIdx + 1])

    // Spelled out: the header row must NOT be followed by a bare blank
    // even though it textually contains `'includes("╰")'` (the shell
    // command itself referenced the glyph).
    const headerIdx = rows.findIndex((r) => r.includes("» Bash"))
    expect(headerIdx).toBeGreaterThanOrEqual(0)
    expect(rows[headerIdx + 1]).not.toBe("") // expect `  ┊`, not ""
  })

  it("emits the breathing-room blank after a real closer (positive case)", () => {
    // Plain tool with no subtask glyphs — just header + body + closer.
    // The closer must STILL produce the breathing-room blank.
    const lines = [
      `  ${c.dimCyan("╭")} ✦ Read $ src/foo.ts`,
      `  ${c.dimCyan("┊")}`,
      `  ${c.dimCyan("│")} line 1`,
      `  ${c.dimCyan("│")} line 2`,
      `  ${c.dimCyan("╰")} shown 2/2 L`,
    ]
    const stream = simulateSink(lines)
    const rows = stream.replace(/\x1b\[[0-9;]*m/g, "").split("\n")
    const closerIdx = rows.findIndex((r) => r.startsWith("  ╰"))
    expect(closerIdx).toBeGreaterThan(0)
    expect(rows[closerIdx + 1]).toBe("")
  })
})

describe("byte-stream regression — wired through formatToolPreview", () => {
  // Drive the exact rendering pipeline the tasks plugin uses:
  // formatToolPreview receives a multi-row `display` body that contains
  // treeLast `╰` glyphs, plus a `footer` (which routes the close glyph
  // to the dedicated `╰ <footer>` row). The output array is then fed
  // line-by-line through the sink simulator. The user's bug requires
  // that NO interior bare blank appear from misfired discriminations.
  it("produces no spurious blanks for tasks-style display+footer body", () => {
    // Realistic display body: 2 parents, each with 3 subtasks where the
    // last child uses ╰ as its tree connector. The body line content is
    // what `renderToolDisplay` would produce (un-framed; the agent's
    // formatToolPreview wraps each row with `  │ `).
    const body = [
      "   1  ○  #22d9a4  Fix #1",
      "       ├  ◐  #22d9a4a  Research",
      "       ├  ○  #22d9a4b  Implement",
      "       ╰  ○  #22d9a4c  Add regression test",
      "   2  ○  #b3b64e  Fix #2",
      "       ├  ○  #b3b64ea  Research",
      "       ├  ○  #b3b64eb  Decide",
      "       ╰  ○  #b3b64ec  Implement",
      "",
    ].join("\n")
    const footer = " 0 done · 1 doing · 8 todo"

    const lines = formatToolPreview(body, false, body, {
      tool: "Task",
      footer,
      cols: 200,
    })

    // Sink simulation
    let stream = ""
    for (const line of lines) {
      stream += isOuterFrameClose(line) ? `${line}\n\n` : `${line}\n`
    }
    const rows = stream.replace(/\x1b\[[0-9;]*m/g, "").split("\n")

    // Exactly ONE interior bare blank, and it must be immediately after
    // the row that starts with `  ╰` (the real closer).
    const interiorBares: number[] = []
    for (let i = 0; i < rows.length - 1; i++) {
      if (rows[i] === "") interiorBares.push(i)
    }
    const closerIdx = rows.findIndex((r) => r.startsWith("  ╰"))
    expect(closerIdx).toBeGreaterThan(0)
    expect(interiorBares).toEqual([closerIdx + 1])
  })
})
