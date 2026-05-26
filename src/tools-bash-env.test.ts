/**
 * Regression tests for the env vars `execBash` injects into the bash
 * subprocess.
 *
 * Background
 * ----------
 * `Bun.spawn` in `execBash` (src/tools.ts) forwards `process.env` wholesale
 * and then overrides three things:
 *
 *   - `TERM=dumb` so subprocess tools don't emit ANSI escapes that would
 *     corrupt our tool-output rendering.
 *   - `COLUMNS=<process.stdout.columns>` so tools inside Bash (`tput cols`,
 *     `stty size` fallback, shell scripts that consult `$COLUMNS`) see
 *     real values instead of macOS BSD tput's hardcoded 80×24 fallback.
 *   - `LINES=<process.stdout.rows>` for symmetry.
 *
 * Node/Bun does NOT auto-populate `process.env.COLUMNS` : the live terminal
 * size lives in `process.stdout.columns` (sourced from ioctl(TIOCGWINSZ)).
 * Without explicit injection, the bash subprocess sees empty `$COLUMNS` and
 * `tput cols` lands on its 80×24 hardcoded last-resort. This test pins the
 * forwarding contract.
 *
 * Snapshot-at-spawn semantics : if the user resizes mid-command, `$COLUMNS`
 * inside that bash does NOT update. Acceptable for short-lived commands;
 * mirrors `src/formatter.ts:buildEnv`. Not exercised here (would require
 * SIGWINCH plumbing).
 *
 * Env isolation
 * -------------
 * The test asserts what `execBash` injects from `process.stdout.{columns,rows}`
 * into the subprocess. We MUST scrub any inherited `COLUMNS`/`LINES` on
 * `process.env` before each test : without scrubbing, when this file runs
 * nested inside another minimal-agent's `execBash` (or any shell that
 * exported `COLUMNS`), the parent has already injected `COLUMNS=NNN` into
 * our `process.env`, and the `{ ...process.env, ... }` spread inside our
 * own `execBash` would re-forward it to the inner subprocess, masking the
 * "no TTY" branch (subprocess sees `COLUMNS=NNN` even though our local
 * `process.stdout.columns` is unset).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { executeTool } from "./tools.ts"

describe("Bash tool : env injection", () => {
  let savedCols: string | undefined
  let savedLines: string | undefined

  beforeEach(() => {
    savedCols = process.env.COLUMNS
    savedLines = process.env.LINES
    delete process.env.COLUMNS
    delete process.env.LINES
  })

  afterEach(() => {
    if (savedCols === undefined) delete process.env.COLUMNS
    else process.env.COLUMNS = savedCols
    if (savedLines === undefined) delete process.env.LINES
    else process.env.LINES = savedLines
  })

  it("forwards process.stdout.columns as $COLUMNS", async () => {
    const want = process.stdout.columns
    if (typeof want !== "number" || want <= 0) {
      // Running under bun test without a TTY : the injection is correctly
      // skipped and the subprocess sees no $COLUMNS. Assert the negative.
      const r = await executeTool("Bash", { command: 'printf "%s" "${COLUMNS-}"' })
      expect(r.content).toBe("")
      return
    }
    const r = await executeTool("Bash", { command: 'printf "%s" "${COLUMNS-}"' })
    expect(r.content).toBe(String(Math.floor(want)))
  })

  it("forwards process.stdout.rows as $LINES", async () => {
    const want = process.stdout.rows
    if (typeof want !== "number" || want <= 0) {
      const r = await executeTool("Bash", { command: 'printf "%s" "${LINES-}"' })
      expect(r.content).toBe("")
      return
    }
    const r = await executeTool("Bash", { command: 'printf "%s" "${LINES-}"' })
    expect(r.content).toBe(String(Math.floor(want)))
  })

  it("keeps TERM=dumb (capabilities belong to TERM, not COLUMNS)", async () => {
    const r = await executeTool("Bash", { command: 'printf "%s" "$TERM"' })
    expect(r.content).toBe("dumb")
  })
})
