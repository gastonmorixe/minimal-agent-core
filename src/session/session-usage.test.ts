import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, describe, expect, it } from "bun:test"

import { defaultCapabilities } from "../llm/capabilities.ts"
import { clearModelRegistry, registerModel } from "../llm/model-registry.ts"
import { makeCharRatioEstimator } from "../llm/token-estimate.ts"

import { parseLines, type SessionRecord, SessionStore } from "./session-store.ts"
import { billedUsageOf, computeSessionUsage, ZERO_SESSION_USAGE } from "./session-usage.ts"

/** Register `id` with a test estimator (the provider gives it, never core). */
function registerEstimated(id: string, charsPerToken: number, providerId = "su-prov"): void {
  registerModel({
    id,
    providerId,
    surfaceId: "custom",
    displayName: id,
    capabilities: defaultCapabilities(),
    pricing: {
      inputUSD: 0,
      outputUSD: 0,
      cacheWriteUSD: 0,
      cacheReadUSD: 0,
      webSearchPerCallUSD: 0,
    },
    estimateTokens: makeCharRatioEstimator(charsPerToken),
  })
}

afterEach(() => clearModelRegistry())

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "ma-session-usage-"))
}

function meta(model = "test-model-large"): SessionRecord {
  return {
    kind: "meta",
    formatVersion: 1,
    sid: "s1",
    createdAt: "2026-05-30T00:00:00.000Z",
    model,
    cwd: "/x",
    systemHash: "h",
    toolsHash: "t",
    agentVersion: "0.1.0",
  }
}

function user(text: string): SessionRecord {
  return { kind: "user", ts: "2026-05-30T00:00:01.000Z", content: text, id: "u1" }
}

function assistant(
  text: string,
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  },
): SessionRecord {
  return {
    kind: "assistant",
    ts: "2026-05-30T00:00:02.000Z",
    content: [{ type: "text", text }],
    stopReason: "end_turn",
    ...(usage ? { usage } : {}),
  }
}

const ZERO_COUNTERS = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  cacheCreate1h: 0,
  thinking: 0,
  webSearchRequests: 0,
}

describe("billedUsageOf", () => {
  it("normalizes missing fields to zero", () => {
    expect(billedUsageOf(undefined)).toEqual({ ...ZERO_COUNTERS })
    expect(billedUsageOf({})).toEqual({ ...ZERO_COUNTERS })
  })

  it("reads thinking, the 1h cache split, and web searches", () => {
    expect(
      billedUsageOf({
        output_tokens: 753,
        cache_creation_input_tokens: 40,
        cache_creation: { ephemeral_5m_input_tokens: 30, ephemeral_1h_input_tokens: 10 },
        output_tokens_details: { thinking_tokens: 315 },
        server_tool_use: { web_search_requests: 2 },
      }),
    ).toEqual({
      ...ZERO_COUNTERS,
      output: 753,
      cacheCreate: 40,
      cacheCreate1h: 10,
      thinking: 315,
      webSearchRequests: 2,
    })
  })

  it("reads all four wire fields", () => {
    expect(
      billedUsageOf({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
      }),
    ).toEqual({ ...ZERO_COUNTERS, input: 1, output: 2, cacheRead: 3, cacheCreate: 4 })
  })
})

