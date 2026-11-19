/**
 * Tests for the aux usage frame (`runAsAuxUsage`). A side call (title,
 * summary, memory) must never change `turns` or `contextSize`, on the real
 * usage path and on the estimated path. No test writes to disk.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import { runInSessionScope, type SessionScope } from "../infra/session-scope.ts"

import {
  addAuxUsage,
  addSessionEstimatedUsage,
  addSessionUsage,
  clearSessionTokens,
  currentAuxUsageFrame,
  getAuxUsageTotals,
  getSessionTokens,
  runAsAuxUsage,
  SessionTokenCounter,
} from "./session-tokens.ts"

beforeEach(() => clearSessionTokens())
afterEach(() => clearSessionTokens())

/** A minimal scope: only `sid` and `tokens` are read by session-tokens. */
function fakeScope(sid: string): SessionScope {
  return {
    sid,
    tokens: new SessionTokenCounter(() => false),
    agent: () => {
      throw new Error("not used")
    },
    queryTarget: () => {
      throw new Error("not used")
    },
    queryModelInfo: () => undefined,
    recommendSubagentModels: () => [],
  }
}

function tick(ms = 1): Promise<void> {
  return Bun.sleep(ms)
}

describe("aux usage frame", () => {
  it("real usage in the frame does not change turns or contextSize", () => {
    addSessionUsage({ input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50 })
    const before = getSessionTokens()
    expect(before.turns).toBe(1)
    expect(before.contextSize).toBe(150)

    runAsAuxUsage({ purpose: "title", model: "m-utility" }, () =>
      addSessionUsage({ input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 2 }),
    )

    expect(getSessionTokens()).toEqual(before)
    expect(getAuxUsageTotals()).toEqual({ calls: 1, inputTokens: 7, outputTokens: 3, costUsd: 0 })
  })

  it("estimated usage in the frame does not change turns or contextSize", () => {
    addSessionEstimatedUsage(400)
    const before = getSessionTokens()
    expect(before.turns).toBe(1)
    expect(before.contextSize).toBe(400)
    expect(before.contextSizeEstimated).toBe(true)

    runAsAuxUsage({ purpose: "title" }, () => addSessionEstimatedUsage(12.2))

    expect(getSessionTokens()).toEqual(before)
    expect(getAuxUsageTotals()).toEqual({ calls: 1, inputTokens: 13, outputTokens: 0, costUsd: 0 })
  })

  it("the estimated path gives an entry with estimated: true", () => {
    const c = new SessionTokenCounter(() => false)
    const seen: unknown[] = []
    const orig = c.addAuxUsage.bind(c)
    c.addAuxUsage = (e) => {
      seen.push(e)
      orig(e)
    }
    const scope = fakeScope("s-est")
    Object.assign(scope, { tokens: c })
    runInSessionScope(scope, () =>
      runAsAuxUsage({ purpose: "summary", model: "m1" }, () => addSessionEstimatedUsage(5)),
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      purpose: "summary",
      model: "m1",
      inputTokens: 5,
      outputTokens: 0,
      estimated: true,
    })
  })

  it("an invalid estimate in the frame adds nothing", () => {
    runAsAuxUsage({ purpose: "title" }, () => {
      addSessionEstimatedUsage(0)
      addSessionEstimatedUsage(Number.NaN)
      addSessionUsage(undefined)
    })
    expect(getAuxUsageTotals().calls).toBe(0)
    expect(getSessionTokens().turns).toBe(0)
  })

  it("outside the frame the behavior is the same as before", () => {
    runAsAuxUsage({ purpose: "title" }, () =>
      addSessionUsage({ input_tokens: 1, output_tokens: 1 }),
    )
    addSessionUsage({ input_tokens: 20, output_tokens: 2 })
    addSessionEstimatedUsage(30)
    const t = getSessionTokens()
    expect(t.turns).toBe(2)
    expect(t.contextSize).toBe(30)
    expect(t.input).toBe(20)
    expect(currentAuxUsageFrame()).toBeUndefined()
    expect(getAuxUsageTotals().calls).toBe(1)
  })

  it("the frame continues across await in async work", async () => {
    await runAsAuxUsage({ purpose: "title" }, async () => {
      await tick()
      addSessionUsage({ input_tokens: 4, output_tokens: 1 })
      await tick()
      addSessionEstimatedUsage(6)
    })
    expect(getSessionTokens().turns).toBe(0)
    expect(getAuxUsageTotals()).toEqual({ calls: 2, inputTokens: 10, outputTokens: 1, costUsd: 0 })
  })

  it("the scope counter also gets aux, and its turns do not change", () => {
    const scope = fakeScope("s1")
    runInSessionScope(scope, () => {
      addSessionUsage({ input_tokens: 50, output_tokens: 5 })
      runAsAuxUsage({ purpose: "title" }, () =>
        addSessionUsage({ input_tokens: 9, output_tokens: 1 }),
      )
    })
    expect(scope.tokens.snapshot().turns).toBe(1)
    expect(scope.tokens.snapshot().contextSize).toBe(50)
    expect(scope.tokens.auxTotals()).toEqual({
      calls: 1,
      inputTokens: 9,
      outputTokens: 1,
      costUsd: 0,
    })
    expect(getAuxUsageTotals().calls).toBe(1)
  })

  it("nested frames: the inner meta wins, and the outer meta comes back", () => {
    const seen: (string | undefined)[] = []
    runAsAuxUsage({ purpose: "title", model: "outer" }, () => {
      seen.push(currentAuxUsageFrame()?.model)
      runAsAuxUsage({ purpose: "summary", model: "inner" }, () => {
        seen.push(currentAuxUsageFrame()?.purpose)
        addSessionUsage({ input_tokens: 1, output_tokens: 1 })
      })
      seen.push(currentAuxUsageFrame()?.purpose)
      addSessionUsage({ input_tokens: 2, output_tokens: 2 })
    })
    expect(seen).toEqual(["outer", "summary", "title"])
    expect(currentAuxUsageFrame()).toBeUndefined()
    expect(getSessionTokens().turns).toBe(0)
    expect(getAuxUsageTotals().calls).toBe(2)
  })

  it("a frame does not leak into concurrent work outside it", async () => {
    const aux = runAsAuxUsage({ purpose: "title" }, async () => {
      await tick(5)
      addSessionUsage({ input_tokens: 3, output_tokens: 1 })
      return currentAuxUsageFrame()?.purpose
    })
    const main = (async () => {
      await tick(1)
      addSessionUsage({ input_tokens: 100, output_tokens: 10 })
      return currentAuxUsageFrame()
    })()
    const [auxPurpose, mainFrame] = await Promise.all([aux, main])
    expect(auxPurpose).toBe("title")
    expect(mainFrame).toBeUndefined()
    const t = getSessionTokens()
    expect(t.turns).toBe(1)
    expect(t.contextSize).toBe(100)
    expect(getAuxUsageTotals()).toEqual({ calls: 1, inputTokens: 3, outputTokens: 1, costUsd: 0 })
  })

  it("two concurrent frames keep their own meta", async () => {
    const run = (purpose: string, delay: number) =>
      runAsAuxUsage({ purpose }, async () => {
        await tick(delay)
        const a = currentAuxUsageFrame()?.purpose
        await tick(1)
        return [a, currentAuxUsageFrame()?.purpose]
      })
    const [a, b] = await Promise.all([run("title", 3), run("summary", 1)])
    expect(a).toEqual(["title", "title"])
    expect(b).toEqual(["summary", "summary"])
  })

  it("addAuxUsage adds cost and ignores non-finite values", () => {
    addAuxUsage({
      purpose: "title",
      model: "m",
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.0001,
      at: "t",
    })
    addAuxUsage({
      purpose: "title",
      model: "m",
      inputTokens: Number.NaN,
      outputTokens: 1,
      costUsd: Number.POSITIVE_INFINITY,
      at: "t",
    })
    const a = getAuxUsageTotals()
    expect(a.calls).toBe(2)
    expect(a.inputTokens).toBe(10)
    expect(a.outputTokens).toBe(3)
    expect(a.costUsd).toBeCloseTo(0.0001)
    expect(getSessionTokens().turns).toBe(0)
  })

  it("clearSessionTokens also clears the aux totals", () => {
    addAuxUsage({ purpose: "title", model: "m", inputTokens: 1, outputTokens: 1, at: "t" })
    clearSessionTokens()
    expect(getAuxUsageTotals()).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 })
  })

  it("the getters give copies", () => {
    runAsAuxUsage({ purpose: "title", model: "m" }, () => {
      const f = currentAuxUsageFrame()
      if (f) f.purpose = "changed"
      expect(currentAuxUsageFrame()?.purpose).toBe("title")
    })
    const a = getAuxUsageTotals()
    a.calls = 99
    expect(getAuxUsageTotals().calls).toBe(0)
  })
})
