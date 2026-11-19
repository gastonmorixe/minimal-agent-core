import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { clearModelRegistry, findModel, registerModel } from "../llm/model-registry.ts"
import type { MTokRate } from "../llm/pricing.ts"
import { makeCharRatioEstimator } from "../llm/token-estimate.ts"
import type { AssistantRecord, SessionRecord } from "../session/session-store.ts"

import {
  aggregateAllPeriods,
  aggregateUsage,
  assistantTurnKey,
  collectSessionEvents,
  parseUsagePeriod,
  periodStartMs,
  scanUsageEvents,
  USAGE_PERIODS,
  type UsageEvent,
} from "./usage-stats.ts"

afterEach(() => clearModelRegistry())

const TEST_RATE: MTokRate = {
  inputUSD: 5,
  outputUSD: 25,
  cacheWriteUSD: 6.25,
  cacheReadUSD: 0.5,
  webSearchPerCallUSD: 0.01,
}

function registerTestModel(): void {
  registerModel({
    id: "acme-large-1",
    aliases: ["acme-large-1[1m]"],
    providerId: "acme",
    surfaceId: "custom",
    displayName: "Acme Large 1",
    // biome-ignore lint/suspicious/noExplicitAny: minimal caps stub for the test
    capabilities: {} as any,
    pricing: TEST_RATE,
    estimateTokens: makeCharRatioEstimator(3.5),
  })
}

function meta(model = "acme-large-1", createdAt = "2026-05-30T00:00:00.000Z"): SessionRecord {
  return {
    kind: "meta",
    formatVersion: 1,
    sid: "s",
    createdAt,
    model,
    cwd: "/x",
    systemHash: "h",
    toolsHash: "t",
    agentVersion: "test",
  }
}

function assistant(ts: string, usage?: Record<string, number>, text = "hi"): SessionRecord {
  return {
    kind: "assistant",
    ts,
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    ...(usage ? { usage } : {}),
  }
}

describe("parseUsagePeriod", () => {
  it("maps aliases to canonical ids", () => {
    expect(parseUsagePeriod("today")).toBe("today")
    expect(parseUsagePeriod("24h")).toBe("last-day")
    expect(parseUsagePeriod("month")).toBe("last-month")
    expect(parseUsagePeriod("YTD")).toBe("ytd")
    expect(parseUsagePeriod("1y")).toBe("year")
    expect(parseUsagePeriod("all")).toBe("all")
  })
  it("returns null for unknown / empty", () => {
    expect(parseUsagePeriod("bogus")).toBeNull()
    expect(parseUsagePeriod(undefined)).toBeNull()
    expect(parseUsagePeriod("")).toBeNull()
  })
})

describe("periodStartMs", () => {
  const now = new Date("2026-05-30T12:00:00.000Z").getTime()
  it("all → 0", () => {
    expect(periodStartMs("all", now)).toBe(0)
  })
  it("rolling windows subtract a fixed span", () => {
    expect(periodStartMs("last-day", now)).toBe(now - 86_400_000)
    expect(periodStartMs("last-month", now)).toBe(now - 30 * 86_400_000)
    expect(periodStartMs("year", now)).toBe(now - 365 * 86_400_000)
  })
  it("today snaps to local midnight (<= now, within 24h)", () => {
    const start = periodStartMs("today", now)
    expect(start).toBeLessThanOrEqual(now)
    expect(now - start).toBeLessThan(86_400_000)
  })
  it("ytd snaps to Jan 1 of the current year", () => {
    const start = periodStartMs("ytd", now)
    expect(new Date(start).getFullYear()).toBe(new Date(now).getFullYear())
    expect(new Date(start).getMonth()).toBe(0)
    expect(new Date(start).getDate()).toBe(1)
  })
})

