import { describe, expect, it } from "bun:test"

import {
  CacheAnomalyDetector,
  type CacheUsage,
  formatCacheLine,
  type RequestContextSnapshot,
  snapshotRequest,
} from "./cache.ts"
import { registerTestProvider } from "./llm/test-fixtures.ts"

const ANSI = new RegExp(`${String.fromCodePoint(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`, "g")
const strip = (s: string) => s.replace(ANSI, "")

describe("formatCacheLine", () => {
  it("renders cold when both read and write are zero", () => {
    const out = strip(formatCacheLine({ input_tokens: 99, output_tokens: 0 }))
    expect(out).toContain("cache")
    expect(out).toContain("cold")
    expect(out).toContain("new 99")
  })

  it("renders read with thousands separator", () => {
    const out = strip(
      formatCacheLine({
        input_tokens: 1,
        output_tokens: 47,
        cache_read_input_tokens: 38789,
        cache_creation_input_tokens: 419,
        cache_creation: { ephemeral_1h_input_tokens: 419, ephemeral_5m_input_tokens: 0 },
      }),
    )
    expect(out).toContain("read 38,789")
    expect(out).toContain("write 419")
    expect(out).toContain("(1h)")
    expect(out).toContain("new 1")
    expect(out).toContain("out 47")
  })

  it("labels TTL as 5m, 1h, or mix appropriately", () => {
    const fivem = strip(
      formatCacheLine({
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 },
      }),
    )
    expect(fivem).toContain("(5m)")

    const both = strip(
      formatCacheLine({
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 50 },
      }),
    )
    expect(both).toContain("(mix)")
  })

  it("handles missing usage gracefully", () => {
    const out = strip(formatCacheLine(undefined))
    expect(out).toContain("(no usage)")
  })
})

describe("snapshotRequest", () => {
  it("counts cache_control markers across system, tools, and messages", () => {
    const body = {
      system: [
        { type: "text", text: "x".repeat(100) },
        { type: "text", text: "y".repeat(200), cache_control: { type: "ephemeral" } },
      ],
      tools: [{ name: "a", description: "..." }],
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hi" },
            { type: "text", text: "tail", cache_control: { type: "ephemeral" } },
          ],
        },
      ],
    }
    const snap = snapshotRequest(body, "test-model-1")
    expect(snap.breakpoints).toBe(2)
    expect(snap.approxPrefixChars).toBe(100 + 200 + 2 + 4)
    expect(snap.model).toBe("test-model-1")
  })
})

describe("CacheAnomalyDetector", () => {
  const sonnetCtx = (breakpoints: number, chars: number): RequestContextSnapshot => ({
    breakpoints,
    approxPrefixChars: chars,
    model: "test-model-1",
  })

  const usage = (read: number, create: number): CacheUsage => ({
    cache_read_input_tokens: read,
    cache_creation_input_tokens: create,
    cache_creation: { ephemeral_1h_input_tokens: create, ephemeral_5m_input_tokens: 0 },
  })

  it("warns once when markers are ignored despite a large prefix", () => {
    const writes: string[] = []
    const d = new CacheAnomalyDetector({ write: (l) => writes.push(l) })
    // Prefix well over 4096 chars (1024 tokens × 4 chars/token).
    const fired = d.observe(usage(0, 0), sonnetCtx(2, 50_000))
    expect(fired).toContain("markers_ignored_cold")
    expect(writes.length).toBe(1)
    expect(strip(writes[0])).toContain("markers_ignored_cold")

    // Same anomaly on the next turn must not re-warn.
    d.observe(usage(0, 0), sonnetCtx(2, 50_000))
    expect(writes.length).toBe(1)
  })

  it("warns when prefix is below the per-model min size", () => {
    const writes: string[] = []
    const d = new CacheAnomalyDetector({ write: (l) => writes.push(l) })
    const fired = d.observe(usage(0, 0), sonnetCtx(2, 200))
    expect(fired).toContain("below_min_block_size")
    expect(strip(writes[0])).toContain("1024-token")
  })

  it("uses the registry's higher minPrefixTokens for the cheap tier", () => {
    // Threshold now comes from capabilities.caching.minPrefixTokens
    // (Phase 18 inline: providers declare API minimums; core stopped
    // guessing by id substring). Register a synthetic model that declares
    // the higher cheap-tier minimum, like a provider catalog would (A-5:
    // no plugins/ import — the detector only reads the registry record).
    registerTestProvider({
      models: [
        {
          id: "test-cheap-model-1",
          capabilities: {
            caching: {
              explicit: true,
              automatic: false,
              ttls: ["5m", "1h"],
              minPrefixTokens: 2048,
              reportsCacheHits: true,
            },
          },
        },
      ],
    })
    const writes: string[] = []
    const d = new CacheAnomalyDetector({ write: (l) => writes.push(l) })
    // 5000 chars = ~1250 tokens — over the 1024 floor but under the
    // cheap tier's 2048 minimum.
    const fired = d.observe(usage(0, 0), {
      breakpoints: 2,
      approxPrefixChars: 5000,
      model: "test-cheap-model-1",
    })
    expect(fired).toContain("below_min_block_size")
    expect(strip(writes[0])).toContain("2048-token")
  })

  it("falls back to the 1024 floor for unregistered model ids", () => {
    const writes: string[] = []
    const d = new CacheAnomalyDetector({ write: (l) => writes.push(l) })
    const fired = d.observe(usage(0, 0), {
      breakpoints: 2,
      approxPrefixChars: 5000, // ~1250 tokens: above the 1024 fallback
      model: "totally-unknown-model",
    })
    expect(fired).not.toContain("below_min_block_size")
  })

  it("warns when turn N+1 doesn't read what turn N just wrote", () => {
    const writes: string[] = []
    const d = new CacheAnomalyDetector({ write: (l) => writes.push(l) })
    d.observe(usage(0, 3000), sonnetCtx(2, 50_000)) // turn 1 writes
    const fired = d.observe(usage(0, 0), sonnetCtx(2, 50_000)) // turn 2 ignores
    expect(fired).toContain("no_read_after_write")
  })

  it("warns when cache_read collapses after climbing", () => {
    const writes: string[] = []
    const d = new CacheAnomalyDetector({ write: (l) => writes.push(l) })
    d.observe(usage(2997, 22), sonnetCtx(2, 50_000))
    d.observe(usage(3019, 22), sonnetCtx(2, 50_000))
    const fired = d.observe(usage(0, 50), sonnetCtx(2, 50_000))
    expect(fired).toContain("cache_evicted")
  })

  it("stays silent on the healthy rolling-cache path", () => {
    const writes: string[] = []
    const d = new CacheAnomalyDetector({ write: (l) => writes.push(l) })
    d.observe(usage(0, 2997), sonnetCtx(2, 50_000))
    d.observe(usage(2997, 22), sonnetCtx(2, 50_000))
    d.observe(usage(3019, 22), sonnetCtx(2, 50_000))
    expect(writes).toEqual([])
  })
})
