/** Tests for the host-owned `/continue` command. */

import { describe, expect, it } from "bun:test"

import type { CommandContext } from "../../plugins/types.ts"

import { createContinueHostCommand, registerContinueHostCommand } from "./continue.ts"

const noopLog = {
  emergency: () => {},
  alert: () => {},
  critical: () => {},
  error: () => {},
  warn: () => {},
  notice: () => {},
  info: () => {},
  debug: () => {},
}

function bareCtx(): CommandContext {
  return {
    name: "continue",
    argv: "",
    rawLine: "/continue",
    cwd: process.cwd(),
    env: {},
    abort: new AbortController().signal,
    log: noopLog,
    emit: () => {},
  }
}

describe("createContinueHostCommand", () => {
  it("returns a host command named continue", () => {
    const cmd = createContinueHostCommand({ noteSessionResumed: () => {} })
    expect(cmd.pluginId).toBe("host")
    expect(cmd.spec.name).toBe("continue")
    expect(cmd.spec.summary.toLowerCase()).toContain("resume")
  })

  it("marks the next run as resumed and expands to an attachments-only turn", async () => {
    let calls = 0
    const cmd = createContinueHostCommand({
      noteSessionResumed: () => {
        calls++
      },
    })

    await expect(cmd.invoke(bareCtx())).resolves.toEqual({ kind: "expand", prompt: "" })
    expect(calls).toBe(1)
  })
})

describe("registerContinueHostCommand", () => {
  it("no-ops when loader is null", () => {
    expect(registerContinueHostCommand(null, { noteSessionResumed: () => {} })).toBe(false)
  })

  it("registers via loader.registerHostCommand", () => {
    const seen: string[] = []
    const ok = registerContinueHostCommand(
      {
        registerHostCommand(cmd) {
          seen.push(cmd.spec.name)
          return true
        },
      },
      { noteSessionResumed: () => {} },
    )
    expect(ok).toBe(true)
    expect(seen).toEqual(["continue"])
  })
})
