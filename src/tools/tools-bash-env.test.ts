/**
 * Regression tests for the env vars `execBash` injects into the bash
 * subprocess.
 *
 * Background
 * ----------
 * `Bun.spawn` in `execBash` (src/tools/tools.ts) forwards `process.env`
 * wholesale, adds the host's `toolEnv` values, and then sets `TERM=dumb`
 * so subprocess tools don't emit ANSI escapes that would corrupt the tool
 * output.
 *
 * Spec S24: this module never reads `process.stdout` and never picks a
 * terminal size. The host supplies the env names and values through the
 * injected `toolEnv` port (`src/sdk/tool-env.ts`). A terminal host uses
 * it for its own terminal size. With no port, the subprocess sees no added
 * values. This test pins the forwarding contract on the port, not on
 * `process.stdout`. The values are read once at spawn.
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

function fixedToolEnv(env: Record<string, string>): ToolEnvPort {
  return { values: () => ({ env }) }
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

  it("forwards a host COLUMNS value", async () => {
    const r = await executeTool(
      "Bash",
      { command: 'printf "%s" "${COLUMNS-}"' },
      { toolEnv: fixedToolEnv({ COLUMNS: "97" }) },
    )
    expect(r.content).toBe("97")
  })

  it("forwards a host LINES value", async () => {
    const r = await executeTool(
      "Bash",
      { command: 'printf "%s" "${LINES-}"' },
      { toolEnv: fixedToolEnv({ LINES: "31" }) },
    )
    expect(r.content).toBe("31")
  })

  it("with no toolEnv port, injects neither $COLUMNS nor $LINES", async () => {
    const r = await executeTool("Bash", { command: 'printf "%s" "${COLUMNS-}:${LINES-}"' })
    expect(r.content).toBe(":")
  })

  it("keeps TERM=dumb, also when the host gives a TERM value", async () => {
    const r = await executeTool("Bash", { command: 'printf "%s" "$TERM"' })
    expect(r.content).toBe("dumb")
    const hostTerm = await executeTool(
      "Bash",
      { command: 'printf "%s" "$TERM"' },
      { toolEnv: fixedToolEnv({ TERM: "xterm-256color" }) },
    )
    expect(hostTerm.content).toBe("dumb")
  })
})
