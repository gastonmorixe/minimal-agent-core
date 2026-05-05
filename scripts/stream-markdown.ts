#!/usr/bin/env bun
/**
 * stream-markdown.ts
 *
 * Simulates a real-time LLM network stream by replaying a markdown file in
 * randomised chunks with configurable timing, bursts, and stalls.
 *
 * The goal is to produce output that *feels* like tokens arriving over a live
 * HTTP SSE connection: mostly steady, occasionally bursty, sometimes stalled
 * for a beat (think "the model paused to think" or "packet got queued").
 *
 * ── Timing model ────────────────────────────────────────────────────────────
 *
 *   Each chunk goes through two independent dice rolls:
 *
 *   1. Chunk size   – uniform in [minChunk, maxChunk], then a gaussian nudge
 *                     whose width is proportional to chunkVariation.  Keeps
 *                     most chunks near the centre of the range while allowing
 *                     occasional outliers.
 *
 *   2. Delay        – starts at `speed` ms, then:
 *        • with probability slowdownChance → multiply by slowdownFactor
 *          (network stall / long token-gen pause)
 *        • with probability speedupChance  → multiply by speedupFactor
 *          (cached-token burst / fast inference path)
 *        • otherwise → gaussian jitter around `speed` scaled by speedVariation
 *
 *   The two rolls are independent, so you can get a tiny chunk delivered
 *   quickly, a big chunk after a stall, etc.
 *
 * ── UTF-8 safety ────────────────────────────────────────────────────────────
 *
 *   The file is encoded to a Uint8Array up front.  After computing the next
 *   slice endpoint we walk backwards until we land on a byte that is NOT a
 *   UTF-8 continuation byte (0x80–0xBF).  That way we never split a multi-
 *   byte character across two writes.
 *
 * ── Usage ───────────────────────────────────────────────────────────────────
 *
 *   bun scripts/stream-markdown.ts [options] [file]
 *
 * Options:
 *   --file <path>          Markdown file to stream  (required)
 *   --min-chunk <n>        Min chars per chunk       (default: 1)
 *   --max-chunk <n>        Max chars per chunk       (default: 9)
 *   --chunk-variation <f>  0–1 extra size jitter     (default: 0.6)
 *   --speed <ms>           Base delay between chunks (default: 28)
 *   --speed-variation <f>  0–1 timing jitter factor  (default: 0.7)
 *   --slowdown-chance <f>  0–1 prob of a stall       (default: 0.015)
 *   --slowdown-factor <f>  Delay multiplier on stall (default: 12)
 *   --speedup-chance <f>   0–1 prob of a burst       (default: 0.04)
 *   --speedup-factor <f>   Delay multiplier on burst (default: 0.08)
 *   --help                 Show this help
 */

import { readFileSync } from "fs"
import { resolve } from "path"

// ─── Config ───────────────────────────────────────────────────────────────────

interface Config {
  /** Path to the markdown file to stream. Required — no default. */
  file: string

  /** Minimum number of characters emitted per chunk. */
  minChunk: number

  /** Maximum number of characters emitted per chunk (soft — gaussian can exceed it). */
  maxChunk: number

  /**
   * Controls how wide the gaussian size jitter is, as a fraction of the
   * [minChunk, maxChunk] range.  0 = uniform distribution, 1 = very noisy.
   */
  chunkVariation: number

  /** Base inter-chunk delay in milliseconds. */
  speed: number

  /**
   * Controls the width of normal-distribution timing noise as a fraction
   * of `speed`.  0 = metronomic, 1 = highly variable.
   */
  speedVariation: number

  /**
   * Probability (0–1) that any given chunk triggers a "network stall".
   * Stall duration = speed * slowdownFactor * uniform(0.6, 1.4).
   */
  slowdownChance: number

  /**
   * Multiplier applied to `speed` during a stall event.
   * E.g. 12 means the gap is ~12× longer than normal.
   */
  slowdownFactor: number

  /**
   * Probability (0–1) that any given chunk triggers a "burst" (fast path).
   * Burst delay = speed * speedupFactor * uniform(0.5, 1.5).
   */
  speedupChance: number

  /**
   * Fraction of `speed` used during a burst event.
   * E.g. 0.08 means chunks arrive ~12.5× faster than normal.
   */
  speedupFactor: number
}

