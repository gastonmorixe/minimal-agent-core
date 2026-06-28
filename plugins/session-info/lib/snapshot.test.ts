import { describe, expect, it } from "bun:test"

import { formatSessionInfo, humanizeDuration, type SessionInfoSnapshot } from "./snapshot.ts"

function base(over: Partial<SessionInfoSnapshot> = {}): SessionInfoSnapshot {
  return {
    sessionId: "abc123",
    pid: 4242,
    hostname: "box.local",
    agentVersion: "0.1.0",
    modelId: "claude-opus-4-8[1m]",
    modelLabel: "Opus 4.8",
    providerId: "anthropic",
    effort: "max",
    fast: false,
    reasoning: ["adaptive"],
    contextSize: 50_000,
    contextWindow: 200_000,
    turns: 12,
    usage: { input: 100_000, output: 20_000, cacheRead: 800_000, cacheCreate: 60_000 },
    estCostUSD: 1.2345,
    quota: [
      { label: "5h", utilizationPct: 37, resetInMs: 3 * 3600_000 },
      { label: "7d", utilizationPct: 4, resetInMs: undefined },
    ],
    cwd: "/work/here",
    startedAtMs: 1_000_000,
    nowMs: 1_000_000 + 2 * 3600_000 + 13 * 60_000,
    ...over,
  }
}

describe("humanizeDuration", () => {
  it("returns 0s for non-positive / non-finite", () => {
    expect(humanizeDuration(0)).toBe("0s")
    expect(humanizeDuration(-5)).toBe("0s")
    expect(humanizeDuration(Number.NaN)).toBe("0s")
  })
  it("formats seconds, minutes+seconds, hours+minutes", () => {
    expect(humanizeDuration(12_000)).toBe("12s")
    expect(humanizeDuration(45 * 60_000 + 6_000)).toBe("45m 6s")
    expect(humanizeDuration(2 * 3600_000 + 13 * 60_000)).toBe("2h 13m")
  })
  it("caps at two units (days+hours, drops minutes/seconds)", () => {
    expect(humanizeDuration(86400_000 + 3 * 3600_000 + 9 * 60_000)).toBe("1d 3h")
  })
})

describe("formatSessionInfo", () => {
  it("renders the full report with context %, headroom, quota, cost, uptime", () => {
    const out = formatSessionInfo(base())
    expect(out).toContain("Session: abc123 · pid 4242 · box.local · agent v0.1.0")
    expect(out).toContain(
      "Model: Opus 4.8 (claude-opus-4-8[1m]) · anthropic · effort max · reasoning adaptive",
    )
    // 50k / 200k = 25% full, 150k free
    expect(out).toContain("Context: 50,000 / 200,000 tokens (25% full · 150,000 free) · 12 turns")
    expect(out).toContain("Quota: 5h 37% (resets in 3h) · 7d 4%")
    expect(out).toContain(
      "Usage so far: in 100,000, out 20,000, cache-read 800,000, cache-write 60,000 · ~$1.23",
    )
    expect(out).toContain("Working dir: /work/here")
    expect(out).toContain("Uptime: 2h 13m (started ")
  })

  it("includes fast-mode in the model line when on", () => {
    expect(formatSessionInfo(base({ fast: true }))).toContain("· fast ·")
  })

  it("renders a Name line right after Session when agentName is set", () => {
    const out = formatSessionInfo(base({ agentName: "Laura" }))
    expect(out).toContain("\nName: Laura\n")
    expect(out.indexOf("Name: Laura")).toBeGreaterThan(out.indexOf("Session:"))
    expect(out.indexOf("Name: Laura")).toBeLessThan(out.indexOf("Model:"))
  })

  it("omits the Name line when agentName is unset (naming off)", () => {
    expect(formatSessionInfo(base())).not.toContain("Name:")
  })

  it("degrades to a window-less context line when contextWindow is unknown", () => {
    const out = formatSessionInfo(base({ contextWindow: undefined }))
    expect(out).toContain("Context: 50,000 tokens in context · 12 turns")
    expect(out).not.toContain("% full")
  })

  it("omits the Quota line when there are no windows", () => {
    const out = formatSessionInfo(base({ quota: [] }))
    expect(out).not.toContain("Quota:")
  })

  it("omits the cost suffix when estCostUSD is undefined", () => {
    const out = formatSessionInfo(base({ estCostUSD: undefined }))
    expect(out).toContain("cache-write 60,000")
    expect(out).not.toContain("~$")
  })

  it("omits the Uptime line when startedAtMs is undefined", () => {
    const out = formatSessionInfo(base({ startedAtMs: undefined }))
    expect(out).not.toContain("Uptime:")
  })

  it("drops the effort/reasoning tail cleanly when unset", () => {
    const out = formatSessionInfo(base({ effort: undefined, reasoning: [], fast: false }))
    expect(out).toContain("Model: Opus 4.8 (claude-opus-4-8[1m]) · anthropic\n")
  })
})
