import { describe, expect, it } from "bun:test"

import { KNOWN_EFFORT, resolveEffort, validateEffortForModel } from "./effort-resolution.ts"

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

describe("validateEffortForModel", () => {
  it("passes when effort is undefined (model default applies)", () => {
    expect(validateEffortForModel(undefined, ["low", "medium", "high"])).toEqual({ ok: true })
    expect(validateEffortForModel(undefined, [])).toEqual({ ok: true })
  })

  it("passes when the effort is in the model's declared levels", () => {
    expect(validateEffortForModel("high", ["high", "max"])).toEqual({ ok: true })
    expect(validateEffortForModel("low", ["low", "medium", "high"])).toEqual({ ok: true })
    expect(validateEffortForModel("max", ["low", "medium", "high", "xhigh", "max"])).toEqual({
      ok: true,
    })
  })

  it("fails with a clear message when the effort level is not supported", () => {
    const result = validateEffortForModel("low", ["high", "max"])
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('"low"')
    expect(result.reason).toContain("not supported")
    expect(result.reason).toContain("high, max")
  })

  it("fails when the model has no effort levels at all (cheap/fast tier)", () => {
    const result = validateEffortForModel("high", [])
    expect(result.ok).toBe(false)
    expect(result.reason).toContain("does not support reasoning effort")
    expect(result.reason).toContain('"high"')
  })

  it("passes through unknown effort values to the model-level check", () => {
    // The resolver passes through unknown values verbatim; validation
    // checks them against the model's declared levels, not a global list.
    const result = validateEffortForModel("ultra", ["low", "medium", "high"])
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('"ultra"')
    expect(result.reason).toContain("low, medium, high")
  })
})