// ─── Arg parsing ─────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Config {
  // Sensible defaults that feel like a mid-tier LLM on a decent connection.
  const cfg: Config = {
    file: "",
    minChunk: 1,
    maxChunk: 9,
    chunkVariation: 0.6,
    speed: 28,
    speedVariation: 0.7,
    slowdownChance: 0.015,
    slowdownFactor: 12,
    speedupChance: 0.04,
    speedupFactor: 0.08,
  }

  const args = argv.slice(2) // drop "bun" and script path

  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    const val = args[i + 1]

    if (key === "--help" || key === "-h") {
      process.stdout.write(
        [
          "",
          "  stream-markdown — replay a markdown file like a live LLM stream",
          "",
          "  Usage: bun scripts/stream-markdown.ts [options] [file]",
          "",
          "  Options:",
          "    --file <path>          Markdown file                (required)",
          "    --min-chunk <n>        Min chars per chunk          (default: 1)",
          "    --max-chunk <n>        Max chars per chunk          (default: 9)",
          "    --chunk-variation <f>  0–1 extra size jitter        (default: 0.6)",
          "    --speed <ms>           Base delay ms between chunks (default: 28)",
          "    --speed-variation <f>  0–1 timing jitter factor     (default: 0.7)",
          "    --slowdown-chance <f>  0–1 probability of a stall   (default: 0.015)",
          "    --slowdown-factor <f>  Delay multiplier on stall    (default: 12)",
          "    --speedup-chance <f>   0–1 probability of a burst   (default: 0.04)",
          "    --speedup-factor <f>   Delay multiplier on burst    (default: 0.08)",
          "",
          "  Positional:  any non-flag arg is treated as --file",
          "",
        ].join("\n") + "\n",
      )
      process.exit(0)
    }

    // Helper: consume next token as a number and advance the loop index.
    const num = () => {
      const n = Number(val)
      if (isNaN(n)) throw new Error(`Expected number after ${key}, got "${val}"`)
      i++ // consume the value token
      return n
    }

    // Bare positional argument → treat as the file path.
    if (!key.startsWith("--")) {
      cfg.file = resolve(key)
      continue
    }

    switch (key) {
      case "--file":
        cfg.file = resolve(val)
        i++
        break
      case "--min-chunk":
        cfg.minChunk = num()
        break
      case "--max-chunk":
        cfg.maxChunk = num()
        break
      case "--chunk-variation":
        cfg.chunkVariation = num()
        break
      case "--speed":
        cfg.speed = num()
        break
      case "--speed-variation":
        cfg.speedVariation = num()
        break
      case "--slowdown-chance":
        cfg.slowdownChance = num()
        break
      case "--slowdown-factor":
        cfg.slowdownFactor = num()
        break
      case "--speedup-chance":
        cfg.speedupChance = num()
        break
      case "--speedup-factor":
        cfg.speedupFactor = num()
        break
      default:
        process.stderr.write(`Unknown option: ${key}\n`)
        process.exit(1)
    }
  }

  return cfg
}

// ─── RNG helpers ─────────────────────────────────────────────────────────────

/** Uniform random in [0, 1). */
const rand = () => Math.random()

/** Uniform random in [lo, hi). */
const randRange = (lo: number, hi: number) => lo + rand() * (hi - lo)

/**
 * Standard-normal sample via Box-Muller transform.
 *
 * Box-Muller takes two independent uniform samples (u, v) and produces a
 * normally distributed value with mean 0 and σ = 1.  We only use one of the
 * two outputs (the cos branch) — the sin branch is equally valid but we'd
 * need to store it for later, which isn't worth the complexity here.
 *
 * The `1 - rand()` for u avoids passing exactly 0 to log().
 */
