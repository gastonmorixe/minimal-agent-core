/**
 * Cache observability: debug formatting and live anomaly detection.
 *
 * ⚠️ TRANSITION NOTE (WORK3 cache decoupling): everything in THIS module is
 * REQUEST-side Anthropic-shaped cache observability and is consumed ONLY by
 * the legacy Anthropic client (`src/client.ts`). It is slated to relocate
 * into the Anthropic provider plugin / die with `client.ts` in WORK1 Phase D.
 * The provider-NEUTRAL {@link CacheUsage} accounting type moved OUT to
 * `src/cache-usage.ts` (it must outlive this file because the surviving core
 * consumer `src/session-tokens.ts` depends on it); it is re-exported here for
 * back-compat with `client.ts` + this module's own tests.
 *
 * Two responsibilities, one module so the rendering and the heuristics share
 * a single understanding of the `usage` payload shape:
 *
 * 1. {@link formatCacheLine} — pretty-print the per-turn cache outcome from
 *    a `message_start` SSE event. Designed to be printed to stderr in
 *    `--debug` mode immediately when streaming begins.
 *
 * 2. {@link CacheAnomalyDetector} — stateful, per-process. Observes each
 *    turn's request context + response usage and warns to stderr (without
 *    needing `--debug`) when the cache misbehaves. Each anomaly type is
 *    emitted at most once per process to avoid spam.
 *
 * The fields read off `usage` mirror the live wire shape from Claude Code
 * 2.1.118 (verified against `~/.node-net-dbg/...`):
 *
 *     "usage": \{
 *       "input_tokens": 1,
 *       "cache_creation_input_tokens": 419,
 *       "cache_read_input_tokens": 38789,
 *       "cache_creation": \{ "ephemeral_5m_input_tokens": 0,
 *                           "ephemeral_1h_input_tokens": 419 \},
 *       "output_tokens": 1
 *     \}
 */

import { findModel } from "./llm/model-registry.ts"
import type { CacheUsage } from "./quota/cache-usage.ts"

// Re-export the neutral accounting type for back-compat: callers that did
// `import { CacheUsage } from "./cache.ts"` keep resolving while the
// Anthropic-specific observability below relocates in WORK1 Phase D.
export type { CacheUsage } from "./quota/cache-usage.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Snapshot of the request that produced the observed `usage`. The detector
 * uses this to reason about whether the cache *should* have engaged.
 */
export interface RequestContextSnapshot {
  /** How many `cache_control` markers were placed on this request. */
  breakpoints: number
  /** Approximate request prefix size in chars (system + tools + messages). */
  approxPrefixChars: number
  /** Model ID used (post-normalization, no `[1m]` suffix). */
  model: string
}

// ---------------------------------------------------------------------------
// Color helpers (kept local to avoid pulling agent.ts into client.ts cycles)
// ---------------------------------------------------------------------------

const ESC = "\x1b["
const dim = (s: string) => `${ESC}2m${s}${ESC}22m`
const bold = (s: string) => `${ESC}1m${s}${ESC}22m`
const cyan = (s: string) => `${ESC}36m${s}${ESC}39m`
const green = (s: string) => `${ESC}32m${s}${ESC}39m`
const yellow = (s: string) => `${ESC}33m${s}${ESC}39m`
const magenta = (s: string) => `${ESC}35m${s}${ESC}39m`

// ---------------------------------------------------------------------------
// formatCacheLine — minimalist one-liner for --debug
// ---------------------------------------------------------------------------

/**
 * Render a single status line summarizing the cache outcome of one turn.
 *
 * Style: faint label, bright values. The label `cache` and field names sit
 * dim; numbers and the TTL bucket are colored. Output fits 80 columns.
 *
 * Example:
 *   cache  read 38,789  write 419 (1h)  new 1  out 47
 *
 * When all cache numbers are zero, the line collapses to `cache  cold`,
 * making it obvious the request did not engage the cache at all.
 */