describe("computeSessionUsage", () => {
  it("returns zero usage for a session with no assistant turns", () => {
    expect(computeSessionUsage([meta(), user("hi")])).toEqual(ZERO_SESSION_USAGE)
    expect(computeSessionUsage([])).toEqual(ZERO_SESSION_USAGE)
  })

  it("sums billed usage (real) when every assistant turn carries usage", () => {
    const records = [
      meta(),
      user("hi"),
      assistant("a", {
        input_tokens: 10,
        output_tokens: 20,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 5,
      }),
      assistant("b", { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3 }),
    ]
    const u = computeSessionUsage(records)
    expect(u.estimated).toBe(false)
    expect(u.input).toBe(11)
    expect(u.output).toBe(22)
    expect(u.cacheRead).toBe(33)
    expect(u.cacheCreate).toBe(5)
    expect(u.tokens).toBe(11 + 22 + 33 + 5)
    expect(u.turns).toBe(2)
    expect(u.realTurns).toBe(2)
  })

  it("falls back to estimation when ANY assistant turn lacks usage (mixed path keeps billed counters)", () => {
    registerEstimated("su-est", 3.5)
    const records = [
      meta("su-est"),
      user("hello there"),
      assistant("answer with usage", { input_tokens: 100, output_tokens: 50 }),
      assistant("answer WITHOUT usage"), // no usage → that turn is estimated, billed counters kept
    ]
    const u = computeSessionUsage(records)
    expect(u.estimated).toBe(true)
    // Mixed path keeps billed counters for the real turn.
    expect(u.input).toBe(100)
    expect(u.output).toBe(50)
    // Headline includes billed sum + estimate for the missing turn.
    expect(u.tokens).toBeGreaterThan(150)
    expect(u.turns).toBe(2)
    expect(u.realTurns).toBe(1)
  })

  it("mixed path actually estimates the missing turn's transcript text", () => {
    registerEstimated("su-est", 3.5)
    const withoutText: SessionRecord[] = [
      meta("su-est"),
      user("short"),
      assistant("real", { input_tokens: 10, output_tokens: 10 }),
      assistant("", undefined), // missing usage + no text → estimate ~0, headline ≈ billed sum
    ]
    const withText: SessionRecord[] = [
      meta("su-est"),
      user("short"),
      assistant("real", { input_tokens: 10, output_tokens: 10 }),
      assistant("this is a much longer answer without usage that should estimate to more tokens"),
    ]
    const a = computeSessionUsage(withoutText)
    const b = computeSessionUsage(withText)
    expect(b.tokens).toBeGreaterThan(a.tokens)
  })

  it("estimation is deterministic and model-ratio sensitive", () => {
    registerEstimated("su-r2", 2)
    registerEstimated("su-r7", 7)
    const text = "x".repeat(70)
    const recs = (model: string): SessionRecord[] => [
      meta(model),
      user(text),
      assistant("done"), // no usage → estimated path
    ]
    const a = computeSessionUsage(recs("su-r2"))
    expect(computeSessionUsage(recs("su-r2")).tokens).toBe(a.tokens)
    expect(a.tokens).toBeGreaterThan(computeSessionUsage(recs("su-r7")).tokens)
  })

  it("a model with no estimator marks the count unknown (billed part only)", () => {
    const records: SessionRecord[] = [
      meta("unknown-model-xyz"),
      user("x".repeat(70)),
      assistant("real", { input_tokens: 5, output_tokens: 5 }),
      assistant("done"), // no usage, no estimator: not known
    ]
    const u = computeSessionUsage(records)
    expect(u.estimated).toBe(true)
    expect(u.tokens).toBe(10)
    expect(u.tokensUnknown).toBe(true)
  })

  it("no estimator and no billed tokens: tokens 0 with tokensUnknown, not a silent 0", () => {
    const records: SessionRecord[] = [meta("unknown-model-xyz"), user("hello"), assistant("a")]
    const u = computeSessionUsage(records)
    expect(u.tokens).toBe(0)
    expect(u.estimated).toBe(true)
    expect(u.tokensUnknown).toBe(true)
  })

  it("an estimator gives a known count (no tokensUnknown)", () => {
    registerEstimated("su-known", 4)
    const u = computeSessionUsage([meta("su-known"), user("hello"), assistant("a")])
    expect(u.tokens).toBeGreaterThan(0)
    expect(u.tokensUnknown).toBeUndefined()
  })

  it("treats an all-zero usage payload as missing (estimates)", () => {
    const records = [meta(), user("hi"), assistant("a", { input_tokens: 0, output_tokens: 0 })]
    const u = computeSessionUsage(records)
    expect(u.estimated).toBe(true)
    expect(u.realTurns).toBe(0)
  })

  it("respects an explicit modelId override for estimation", () => {
    registerEstimated("su-override", 4)
    const text = "z".repeat(40)
    const records: SessionRecord[] = [meta("meta-model"), user(text), assistant("x")]
    // meta-model has no estimator; the override has one.
    expect(computeSessionUsage(records).tokens).toBe(0)
    expect(computeSessionUsage(records).tokensUnknown).toBe(true)
    const u = computeSessionUsage(records, { modelId: "su-override" })
    expect(u.tokensUnknown).toBeUndefined()
    expect(u.estimated).toBe(true)
    expect(u.tokens).toBe(Math.ceil("z".repeat(40).concat("\nx").length / 4))
  })

  it("round-trips real usage through SessionStore.appendAssistant → disk → compute", () => {
    const dir = tmp()
    const sid = "usage-roundtrip"
    const store = SessionStore.open({
      sid,
      model: "test-model-large",
      cwd: "/tmp/example",
      systemHash: "h",
      toolsHash: "t",
      agentVersion: "test",
      dir,
    })
    store.appendUser("compute something")
    store.appendAssistant([{ type: "text", text: "ok" }], "end_turn", {
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_input_tokens: 8000,
      cache_creation_input_tokens: 500,
    })

    const text = readFileSync(store.path, "utf-8")
    const { records } = parseLines(text)
    const u = computeSessionUsage(records)
    expect(u.estimated).toBe(false)
    expect(u.input).toBe(1200)
    expect(u.output).toBe(340)
    expect(u.cacheRead).toBe(8000)
    expect(u.cacheCreate).toBe(500)
    expect(u.tokens).toBe(1200 + 340 + 8000 + 500)
    expect(u.realTurns).toBe(1)
  })
})
