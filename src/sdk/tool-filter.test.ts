/**
 * Unit tests for the pure SDK tool-advertisement policy helpers.
 */

import { describe, expect, test } from "bun:test"

import type { ToolDefinition } from "./ports.ts"
import { applyToolNamePolicy, isToolNameAllowed, toolFilterFromNamePolicy } from "./tool-filter.ts"

const TOOLS = [{ name: "Read" }, { name: "Task" }, { name: "WebSearch" }] as const

describe("applyToolNamePolicy", () => {
  test("null policy is a pass-through (same order)", () => {
    expect(applyToolNamePolicy(TOOLS, null)).toEqual([...TOOLS])
  })

  test("deny-all returns empty", () => {
    expect(applyToolNamePolicy(TOOLS, { kind: "deny-all" })).toEqual([])
  })

  test("allow-list keeps only listed names in registration order", () => {
    expect(
      applyToolNamePolicy(TOOLS, { kind: "allow-list", tools: ["WebSearch", "Read"] }),
    ).toEqual([{ name: "Read" }, { name: "WebSearch" }])
  })

  test("allow-list with no matches returns empty", () => {
    expect(applyToolNamePolicy(TOOLS, { kind: "allow-list", tools: ["Bash"] })).toEqual([])
  })
})

describe("isToolNameAllowed", () => {
  test("null policy permits every name", () => {
    expect(isToolNameAllowed("Bash", null)).toEqual({ allowed: true })
  })

  test("deny-all refuses every name", () => {
    expect(isToolNameAllowed("Read", { kind: "deny-all" })).toEqual({
      allowed: false,
      reason: "deny-all",
    })
  })

  test("allow-list permits only listed names", () => {
    const policy = { kind: "allow-list" as const, tools: ["WebSearch"] }
    expect(isToolNameAllowed("WebSearch", policy)).toEqual({ allowed: true })
    expect(isToolNameAllowed("Read", policy)).toEqual({
      allowed: false,
      reason: "allow-list",
    })
  })
})

describe("toolFilterFromNamePolicy", () => {
  const defs: ToolDefinition[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.name,
    input_schema: {},
  }))

  test("builds a ToolAdvertisementFilter port", () => {
    const filter = toolFilterFromNamePolicy({
      kind: "allow-list",
      tools: ["WebSearch"],
    })
    expect(filter.filter(defs).map((t) => t.name)).toEqual(["WebSearch"])
  })

  test("null policy advertises the full registry", () => {
    const filter = toolFilterFromNamePolicy(null)
    expect(filter.filter(defs)).toEqual(defs)
  })
})