export function formatCacheLine(usage: CacheUsage | undefined): string {
  if (!usage) return `  ${dim("cache")}  ${dim("(no usage)")}`

  const read = usage.cache_read_input_tokens ?? 0
  const create = usage.cache_creation_input_tokens ?? 0
  const newIn = usage.input_tokens ?? 0
  const out = usage.output_tokens ?? 0
  const ttl1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0
  const ttl5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0
  const ttl = ttl1h > 0 && ttl5m > 0 ? "mix" : ttl1h > 0 ? "1h" : ttl5m > 0 ? "5m" : null

  if (read === 0 && create === 0) {
    return `  ${dim("cache")}  ${dim("cold")}  ${dim("new")} ${bold(fmt(newIn))}  ${dim("out")} ${bold(fmt(out))}`
  }

  const parts = [
    `  ${dim("cache")}`,
    read > 0 ? `${dim("read")} ${green(bold(fmt(read)))}` : "",
    create > 0 ? `${dim("write")} ${cyan(bold(fmt(create)))}${ttl ? dim(` (${ttl})`) : ""}` : "",
    `${dim("new")} ${bold(fmt(newIn))}`,
    out > 0 ? `${dim("out")} ${bold(fmt(out))}` : `${dim("out")} ${dim("-")}`,
  ]
  return parts.filter(Boolean).join("  ")
}

function fmt(n: number): string {
  // 38789 → "38,789" — readable but compact.
  return n.toLocaleString("en-US")
}

// ---------------------------------------------------------------------------
// CacheAnomalyDetector — always-on warnings to stderr
// ---------------------------------------------------------------------------

/**
 * Anomaly codes are stable strings so callers (tests, log scrapers) can
 * pattern-match without parsing prose.
 */
export type AnomalyCode =
  | "markers_ignored_cold" // request had markers, response had 0 read + 0 write
  | "no_read_after_write" // turn N+1 didn't read what turn N just wrote
  | "cache_evicted" // cache_read climbed then collapsed to 0
  | "below_min_block_size" // prefix is below the per-model cache minimum

interface ObservedTurn {
  turn: number
  read: number
  create: number
  hadMarkers: boolean
  approxPrefixChars: number
}

/**
 * Per-model cache-eligibility threshold, from the registry's capability
 * record (`caching.minPrefixTokens` — each provider declares its own API
 * minimums; core no longer guesses by id substring). Providers silently
 * ignore cache markers when the prefix is below this. Thresholds are in
 * tokens; we compare against char counts with a conservative
 * 4-chars-per-token estimate. Unregistered ids fall back to the most
 * common floor (1024) so the detector still educates rather than spams.
 */
const MIN_TOKENS_FOR_CACHE = (model: string): number =>
  findModel(model)?.capabilities?.caching?.minPrefixTokens ?? 1024
const MIN_CHARS_FOR_CACHE = (model: string): number => MIN_TOKENS_FOR_CACHE(model) * 4

/**
 * Stateful, per-process. Observe each turn in order; the detector compares
 * against the prior turn(s) to spot regressions.
 */
export class CacheAnomalyDetector {
  private turns: ObservedTurn[] = []
  private warnedCodes = new Set<AnomalyCode>()
  private write: (line: string) => void

  constructor(opts?: { write?: (line: string) => void }) {
    this.write = opts?.write ?? ((line) => process.stderr.write(line + "\n"))
  }

