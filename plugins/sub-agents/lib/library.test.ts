import { describe, expect, it } from "bun:test"

import { LIBRARY, libraryNames, resolveDefinition } from "./library.ts"

describe("library specialists", () => {
  it("ships the expected named specialists, resolvable by name", () => {
    for (const name of ["explorer", "planner", "worker", "reviewer", "integrator", "log-miner"]) {
      expect(resolveDefinition(name)?.name ?? "MISSING").toBe(name)
    }
    expect(resolveDefinition("ghost")).toBeUndefined()
    expect(libraryNames()).toContain("log-miner")
  })

  it("is MODEL-AGNOSTIC: no specialist hardcodes a model or effort", () => {
    for (const def of LIBRARY) {
      expect(def.model).toBeUndefined()
      expect(def.effort).toBeUndefined()
      // every specialist carries an abstract role instead
      expect(["scout", "balanced", "deep"]).toContain(def.role ?? "")
    }
  })

  it("explorer is a scout; reviewer + log-miner are deep", () => {
    expect(resolveDefinition("explorer")?.role).toBe("scout")
    expect(resolveDefinition("reviewer")?.role).toBe("deep")
    expect(resolveDefinition("log-miner")?.role).toBe("deep")
  })

  it("explorer + log-miner prompts carry output-hygiene + anti-prompt-injection guidance", () => {
    for (const name of ["explorer", "log-miner"]) {
      const p = resolveDefinition(name)?.systemPrompt ?? ""
      expect(p.toLowerCase()).toContain("never")
      // treat file/log content as DATA, not instructions
      expect(p).toMatch(/data|instructions addressed to you/i)
    }
  })

  it("read-only specialists run in ask mode (Edit/Write denied at dispatch, not prompt-only)", () => {
    for (const name of ["explorer", "planner", "reviewer", "log-miner"]) {
      expect(resolveDefinition(name)?.mode).toBe("ask")
    }
  })

  it("implementer specialists are writable (no ask mode → defaults to none in the service)", () => {
    for (const name of ["worker", "integrator"]) {
      expect(resolveDefinition(name)?.mode).toBeUndefined()
    }
  })
})
