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

import { bashChildEnv, executeTool, SUBAGENT_IDENTITY_ENV_KEYS } from "./tools.ts"

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

describe("Bash tool : BUN_BE_BUN never reaches the command", () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.BUN_BE_BUN
  })

  afterEach(() => {
    if (saved === undefined) delete process.env.BUN_BE_BUN
    else process.env.BUN_BE_BUN = saved
  })

  it("drops a BUN_BE_BUN the parent process has", async () => {
    process.env.BUN_BE_BUN = "1"
    const r = await executeTool("Bash", { command: 'printf "%s" "${BUN_BE_BUN-unset}"' })
    expect(r.content).toBe("unset")
  })

  it("drops a BUN_BE_BUN the host toolEnv port gives", async () => {
    const r = await executeTool(
      "Bash",
      { command: 'printf "%s:%s" "${BUN_BE_BUN-unset}" "${COLUMNS-}"' },
      { toolEnv: fixedToolEnv({ BUN_BE_BUN: "1", COLUMNS: "80" }) },
    )
    expect(r.content).toBe("unset:80")
  })
})

describe("Bash tool : sub-agent identity keys never reach the command", () => {
  const IDENTITY = [
    "MINIMAL_AGENT_SUBAGENT_LEAD",
    "MINIMAL_AGENT_SUBAGENT_ID",
    "MINIMAL_AGENT_SUBAGENT_ROLE",
    "MINIMAL_AGENT_SUBAGENT_SID",
    "MINIMAL_AGENT_SUBAGENT_DEPTH",
    "MINIMAL_AGENT_SUBAGENT_RESULT_PATH",
    "MINIMAL_AGENT_SUBAGENT_EXPECT_ARTIFACTS",
    "MINIMAL_AGENT_LEAD_PID",
  ] as const
  /** User config keys with the same prefix: they must stay (P1 review N5). */
  const CONFIG = [
    "MINIMAL_AGENT_SUBAGENT_MODEL",
    "MINIMAL_AGENT_SUBAGENT_AUTO_TIER",
    "MINIMAL_AGENT_SUBAGENT_MAX_DEPTH",
    "MINIMAL_AGENT_SUBAGENT_MAX_CONCURRENT",
    "MINIMAL_AGENT_SUBAGENT_MAX_TOTAL",
    "MINIMAL_AGENT_SUBAGENT_INHERIT",
    "MINIMAL_AGENT_SUBAGENT_NO_PRESENCE",
    "MINIMAL_AGENT_SUBAGENT_TOKEN_BUDGET",
  ] as const
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    saved = {}
    for (const k of [...IDENTITY, ...CONFIG]) saved[k] = process.env[k]
  })

  afterEach(() => {
    for (const k of [...IDENTITY, ...CONFIG]) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it("the key list is the identity keys only", () => {
    expect([...SUBAGENT_IDENTITY_ENV_KEYS].sort()).toEqual([...IDENTITY].sort())
  })

  it("drops each identity key of the parent process and keeps the config keys", async () => {
    for (const k of IDENTITY) process.env[k] = "x"
    for (const k of CONFIG) process.env[k] = "cfg"
    const r = await executeTool("Bash", {
      command: 'env | grep -E "^MINIMAL_AGENT_(SUBAGENT_|LEAD_PID)" | cut -d= -f1 | sort',
    })
    expect(r.content.trim().split("\n")).toEqual([...CONFIG].sort())
  })

  it("drops them from the host toolEnv port too, and keeps other keys", async () => {
    const r = await executeTool(
      "Bash",
      {
        command:
          'printf "%s:%s:%s:%s" "${MINIMAL_AGENT_SUBAGENT_LEAD-unset}" "${MINIMAL_AGENT_LEAD_PID-unset}" "${MINIMAL_AGENT_SUBAGENT_MODEL-unset}" "${COLUMNS-}"',
      },
      {
        toolEnv: fixedToolEnv({
          MINIMAL_AGENT_SUBAGENT_LEAD: "L",
          MINIMAL_AGENT_LEAD_PID: "42",
          MINIMAL_AGENT_SUBAGENT_MODEL: "m1",
          COLUMNS: "80",
        }),
      },
    )
    expect(r.content).toBe("unset:unset:m1:80")
  })

  it("bashChildEnv is pure: the input is not changed", () => {
    const env = {
      MINIMAL_AGENT_SUBAGENT_ID: "A1",
      MINIMAL_AGENT_SUBAGENT_MAX_DEPTH: "2",
      PATH: "/bin",
    }
    const out = bashChildEnv(env)
    expect(out.MINIMAL_AGENT_SUBAGENT_ID).toBeUndefined()
    expect(out.MINIMAL_AGENT_SUBAGENT_MAX_DEPTH).toBe("2")
    expect(env.MINIMAL_AGENT_SUBAGENT_ID).toBe("A1")
  })
})