describe("collectSessionEvents", () => {
  it("emits exact real events when usage is saved", () => {
    registerTestModel()
    const recs = [
      meta(),
      assistant("2026-05-30T01:00:00.000Z", {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
      }),
    ]
    const ev = collectSessionEvents(recs)
    expect(ev).toHaveLength(1)
    expect(ev[0].estimated).toBe(false)
    expect(ev[0].tokens).toBe(100 + 50 + 1000 + 200)
    expect(ev[0].providerId).toBe("acme")
    expect(ev[0].modelId).toBe("acme-large-1")
    // Cost = (100*5 + 50*25 + 1000*0.5 + 200*6.25) / 1e6
    expect(ev[0].costUSD).toBeCloseTo((100 * 5 + 50 * 25 + 1000 * 0.5 + 200 * 6.25) / 1e6, 9)
  })

  it("prices web searches and keeps thinking from the saved record", () => {
    registerTestModel()
    const recs: SessionRecord[] = [
      meta(),
      {
        kind: "assistant",
        ts: "2026-05-30T01:00:00.000Z",
        content: [{ type: "text", text: "hi" }],
        stopReason: "end_turn",
        usage: {
          input_tokens: 10,
          output_tokens: 100,
          output_tokens_details: { thinking_tokens: 40 },
          server_tool_use: { web_search_requests: 3 },
        },
      },
    ]
    const ev = collectSessionEvents(recs)
    expect(ev[0].thinking).toBe(40)
    // Thinking is part of output, so it is not priced again. 3 searches at $0.01.
    expect(ev[0].costUSD).toBeCloseTo((10 * 5 + 100 * 25) / 1e6 + 0.03, 9)
  })

  it("estimates a turn lacking usage from text (cost 0)", () => {
    registerTestModel()
    const recs = [meta(), assistant("2026-05-30T01:00:00.000Z", undefined, "x".repeat(70))]
    const ev = collectSessionEvents(recs)
    expect(ev).toHaveLength(1)
    expect(ev[0].estimated).toBe(true)
    expect(ev[0].costUSD).toBe(0)
    expect(ev[0].tokens).toBeGreaterThan(0)
  })

  it("normalizes the [1m] alias to the canonical model id", () => {
    registerTestModel()
    const recs = [
      meta("acme-large-1[1m]"),
      assistant("2026-05-30T01:00:00.000Z", { input_tokens: 5 }),
    ]
    const ev = collectSessionEvents(recs)
    expect(ev[0].modelId).toBe("acme-large-1")
  })

  it("maps an unregistered model to provider 'unknown'", () => {
    const recs = [meta("mystery-model"), assistant("2026-05-30T01:00:00.000Z", { input_tokens: 5 })]
    const ev = collectSessionEvents(recs)
    expect(ev[0].providerId).toBe("unknown")
    expect(ev[0].modelId).toBe("mystery-model")
  })

  it("uses meta.provider to disambiguate when multiple providers register the same model", () => {
    // Register the same model under two providers — last-write-wins globally
    // would be "wafer", but the meta record pins it to "opencode".
    registerModel({
      id: "deepseek-v4-flash",
      providerId: "opencode",
      surfaceId: "custom",
      displayName: "DS v4 Flash (OpenCode)",
      capabilities: {} as any,
      pricing: {
        inputUSD: 0.15,
        outputUSD: 0.6,
        cacheReadUSD: 0.075,
        cacheWriteUSD: 0.15,
        webSearchPerCallUSD: 0,
      },
      estimateTokens: makeCharRatioEstimator(3.5),
    })
    registerModel({
      id: "deepseek-v4-flash",
      providerId: "wafer",
      surfaceId: "custom",
      displayName: "DS v4 Flash (Wafer)",
      capabilities: {} as any,
      pricing: {
        inputUSD: 0.15,
        outputUSD: 0.6,
        cacheReadUSD: 0.075,
        cacheWriteUSD: 0.15,
        webSearchPerCallUSD: 0,
      },
      estimateTokens: makeCharRatioEstimator(3.5),
    })
    // Global (last-write-wins) returns Wafer
    expect(findModel("deepseek-v4-flash")?.providerId).toBe("wafer")

    // But the meta provider record should give us Opencode
    const recs = [
      {
        kind: "meta",
        formatVersion: 1,
        sid: "s",
        createdAt: "2026-06-01T00:00:00.000Z",
        model: "deepseek-v4-flash",
        cwd: "/x",
        systemHash: "h",
        toolsHash: "t",
        agentVersion: "test",
        provider: "opencode",
      } as SessionRecord,
      assistant("2026-06-01T01:00:00.000Z", { input_tokens: 100 }),
    ]
    const ev = collectSessionEvents(recs)
    expect(ev[0].providerId).toBe("opencode")
    expect(ev[0].modelId).toBe("deepseek-v4-flash")
  })

  it("falls back to global lookup when meta.provider is absent (backward compat)", () => {
    registerModel({
      id: "deepseek-v4-flash",
      providerId: "opencode",
      surfaceId: "custom",
      displayName: "DS v4 Flash (OpenCode)",
      capabilities: {} as any,
      pricing: {
        inputUSD: 0.15,
        outputUSD: 0.6,
        cacheReadUSD: 0.075,
        cacheWriteUSD: 0.15,
        webSearchPerCallUSD: 0,
      },
      estimateTokens: makeCharRatioEstimator(3.5),
    })
    registerModel({
      id: "deepseek-v4-flash",
      providerId: "wafer",
      surfaceId: "custom",
      displayName: "DS v4 Flash (Wafer)",
      capabilities: {} as any,
      pricing: {
        inputUSD: 0.15,
        outputUSD: 0.6,
        cacheReadUSD: 0.075,
        cacheWriteUSD: 0.15,
        webSearchPerCallUSD: 0,
      },
      estimateTokens: makeCharRatioEstimator(3.5),
    })
    // No provider in meta → global last-write-wins → Wafer
    const recs = [
      meta("deepseek-v4-flash"),
      assistant("2026-06-01T01:00:00.000Z", { input_tokens: 100 }),
    ]
    const ev = collectSessionEvents(recs)
    expect(ev[0].providerId).toBe("wafer")
  })
})

