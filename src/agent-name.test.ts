/**
 * Tests for the per-session agent-name resolver and its baked-in corpus.
 *
 * These pin three contracts:
 *   - the wordlist is non-empty, unique, and pronounceable (it feeds logs
 *     and the Speak tool);
 *   - {@link autoName} is deterministic in the session id (resume-stable)
 *     and spreads across the corpus (fleet-distinct);
 *   - {@link resolveAgentName} honors the env-over-config priority, the
 *     `"auto"` sentinel, the OFF sentinels, and is OFF by default.
 */

import { describe, expect, test } from "bun:test"

import { AGENT_NAMES, autoName, hashToIndex, resolveAgentName } from "./agent-name.ts"

const SID = "0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9"

describe("AGENT_NAMES corpus", () => {
  test("is a non-trivial, frozen list", () => {
    expect(AGENT_NAMES.length).toBeGreaterThanOrEqual(150)
    expect(Object.isFrozen(AGENT_NAMES)).toBe(true)
  })

  test("has no duplicates", () => {
    expect(new Set(AGENT_NAMES).size).toBe(AGENT_NAMES.length)
  })

  test("every entry is a plain alphabetic token (safe in logs / TTS / tag attrs)", () => {
    for (const n of AGENT_NAMES) {
      expect(n).toMatch(/^[A-Za-z]+$/)
    }
  })
})

describe("hashToIndex", () => {
  test("is in range [0, mod)", () => {
    for (const seed of ["", "a", SID, "another-seed", crypto.randomUUID()]) {
      const i = hashToIndex(seed, AGENT_NAMES.length)
      expect(i).toBeGreaterThanOrEqual(0)
      expect(i).toBeLessThan(AGENT_NAMES.length)
    }
  })

  test("guards a non-positive modulus", () => {
    expect(hashToIndex(SID, 0)).toBe(0)
    expect(hashToIndex(SID, -5)).toBe(0)
  })

  test("is deterministic for a given seed", () => {
    expect(hashToIndex(SID, 1000)).toBe(hashToIndex(SID, 1000))
  })
})

describe("autoName", () => {
  test("is deterministic in the session id (resume-stable)", () => {
    expect(autoName(SID)).toBe(autoName(SID))
    expect(AGENT_NAMES).toContain(autoName(SID))
  })

  test("different session ids generally map to different names", () => {
    // Not a guarantee (collisions exist), but across many random ids the
    // spread should cover a large fraction of the corpus.
    const names = new Set<string>()
    for (let i = 0; i < 2000; i++) names.add(autoName(crypto.randomUUID()))
    // With 200 names and 2000 draws, near-all buckets should be hit.
    expect(names.size).toBeGreaterThan(AGENT_NAMES.length * 0.8)
  })
})

describe("resolveAgentName", () => {
  test("is OFF by default (no env, no config)", () => {
    expect(resolveAgentName({ sessionId: SID })).toBeUndefined()
  })

  test("env beats config", () => {
    expect(resolveAgentName({ sessionId: SID, envName: "Laura", configName: "Mike" })).toBe("Laura")
  })

  test("falls back to config when env is absent", () => {
    expect(resolveAgentName({ sessionId: SID, configName: "Mike" })).toBe("Mike")
  })

  test("an empty/whitespace source falls through rather than disabling", () => {
    expect(resolveAgentName({ sessionId: SID, envName: "   ", configName: "Mike" })).toBe("Mike")
    expect(resolveAgentName({ sessionId: SID, envName: "", configName: "Mike" })).toBe("Mike")
  })

  test('"auto" derives the deterministic per-session name', () => {
    expect(resolveAgentName({ sessionId: SID, configName: "auto" })).toBe(autoName(SID))
    // case-insensitive
    expect(resolveAgentName({ sessionId: SID, envName: "AUTO" })).toBe(autoName(SID))
  })

  test("OFF sentinels disable, and a higher-priority source can veto a lower one", () => {
    for (const off of ["off", "none", "false", "no", "disabled", "OFF", "None"]) {
      expect(resolveAgentName({ sessionId: SID, envName: off, configName: "Mike" })).toBeUndefined()
    }
  })

  test("a literal name is passed through, trimmed", () => {
    expect(resolveAgentName({ sessionId: SID, envName: "  Camila  " })).toBe("Camila")
  })

  test("control characters are stripped and inner whitespace collapsed", () => {
    expect(resolveAgentName({ sessionId: SID, envName: "Jo\u0007hn   Doe" })).toBe("Jo hn Doe")
  })

  test("an over-long literal is capped", () => {
    const long = "X".repeat(200)
    const out = resolveAgentName({ sessionId: SID, envName: long })
    expect(out).toBeDefined()
    expect(out!.length).toBeLessThanOrEqual(48)
  })
})