function randn(): number {
  const u = 1 - rand()
  const v = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Clamp x into [lo, hi]. */
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

// ─── Chunk-size model ─────────────────────────────────────────────────────────

/**
 * Pick how many bytes to write in the next chunk.
 *
 * Process:
 *   1. Draw a uniform base in [minChunk, maxChunk+1).
 *   2. Add gaussian noise whose σ = (range * chunkVariation * 0.4).
 *      The 0.4 factor keeps the distribution from blowing up even at
 *      chunkVariation = 1; it's a tuning knob, not a magic constant.
 *   3. Round, clamp to [1, maxChunk*2], and return.
 *
 * The soft upper bound of maxChunk*2 allows rare large chunks while
 * preventing truly absurd sizes.
 */
function nextChunkSize(cfg: Config): number {
  const base = randRange(cfg.minChunk, cfg.maxChunk + 1)
  const spread = (cfg.maxChunk - cfg.minChunk) * cfg.chunkVariation
  const noisy = base + randn() * spread * 0.4
  return Math.max(1, Math.round(clamp(noisy, cfg.minChunk, cfg.maxChunk * 2)))
}

// ─── Delay model ─────────────────────────────────────────────────────────────

/**
 * Pick how long to wait before writing the next chunk (milliseconds).
 *
 * Three mutually exclusive outcomes, checked in priority order:
 *
 *   slowdown  (rare)   – mimics a network stall or a long decoding step.
 *                        Duration is slowdownFactor × speed, with ±40% jitter
 *                        so stalls don't all look identical.
 *
 *   speedup   (occasional) – mimics a cached-token burst or a fast
 *                        inference path.  Duration is speedupFactor × speed,
 *                        also with ±50% jitter.
 *
 *   normal    (most of the time) – gaussian noise around `speed`.
 *                        σ = speed * speedVariation * 0.5.  The 0.5 factor
 *                        prevents negative delays even at speedVariation = 1
 *                        in most draws; the final Math.max(0, ...) is the hard
 *                        floor.
 *
 * Note: slowdown and speedup are checked against the same rand() roll so
 * they are mutually exclusive within a single chunk, but independent across
 * chunks (each chunk gets its own roll).
 */
function nextDelay(cfg: Config): number {
  const r = rand()

  // ── Stall event ─────────────────────────────────────────────────────────
  if (r < cfg.slowdownChance) {
    const stall = cfg.speed * cfg.slowdownFactor * randRange(0.6, 1.4)
    return Math.round(stall)
  }

  // ── Burst event ─────────────────────────────────────────────────────────
  // Threshold is the *sum* of the two chances, because r already cleared the
  // slowdown check above.
  if (r < cfg.slowdownChance + cfg.speedupChance) {
    return Math.round(cfg.speed * cfg.speedupFactor * randRange(0.5, 1.5))
  }

  // ── Normal jittered delay ───────────────────────────────────────────────
  const jitter = randn() * cfg.speed * cfg.speedVariation * 0.5
  return Math.max(0, Math.round(cfg.speed + jitter))
}

// ─── Utilities ───────────────────────────────────────────────────────────────

/** Promise-based setTimeout wrapper. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = parseArgs(process.argv)

  // ── Load file ────────────────────────────────────────────────────────────
  if (!cfg.file) {
    process.stderr.write(`Usage: bun scripts/stream-markdown.ts <file> [options]\n`)
    process.exit(1)
  }

  let text: string
  try {
    text = readFileSync(cfg.file, "utf8")
  } catch (e: any) {
    process.stderr.write(`Cannot read file: ${cfg.file}\n${e.message}\n`)
    process.exit(1)
  }

  // Work in raw bytes so we can slice at arbitrary positions while keeping
  // UTF-8 safety.  We encode once and decode each slice individually.
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const bytes = encoder.encode(text)

  const out = process.stdout

  // ── Streaming loop ───────────────────────────────────────────────────────
  let pos = 0
  while (pos < bytes.length) {
    const size = nextChunkSize(cfg)
    const end = Math.min(pos + size, bytes.length)

    // Walk back from `end` until we're not sitting on a UTF-8 continuation
    // byte (0x80–0xBF).  Continuation bytes are the 2nd/3rd/4th bytes of a
    // multi-byte sequence; splitting there would produce mojibake.
    let safeEnd = end
    while (safeEnd > pos && (bytes[safeEnd] & 0xc0) === 0x80) safeEnd--

    // Decode and write the chunk.
    const chunk = decoder.decode(bytes.slice(pos, safeEnd))
    out.write(chunk)
    pos = safeEnd

    // Sleep between chunks but not after the very last one.
    if (pos < bytes.length) {
      await sleep(nextDelay(cfg))
    }
  }

  // Guarantee the output ends with a newline so the shell prompt lands on a
  // fresh line even if the markdown file doesn't end with one.
  if (!text.endsWith("\n")) out.write("\n")
}

main().catch((e) => {
  process.stderr.write(String(e) + "\n")
  process.exit(1)
})
