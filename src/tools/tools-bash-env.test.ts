/**
 * Regression tests for the env vars `execBash` injects into the bash
 * subprocess.
 *
 * Background
 * ----------
 * `Bun.spawn` in `execBash` (src/tools/tools.ts) forwards `process.env`
 * wholesale and then overrides three things:
 *
 *   - `TERM=dumb` so subprocess tools don't emit ANSI escapes that would
 *     corrupt our tool-output rendering.
 *   - `COLUMNS=<toolEnv.values().columns>` so tools inside Bash (`tput cols`,
 *     `stty size` fallback, shell scripts that consult `$COLUMNS`) see
 *     real values instead of macOS BSD tput's hardcoded 80×24 fallback.
 *   - `LINES=<toolEnv.values().lines>` for symmetry.
 *
 * Spec S24: this module never reads `process.stdout` itself; the values
 * come from the injected `toolEnv` port (`src/sdk/tool-env.ts`), which the
 * host builds from its own view of the controlling terminal. With no port
 * (or a port that reports nothing), the subprocess sees empty `$COLUMNS` /
 * `$LINES` and `tput cols` lands on its 80×24 hardcoded last-resort. This
 * test pins the forwarding contract on the port, not on `process.stdout`.
 *
 * Snapshot-at-spawn semantics : if the user resizes mid-command, `$COLUMNS`
 * inside that bash does NOT update. Acceptable for short-lived commands;
 * mirrors `minimal-agent-cli/src/ui/formatter/formatter.ts:formatterEnv`. Not exercised here (would require
 * SIGWINCH plumbing).
 *
 * Env isolation
 * -------------
 * We MUST scrub any inherited `COLUMNS`/`LINES` on `process.env` before
 * each test : without scrubbing, when this file runs nested inside another
 * minimal-agent's `execBash` (or any shell that exported `COLUMNS`), the
 * parent has already injected `COLUMNS=NNN` into our `process.env`, and the
 * `{ ...process.env, ... }` spread inside our own `execBash` would
 * re-forward it to the inner subprocess, masking the "no port" branch.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import type { ToolEnvPort } from "../sdk/tool-env.ts"

import { executeTool } from "./tools.ts"

function fixedToolEnv(columns?: number, lines?: number): ToolEnvPort {
  return {
    values: () => ({
      ...(columns !== undefined ? { columns } : {}),
      ...(lines !== undefined ? { lines } : {}),
    }),
  }
}

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

  it("forwards toolEnv().columns as $COLUMNS", async () => {
    const r = await executeTool(
      "Bash",
      { command: 'printf "%s" "${COLUMNS-}"' },
      { toolEnv: fixedToolEnv(97) },
    )
    expect(r.content).toBe("97")
  })

  it("forwards toolEnv().lines as $LINES", async () => {
    const r = await executeTool(
      "Bash",
      { command: 'printf "%s" "${LINES-}"' },
      { toolEnv: fixedToolEnv(undefined, 31) },
    )
    expect(r.content).toBe("31")
  })

  it("with no toolEnv port, injects neither $COLUMNS nor $LINES", async () => {
    const r = await executeTool("Bash", { command: 'printf "%s" "${COLUMNS-}:${LINES-}"' })
    expect(r.content).toBe(":")
  })

  it("keeps TERM=dumb (capabilities belong to TERM, not COLUMNS)", async () => {
    const r = await executeTool("Bash", { command: 'printf "%s" "$TERM"' })
    expect(r.content).toBe("dumb")
  })
})