describe("aggregateUsage", () => {
  const base = (): UsageEvent[] => [
    {
      tsMs: new Date("2026-05-30T10:00:00.000Z").getTime(),
      modelId: "acme-large-1",
      providerId: "acme",
      input: 100,
      output: 50,
      cacheRead: 0,
      cacheCreate: 0,
      thinking: 0,
      tokens: 150,
      estimated: false,
      costUSD: 0.5,
    },
    {
      tsMs: new Date("2026-05-30T11:00:00.000Z").getTime(),
      modelId: "globex-mini",
      providerId: "globex",
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
      thinking: 0,
      tokens: 40,
      estimated: true,
      costUSD: 0,
    },
    {
      tsMs: new Date("2020-01-01T00:00:00.000Z").getTime(), // old, outside short windows
      modelId: "acme-large-1",
      providerId: "acme",
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheCreate: 0,
      thinking: 0,
      tokens: 15,
      estimated: false,
      costUSD: 0.1,
    },
  ]
  const now = new Date("2026-05-30T12:00:00.000Z").getTime()

  it("all-time sums every event", () => {
    const r = aggregateUsage(base(), "all", now)
    expect(r.totals.turns).toBe(3)
    expect(r.totals.tokens).toBe(150 + 40 + 15)
    expect(r.totals.estimatedTurns).toBe(1)
    expect(r.estimated).toBe(true)
  })

  it("last-day excludes the 2020 event", () => {
    const r = aggregateUsage(base(), "last-day", now)
    expect(r.totals.turns).toBe(2)
    expect(r.totals.tokens).toBe(150 + 40)
  })

  it("breaks down by provider and model, sorted by tokens desc", () => {
    const r = aggregateUsage(base(), "all", now)
    expect(r.byProvider.map((x) => x.key)).toEqual(["acme", "globex"])
    expect(r.byProvider[0].totals.tokens).toBe(150 + 15)
    expect(r.byModel[0].key).toBe("acme-large-1")
    expect(r.byModel[0].totals.tokens).toBe(165)
  })

  it("empty events → zeroed report, not estimated", () => {
    const r = aggregateUsage([], "all", now)
    expect(r.totals.turns).toBe(0)
    expect(r.totals.tokens).toBe(0)
    expect(r.estimated).toBe(false)
    expect(r.byProvider).toEqual([])
  })
})

describe("aggregateAllPeriods", () => {
  it("returns one report per period", () => {
    const r = aggregateAllPeriods([], Date.now())
    for (const { id } of USAGE_PERIODS) {
      expect(r[id].period).toBe(id)
    }
  })
})

describe("scanUsageEvents", () => {
  it("reads jsonl files, skips index.jsonl + non-jsonl, tolerates garbage", () => {
    registerTestModel()
    const dir = mkdtempSync(join(tmpdir(), "ma-usage-scan-"))
    const session = [
      JSON.stringify(meta()),
      JSON.stringify(
        assistant("2026-05-30T01:00:00.000Z", { input_tokens: 100, output_tokens: 50 }),
      ),
    ].join("\n")
    writeFileSync(join(dir, "aaaa.jsonl"), `${session}\n`)
    writeFileSync(join(dir, "index.jsonl"), `${JSON.stringify({ sid: "aaaa" })}\n`)
    writeFileSync(join(dir, "notes.txt"), "ignored")
    writeFileSync(join(dir, "broken.jsonl"), "{not json\n")

    const ev = scanUsageEvents(dir)
    expect(ev).toHaveLength(1)
    expect(ev[0].tokens).toBe(150)
  })

  it("returns [] for a missing directory", () => {
    expect(scanUsageEvents("/nope-not-a-real-dir-xyz")).toEqual([])
  })
})