  /**
   * Record one turn's outcome. Emits at most one stderr warning per
   * anomaly code per process.
   *
   * @returns The list of anomaly codes detected on this turn (useful for
   *   tests; callers in production can ignore the return value).
   */
  observe(usage: CacheUsage, ctx: RequestContextSnapshot): AnomalyCode[] {
    const turn: ObservedTurn = {
      turn: this.turns.length + 1,
      read: usage.cache_read_input_tokens ?? 0,
      create: usage.cache_creation_input_tokens ?? 0,
      hadMarkers: ctx.breakpoints > 0,
      approxPrefixChars: ctx.approxPrefixChars,
    }
    this.turns.push(turn)

    const fired: AnomalyCode[] = []
    const minChars = MIN_CHARS_FOR_CACHE(ctx.model)

    // (a) markers present, prefix big enough, but the API gave us neither
    //     a read nor a write → markers were silently dropped or hashed wrong.
    if (
      turn.hadMarkers &&
      turn.read === 0 &&
      turn.create === 0 &&
      turn.approxPrefixChars >= minChars
    ) {
      fired.push("markers_ignored_cold")
      this.maybeWarn(
        "markers_ignored_cold",
        `cache: request had ${ctx.breakpoints} cache_control marker(s) over ~${turn.approxPrefixChars} chars but the API returned 0 read + 0 write. Likely causes: a marker on a sub-threshold block, or the prefix differs from the prior turn (e.g. timestamps or session_id changed).`,
      )
    }

    // (b) markers present, prefix below the per-model threshold → educate
    //     the user that the markers will not engage until content grows.
    if (
      turn.hadMarkers &&
      turn.read === 0 &&
      turn.create === 0 &&
      turn.approxPrefixChars < minChars
    ) {
      fired.push("below_min_block_size")
      this.maybeWarn(
        "below_min_block_size",
        `cache: prefix is ~${turn.approxPrefixChars} chars (~${Math.round(turn.approxPrefixChars / 4)} tokens), below this model's ${MIN_TOKENS_FOR_CACHE(ctx.model)}-token cache minimum. Markers are silently ignored until the prefix grows.`,
      )
    }

    // (c) turn N wrote a cache, turn N+1 should have read it.
    if (this.turns.length >= 2) {
      const prev = this.turns[this.turns.length - 2]
      if (prev.create > 0 && turn.read === 0 && turn.hadMarkers) {
        fired.push("no_read_after_write")
        this.maybeWarn(
          "no_read_after_write",
          `cache: turn ${prev.turn} wrote ${prev.create} tokens to cache but turn ${turn.turn} read 0. The prefix likely changed between turns (a content edit, a new system block, or a different session_id).`,
        )
      }
    }

    // (d) cache_read was climbing, then collapsed to 0 → eviction or change.
    if (this.turns.length >= 3) {
      const prev = this.turns[this.turns.length - 2]
      const before = this.turns[this.turns.length - 3]
      if (before.read > 0 && prev.read > 0 && turn.read === 0) {
        fired.push("cache_evicted")
        this.maybeWarn(
          "cache_evicted",
          `cache: cache_read collapsed to 0 after climbing across prior turns (${before.read} → ${prev.read} → 0). The cached prefix was likely evicted (TTL expired) or the request prefix changed.`,
        )
      }
    }

    return fired
  }

  /**
   * Reset internal state. Intended for tests; no production caller needs
   * this since the detector is a per-process singleton in normal use.
   */
  reset(): void {
    this.turns = []
    this.warnedCodes.clear()
  }

  private maybeWarn(code: AnomalyCode, message: string): void {
    if (this.warnedCodes.has(code)) return
    this.warnedCodes.add(code)
    this.write(
      `  ${yellow(bold("⚠"))} ${magenta("cache anomaly")} ${dim(`[${code}]`)}\n  ${dim("→")} ${message}`,
    )
  }
}

let SINGLETON: CacheAnomalyDetector | null = null

/** Singleton accessor used by the live SSE handler. */
export function getCacheDetector(): CacheAnomalyDetector {
  if (!SINGLETON) SINGLETON = new CacheAnomalyDetector()
  return SINGLETON
}

/** Test seam — replace the singleton with a custom-writer instance. */
export function _setCacheDetector(d: CacheAnomalyDetector | null): void {
  SINGLETON = d
}

// ---------------------------------------------------------------------------
// Helpers for callers that need to summarize a request body
// ---------------------------------------------------------------------------

/**
 * Walk a request body once and produce the snapshot the detector needs.
 * Counts every `cache_control` field (system, tools, messages, nested
 * content blocks) and sums the visible text length as a prefix-size proxy.
 */
export function snapshotRequest(
  body: Record<string, unknown>,
  model: string,
): RequestContextSnapshot {
  let breakpoints = 0
  let chars = 0

  const walk = (v: unknown): void => {
    if (!v || typeof v !== "object") return
    if (Array.isArray(v)) {
      v.forEach(walk)
      return
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "cache_control" && val) breakpoints++
      else if (k === "text" && typeof val === "string") chars += val.length
      else if (k === "content" && typeof val === "string") chars += val.length
      else walk(val)
    }
  }
  walk(body)

  return { breakpoints, approxPrefixChars: chars, model }
}
