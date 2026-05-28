/**
 * Drift guard for the tasks PROMPT.md.
 *
 * The model-facing prompt is the only thing keeping the agent from
 * reaching for `canceled` to mean "phase complete". The renderer
 * paints canceled rows in red with strikethrough, which is the
 * opposite of what "the phase is done" should look like.
 *
 * A real session in May 2026 hit exactly this: every "PHASE N"
 * top-level task got marked `canceled` with reason "phase header,
 * all subtasks done" once its phase finished. The user saw 7 red
 * strikethrough rows interleaved with the lime ✔ children and asked
 * why completed tasks were red. They weren't completed in the data,
 * they were canceled. Agent's fault, not the renderer's.
 *
 * The PROMPT.md addition below the `## Status state machine` section
 * (heading: `canceled is "abandoned", not "done"`) names the
 * anti-pattern explicitly. This test pins that guidance is present so
 * a future PROMPT.md rewrite either keeps it, or fails this guard and
 * forces the maintainer to think about it.
 *
 * If you delete the section, fix this test AND make sure the
 * replacement carries the same warning. Don't just nuke both.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, test } from "bun:test"

const PROMPT_PATH = join(import.meta.dir, "..", "PROMPT.md")
const PROMPT = readFileSync(PROMPT_PATH, "utf8")

describe("tasks PROMPT.md canceled-vs-done guidance", () => {
  test("has a dedicated section distinguishing canceled from done", () => {
    // Heading marker. The section anchors all the other assertions, so
    // grep for the exact heading text first.
    expect(PROMPT).toMatch(/##\s+`canceled`\s+is\s+"abandoned",\s+not\s+"done"/)
  })

  test("defines canceled = abandoned and done = finished", () => {
    expect(PROMPT).toMatch(/`canceled`\s+means\s+the\s+work\s+was\s+given\s+up\s+on/i)
    expect(PROMPT).toMatch(/`done`\s+means\s+the\s+work[\s\S]{0,40}finished/i)
  })

  test("explicitly addresses the phase-header anti-pattern", () => {
    // The wrong inference was: "phase header has no direct work, so
    // cancel it when subtasks are done." The doc must contradict it
    // by name.
    const block = PROMPT.split(/^##\s/m).find((s) => /canceled[^\n]*abandoned/i.test(s))
    expect(block, "expected the canceled-vs-done section to exist").toBeDefined()
    expect(block!).toMatch(/phase/i)
    expect(block!).toMatch(/header/i)
    expect(block!).toMatch(/`done`/)
  })

  test("notes that parents with all-done children are done, not canceled", () => {
    const block = PROMPT.split(/^##\s/m).find((s) => /canceled[^\n]*abandoned/i.test(s))
    expect(block!).toMatch(/parent/i)
    expect(block!).toMatch(/subtasks?\s+(?:are\s+)?all\s+`?done`?/i)
  })

  test("recommends parent/subtask structure for multi-phase plans", () => {
    const block = PROMPT.split(/^##\s/m).find((s) => /canceled[^\n]*abandoned/i.test(s))
    expect(block!).toMatch(/parent\/subtask|parent.*subtask/i)
    // Code example showing the pattern.
    expect(block!).toMatch(/parent:\s*`?#\$\{/)
  })

  test('"## Don\'t" section repeats the canceled-vs-done warning', () => {
    // Belt-and-suspenders: a model that skims the "Don't" list should
    // also see the warning, not just the standalone section.
    const dontBlock = PROMPT.split(/^##\s/m).find((s) => /^Don't/m.test(s))
    expect(dontBlock, "expected a Don't section").toBeDefined()
    expect(dontBlock!).toMatch(/`canceled`\s+when\s+you\s+mean\s+`done`/)
  })
})