describe("scanUsageEvents de-duplication", () => {
  const t1 = assistant("2026-05-30T01:00:00.000Z", { input_tokens: 100, output_tokens: 50 })
  const t2 = assistant("2026-05-30T02:00:00.000Z", { input_tokens: 200, output_tokens: 20 })
  const t3 = assistant("2026-05-30T03:00:00.000Z", { input_tokens: 300, output_tokens: 30 })
  const user = (text: string): SessionRecord => ({
    kind: "user",
    ts: "2026-05-30T00:30:00.000Z",
    content: text,
  })

  function writeSession(dir: string, name: string, lines: SessionRecord[]): void {
    writeFileSync(join(dir, `${name}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`)
  }

  function forkMeta(
    sid: string,
    parentSid: string,
    createdAt: string,
    model = "acme-large-1",
  ): SessionRecord {
    return { ...meta(model, createdAt), sid, parentSid, forkedAt: createdAt } as SessionRecord
  }

  it("counts a turn once when a fork copied it", () => {
    registerTestModel()
    const dir = mkdtempSync(join(tmpdir(), "ma-usage-fork-"))
    writeSession(dir, "parent", [
      meta("acme-large-1", "2026-05-30T00:00:00.000Z"),
      user("a"),
      t1,
      t2,
    ])
    // The fork repeats t1 and t2, then adds its own t3.
    writeSession(dir, "child", [
      forkMeta("child", "parent", "2026-05-30T02:30:00.000Z"),
      user("a"),
      t1,
      t2,
      t3,
    ])

    const ev = scanUsageEvents(dir)
    expect(ev).toHaveLength(3)
    expect(ev.reduce((n, e) => n + e.tokens, 0)).toBe(150 + 220 + 330)
  })

  it("counts a turn once across a chain of forks and a history-edit backup", () => {
    registerTestModel()
    const dir = mkdtempSync(join(tmpdir(), "ma-usage-chain-"))
    writeSession(dir, "a", [meta("acme-large-1", "2026-05-30T00:00:00.000Z"), t1])
    writeSession(dir, "b", [forkMeta("b", "a", "2026-05-30T01:30:00.000Z"), t1, t2])
    writeSession(dir, "c", [forkMeta("c", "b", "2026-05-30T02:30:00.000Z"), t1, t2, t3])
    writeSession(dir, "c-backup-01", [
      {
        ...meta("acme-large-1", "2026-05-30T04:00:00.000Z"),
        sid: "c-backup-01",
        backup: true,
        backupOfSid: "c",
      } as SessionRecord,
      t1,
      t2,
      t3,
    ])

    const ev = scanUsageEvents(dir)
    expect(ev).toHaveLength(3)
  })

  it("credits a copied turn to the session that ran it, whatever the file name order", () => {
    registerTestModel()
    registerModel({
      id: "globex-mini",
      providerId: "globex",
      surfaceId: "custom",
      displayName: "Globex Mini",
      // biome-ignore lint/suspicious/noExplicitAny: minimal caps stub for the test
      capabilities: {} as any,
      pricing: TEST_RATE,
      estimateTokens: makeCharRatioEstimator(3.5),
    })
    const dir = mkdtempSync(join(tmpdir(), "ma-usage-order-"))
    // "aaa" sorts first by name, but it is the fork; it resumed on another model.
    writeSession(dir, "zzz", [meta("acme-large-1", "2026-05-30T00:00:00.000Z"), t1])
    writeSession(dir, "aaa", [
      forkMeta("aaa", "zzz", "2026-05-30T01:30:00.000Z", "globex-mini"),
      t1,
      t2,
    ])

    const ev = scanUsageEvents(dir)
    expect(ev).toHaveLength(2)
    const byTs = new Map(ev.map((e) => [e.tsMs, e.modelId]))
    expect(byTs.get(Date.parse("2026-05-30T01:00:00.000Z"))).toBe("acme-large-1")
    expect(byTs.get(Date.parse("2026-05-30T02:00:00.000Z"))).toBe("globex-mini")
  })

  it("keeps two different sessions that have equal usage at different times", () => {
    registerTestModel()
    const dir = mkdtempSync(join(tmpdir(), "ma-usage-distinct-"))
    const same = { input_tokens: 100, output_tokens: 50 }
    writeSession(dir, "s1", [meta(), assistant("2026-05-30T01:00:00.000Z", same)])
    writeSession(dir, "s2", [meta(), assistant("2026-05-30T01:00:00.001Z", same)])
    expect(scanUsageEvents(dir)).toHaveLength(2)
  })

  it("assistantTurnKey separates turns by provider message id and by content when no usage", () => {
    const a = t1 as AssistantRecord
    expect(assistantTurnKey(a)).toBe(assistantTurnKey(JSON.parse(JSON.stringify(a))))
    expect(assistantTurnKey({ ...a, providerMessageId: "msg_1" })).not.toBe(
      assistantTurnKey({ ...a, providerMessageId: "msg_2" }),
    )
    const e1 = assistant("2026-05-30T01:00:00.000Z", undefined, "one") as AssistantRecord
    const e2 = assistant("2026-05-30T01:00:00.000Z", undefined, "two") as AssistantRecord
    expect(assistantTurnKey(e1)).not.toBe(assistantTurnKey(e2))
  })
})
