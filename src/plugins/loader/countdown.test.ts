import { describe, expect, it } from "bun:test"

import { plainCountdown } from "./countdown.ts"

describe("plainCountdown (default ctx.countdown)", () => {
  it("resolves elapsed after the wait", async () => {
    const start = performance.now()
    expect(await plainCountdown({ id: "t", label: "wait", ms: 20 })).toBe("elapsed")
    expect(performance.now() - start).toBeGreaterThanOrEqual(15)
  })

  it("resolves elapsed at once for ms <= 0 and a non-finite ms", async () => {
    expect(await plainCountdown({ id: "t", label: "wait", ms: 0 })).toBe("elapsed")
    expect(await plainCountdown({ id: "t", label: "wait", ms: -5 })).toBe("elapsed")
    expect(await plainCountdown({ id: "t", label: "wait", ms: Number.NaN })).toBe("elapsed")
  })

  it("resolves aborted when the signal aborts during the wait", async () => {
    const ac = new AbortController()
    const start = performance.now()
    const p = plainCountdown({ id: "t", label: "wait", ms: 60_000, signal: ac.signal })
    setTimeout(() => ac.abort(), 5)
    expect(await p).toBe("aborted")
    expect(performance.now() - start).toBeLessThan(5_000)
  })

  it("resolves aborted at once for a signal that aborted before the call", async () => {
    const ac = new AbortController()
    ac.abort()
    expect(await plainCountdown({ id: "t", label: "wait", ms: 60_000, signal: ac.signal })).toBe(
      "aborted",
    )
    // A pre-aborted signal wins over ms <= 0.
    expect(await plainCountdown({ id: "t", label: "wait", ms: 0, signal: ac.signal })).toBe(
      "aborted",
    )
  })

  it("never resolves skipped (no UI)", async () => {
    const r = await plainCountdown({ id: "t", label: "wait", ms: 1 })
    expect(r).not.toBe("skipped")
  })
})
