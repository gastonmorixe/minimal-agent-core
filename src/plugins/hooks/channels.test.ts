import { describe, expect, test } from "bun:test"

import { CHANNEL_BY_NAME, CHANNELS, hasPermission, permissionMatches } from "./channels.ts"

describe("channels registry", () => {
  test("no duplicate names", () => {
    const seen = new Set<string>()
    for (const c of CHANNELS) {
      expect(seen.has(c.name)).toBe(false)
      seen.add(c.name)
    }
  })

  test("every channel has a valid shape", () => {
    const valid = new Set(["broadcast-sync", "broadcast-async", "chain", "stream"])
    for (const c of CHANNELS) expect(valid.has(c.shape)).toBe(true)
  })

  test("every channel has a permission string of form hooks:NAME", () => {
    for (const c of CHANNELS) {
      expect(c.permission.startsWith("hooks:")).toBe(true)
    }
  })

  test("CHANNEL_BY_NAME mirrors the array", () => {
    expect(CHANNEL_BY_NAME.size).toBe(CHANNELS.length)
    for (const c of CHANNELS) expect(CHANNEL_BY_NAME.get(c.name)).toBe(c)
  })

  test("sub-agent lifecycle channels are registered with the right shapes", () => {
    const willSpawn = CHANNEL_BY_NAME.get("subagent.willSpawn")
    expect(willSpawn?.shape).toBe("chain") // guardrail veto/rewrite seam
    expect(willSpawn?.permission).toBe("hooks:subagent.willSpawn")
    for (const name of ["subagent.didSpawn", "subagent.didReport", "subagent.didExit"]) {
      const c = CHANNEL_BY_NAME.get(name)
      expect(c?.shape).toBe("broadcast-async")
      expect(c?.permission).toBe(`hooks:${name}`)
    }
    // A `hooks:subagent.*` wildcard grant should cover every subagent channel.
    for (const c of CHANNELS) {
      if (c.name.startsWith("subagent.")) {
        expect(hasPermission(["hooks:subagent.*"], c.permission)).toBe(true)
      }
    }
  })
})

describe("permissionMatches", () => {
  test("exact match", () => {
    expect(permissionMatches("hooks:turn.didEnd", "hooks:turn.didEnd")).toBe(true)
    expect(permissionMatches("hooks:turn.didEnd", "hooks:turn.willStart")).toBe(false)
  })

  test("wildcard suffix", () => {
    expect(permissionMatches("hooks:turn.*", "hooks:turn.didEnd")).toBe(true)
    expect(permissionMatches("hooks:turn.*", "hooks:tool.didEnd")).toBe(false)
    expect(permissionMatches("hooks:*", "hooks:anything.here")).toBe(true)
  })

  test("hasPermission scans grant list", () => {
    const grants = ["hooks:turn.*", "hooks:tool.didInvoke"]
    expect(hasPermission(grants, "hooks:turn.didEnd")).toBe(true)
    expect(hasPermission(grants, "hooks:tool.didInvoke")).toBe(true)
    expect(hasPermission(grants, "hooks:tool.willInvoke")).toBe(false)
  })
})
