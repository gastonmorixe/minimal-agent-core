/**
 * Host `/compact` command registration + invoke.
 *
 * @module host/commands/compact.test
 */

import { describe, expect, it } from "bun:test"

import type { CompactStats } from "../../agent/context-compact.ts"
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
      block: {
        icon: "✓",
        title: "compact (remote): 20 → 4 messages",
        body: ["Summary unavailable (stub checkpoint). 4 messages kept verbatim."],
      },
    })
  })

  it("invoke shows stub fallback body for local mode with no summary", async () => {
    const cmd = createCompactHostCommand({
      compact: async () => ({
        reason: "manual",
        kind: "local",
        messagesBefore: 20,
        messagesAfter: 7,
      }),
    })
    const result = await cmd.invoke(bareCtx())
    expect(result.kind).toBe("notice")
    const block = (result as { block: { title: string; body: string[] } }).block
    expect(block.body).toEqual(["Summary unavailable (stub checkpoint). 7 messages kept verbatim."])
  })

  it("invoke renders summaryText into the notice block body", async () => {
    const cmd = createCompactHostCommand({
      compact: async () => ({
        reason: "manual",
        kind: "local",
        messagesBefore: 20,
        messagesAfter: 7,
        summaryText: "## 1. Goal\nShip it\n\n## 7. Next step\nRun tests",
      }),
    })
    const result = await cmd.invoke(bareCtx())
    expect(result.kind).toBe("notice")
    const block = (result as { block: { title: string; body: string[] } }).block
    expect(block.title).toContain("20 → 7")
    expect(block.body.join("\n")).toContain("## 1. Goal")
  })

  it("invoke shows tail note and no summary for tail mode", async () => {
    const cmd = createCompactHostCommand({
      compact: async () => ({
        reason: "manual",
        kind: "local",
        messagesBefore: 20,
        messagesAfter: 7,
      }),
    })
    const result = await cmd.invoke({
      ...bareCtx(),
      argv: "tail",
      rawLine: "/compact tail",
    })
    expect(result.kind).toBe("notice")
    const block = (result as { block: { title: string; body: string[] } }).block
    expect(block.title).toContain("20 → 7")
    expect(block.body.join("\n")).toContain("verbatim")
  })

  it("invoke surfaces remoteError as the block footer", async () => {
    const cmd = createCompactHostCommand({
      compact: async () => ({
        reason: "manual",
        kind: "local",
        messagesBefore: 20,
        messagesAfter: 7,
        remoteError: "boom",
      }),
    })
    const result = await cmd.invoke(bareCtx())
    expect(result).toEqual({
      kind: "notice",
      block: {
        icon: "✓",
        title: "compact (local): 20 → 7 messages",
        body: ["Summary unavailable (stub checkpoint). 7 messages kept verbatim."],
        footer: "remote unavailable: boom",
      },
    })
  })

  it("invoke errors when agent has no compact method", async () => {
    const cmd = createCompactHostCommand({})
    const result = await cmd.invoke(bareCtx())
    expect(result.kind).toBe("error")
  })

  it("FAIL-FIRST: failed local compact renders a footer distinct from the intentional stub body", async () => {
    const stats = {
      reason: "manual",
      kind: "local",
      messagesBefore: 20,
      messagesAfter: 7,
      summaryError: "boom-summary",
    } as unknown as CompactStats
    const cmd = createCompactHostCommand({
      compact: async () => stats,
    })
    const result = await cmd.invoke(bareCtx())
    expect(result.kind).toBe("notice")
    const block = (result as { block: { title: string; body: string[]; footer?: string } }).block
    expect(block.body.join("\n")).toContain("stub checkpoint")
    expect(block.footer).toBeDefined()
    expect(String(block.footer)).toContain("boom-summary")
    const stubCmd = createCompactHostCommand({
      compact: async () => ({
        reason: "manual",
        kind: "local",
        messagesBefore: 20,
        messagesAfter: 7,
      }),
    })
    const stubResult = await stubCmd.invoke(bareCtx())
    const stubBlock = (stubResult as { block: { footer?: string } }).block
    expect(stubBlock.footer).toBeUndefined()
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
