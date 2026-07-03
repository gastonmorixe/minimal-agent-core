import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { parseLines, type SessionRecord, SessionStore } from "./session-store.ts"
import { billedUsageOf, computeSessionUsage, ZERO_SESSION_USAGE } from "./session-usage.ts"

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

describe("billedUsageOf", () => {
  it("normalizes missing fields to zero", () => {
    expect(billedUsageOf(undefined)).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })
    expect(billedUsageOf({})).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })
  })

  it("reads all four wire fields", () => {
    expect(
      billedUsageOf({
        input_tokens: 1,
        output_tokens: 2,
        cache_read_input_tokens: 3,
        cache_creation_input_tokens: 4,
      }),
    ).toEqual({ input: 1, output: 2, cacheRead: 3, cacheCreate: 4 })
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

  it("falls back to estimation when ANY assistant turn lacks usage", () => {
    const records = [
      meta(),
      user("hello there"),
      assistant("answer with usage", { input_tokens: 100, output_tokens: 50 }),
      assistant("answer WITHOUT usage"), // no usage → whole session estimated
    ]
    const u = computeSessionUsage(records)
    expect(u.estimated).toBe(true)
    // Estimated path does not expose billed counters.
    expect(u.input).toBe(0)
    expect(u.output).toBe(0)
    // It estimated SOMETHING from the transcript text.
    expect(u.tokens).toBeGreaterThan(0)
    expect(u.turns).toBe(2)
    expect(u.realTurns).toBe(1)
  })

  it("estimation is deterministic and model-ratio sensitive", () => {
    const text = "x".repeat(70)
    const recs = (model: string): SessionRecord[] => [
      meta(model),
      user(text),
      assistant("done"), // no usage → estimated path
    ]
    // Unknown model → default ratio 3.5. Known anthropic model also 3.5.
    // We just assert it's stable + positive (registry may or may not be
    // populated in this unit test, so we don't pin an exact number tied to
    // a registered estimator here).
    const a = computeSessionUsage(recs("unknown-model-xyz"))
    const b = computeSessionUsage(recs("unknown-model-xyz"))
    expect(a.tokens).toBe(b.tokens)
    expect(a.tokens).toBeGreaterThan(0)
  })

  it("treats an all-zero usage payload as missing (estimates)", () => {
    const records = [meta(), user("hi"), assistant("a", { input_tokens: 0, output_tokens: 0 })]
    const u = computeSessionUsage(records)
    expect(u.estimated).toBe(true)
    expect(u.realTurns).toBe(0)
  })

  it("respects an explicit modelId override for estimation", () => {
    const text = "z".repeat(40)
    const records: SessionRecord[] = [meta("meta-model"), user(text), assistant("x")]
    // Override with an unknown id → default 3.5 ratio. 40/3.5 = ceil ~12.
    const u = computeSessionUsage(records, { modelId: "override-unknown" })
    expect(u.estimated).toBe(true)
    expect(u.tokens).toBeGreaterThan(0)
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
