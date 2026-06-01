import { describe, expect, it } from "bun:test"

import { DEFAULT_POLICY, evaluateSpawnGuard, type GuardInput, type GuardPolicy } from "./guard.ts"

function gi(o: Partial<GuardInput> = {}): GuardInput {
  return { childDepth: 1, type: "worker", activeCount: 0, totalCount: 0, ...o }
}

describe("evaluateSpawnGuard", () => {
  it("allows a lead-spawned worker under default caps", () => {
    expect(evaluateSpawnGuard(gi())).toEqual({ allowed: true })
  })

  it("bans nesting (a worker spawning a worker = childDepth 2 > maxDepth 1)", () => {
    const d = evaluateSpawnGuard(gi({ childDepth: 2 }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/nesting/i)
  })

  it("enforces the concurrency cap", () => {
    const d = evaluateSpawnGuard(gi({ activeCount: DEFAULT_POLICY.maxConcurrent }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/concurrency/i)
  })

  it("enforces the total-spawn cap", () => {
    const d = evaluateSpawnGuard(gi({ totalCount: DEFAULT_POLICY.maxTotal }))
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/total spawn/i)
  })

  it("enforces a type allowlist when present", () => {
    const policy: GuardPolicy = { ...DEFAULT_POLICY, allowedTypes: ["reviewer", "explorer"] }
    expect(evaluateSpawnGuard(gi({ type: "explorer" }), policy)).toEqual({ allowed: true })
    const d = evaluateSpawnGuard(gi({ type: "worker" }), policy)
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/allowlist/i)
  })

  it("reports nesting before runtime caps (most structural first)", () => {
    // Over every cap at once → nesting wins the message.
    const d = evaluateSpawnGuard(
      gi({ childDepth: 5, activeCount: 999, totalCount: 999, type: "nope" }),
      { maxDepth: 1, maxConcurrent: 1, maxTotal: 1, allowedTypes: ["x"] },
    )
    expect(d.allowed).toBe(false)
    if (!d.allowed) expect(d.reason).toMatch(/nesting/i)
  })

  it("allows raising maxDepth for deliberate deeper trees", () => {
    expect(evaluateSpawnGuard(gi({ childDepth: 2 }), { ...DEFAULT_POLICY, maxDepth: 2 })).toEqual({
      allowed: true,
    })
  })
})
