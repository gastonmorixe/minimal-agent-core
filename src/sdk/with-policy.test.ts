import { describe, expect, test } from "bun:test"

import { allowDecision, denyDecision } from "./lifecycle.ts"
import { runWithPolicy } from "./with-policy.ts"

describe("runWithPolicy", () => {
  test("deny skips terminal", async () => {
    let ran = false
    const guarded = runWithPolicy(
      async (n: number) => denyDecision("nope", n),
      async (n) => {
        ran = true
        return n * 2
      },
    )
    const r = await guarded(3)
    expect(ran).toBe(false)
    expect(r.output).toBeUndefined()
    expect(r.decision.action).toBe("deny")
  })

  test("allow runs terminal with rewritten payload", async () => {
    const guarded = runWithPolicy(
      async (n: number) => allowDecision(n + 1),
      async (n) => n * 10,
    )
    const r = await guarded(3)
    expect(r.output).toBe(40)
    expect(r.decision.action).toBe("allow")
  })

  test("after runs only on allow", async () => {
    const seen: number[] = []
    const guarded = runWithPolicy(
      async (n: number) => allowDecision(n),
      async (n) => n,
      async (n, out) => {
        seen.push(n, out)
      },
    )
    await guarded(1)
    expect(seen).toEqual([1, 1])
  })
})
