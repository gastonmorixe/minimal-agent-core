/**
 * Host `/compact` command registration + invoke.
 *
 * @module host/commands/compact.test
 */

import { describe, expect, it } from "bun:test"

import type { CommandContext } from "../../plugins/types.ts"

import { createCompactHostCommand, registerCompactHostCommand } from "./compact.ts"

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
    name: "compact",
    argv: "",
    rawLine: "/compact",
    cwd: process.cwd(),
    env: {},
    abort: new AbortController().signal,
    log: noopLog,
    emit: () => {},
  }
}

describe("createCompactHostCommand", () => {
  it("returns a host ResolvedCommand named compact", () => {
    const cmd = createCompactHostCommand({
      compact: async () => ({
        reason: "manual",
        kind: "local",
        messagesBefore: 10,
        messagesAfter: 3,
      }),
    })
    expect(cmd.pluginId).toBe("host")
    expect(cmd.spec.name).toBe("compact")
    expect(cmd.spec.summary.toLowerCase()).toContain("compact")
  })

  it("invoke calls agent.compact and returns a notice", async () => {
    let called = false
    const cmd = createCompactHostCommand({
      compact: async (opts) => {
        called = true
        expect(opts?.reason).toBe("manual")
        return {
          reason: "manual",
          kind: "remote",
          messagesBefore: 20,
          messagesAfter: 4,
        }
      },
    })
    const result = await cmd.invoke(bareCtx())
    expect(called).toBe(true)
    expect(result).toEqual({
      kind: "notice",
      lines: ["✓ compact (remote): 20 → 4 messages"],
    })
  })

  it("invoke errors when agent has no compact method", async () => {
    const cmd = createCompactHostCommand({})
    const result = await cmd.invoke(bareCtx())
    expect(result.kind).toBe("error")
  })
})

describe("registerCompactHostCommand", () => {
  it("no-ops when loader is null", () => {
    expect(
      registerCompactHostCommand(null, {
        compact: async () => ({
          reason: "manual",
          kind: "local",
          messagesBefore: 0,
          messagesAfter: 0,
        }),
      }),
    ).toBe(false)
  })

  it("registers via loader.registerHostCommand", () => {
    const seen: string[] = []
    const ok = registerCompactHostCommand(
      {
        registerHostCommand(cmd) {
          seen.push(cmd.spec.name)
          return true
        },
      },
      {
        compact: async () => ({
          reason: "manual",
          kind: "local",
          messagesBefore: 1,
          messagesAfter: 1,
        }),
      },
    )
    expect(ok).toBe(true)
    expect(seen).toEqual(["compact"])
  })
})
