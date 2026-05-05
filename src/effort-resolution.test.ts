import { describe, it, expect } from "bun:test"
import { resolveEffort, KNOWN_EFFORT } from "./effort-resolution.ts"

describe("resolveEffort", () => {
  it("returns undefined when nothing is set", () => {
    expect(resolveEffort({})).toEqual({
      effort: undefined,
      source: undefined,
    })
  })

  it("passes through each known level from CLI", () => {
    for (const lvl of KNOWN_EFFORT) {
      expect(resolveEffort({ cli: lvl })).toEqual({
        effort: lvl,
        source: "cli",
      })
    }
  })

  it("CLI beats env beats config", () => {
    expect(resolveEffort({ cli: "max", env: "high", config: "low" })).toEqual({
      effort: "max",
      source: "cli",
    })

    expect(resolveEffort({ env: "high", config: "low" })).toEqual({
      effort: "high",
      source: "env",
    })

    expect(resolveEffort({ config: "low" })).toEqual({
      effort: "low",
      source: "config",
    })
  })

  it("env-only resolution returns source=env", () => {
    expect(resolveEffort({ env: "medium" })).toEqual({
      effort: "medium",
      source: "env",
    })
  })

  it("passes through unknown values verbatim (no client-side validation)", () => {
    // The server is the source of truth; we do not gate on a hard-coded list.
    expect(resolveEffort({ cli: "ludicrous" })).toEqual({
      effort: "ludicrous",
      source: "cli",
    })
    expect(resolveEffort({ env: "hgih" })).toEqual({
      effort: "hgih",
      source: "env",
    })
    expect(resolveEffort({ config: "ultra" })).toEqual({
      effort: "ultra",
      source: "config",
    })
  })

  it("treats empty strings as unset", () => {
    expect(resolveEffort({ cli: "", env: "", config: "high" })).toEqual({
      effort: "high",
      source: "config",
    })
    expect(resolveEffort({ cli: "", env: "high" })).toEqual({
      effort: "high",
      source: "env",
    })
  })
})
