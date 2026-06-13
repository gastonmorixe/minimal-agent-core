/**
 * Live progress derivation: read a worker's OWN session JSONL (which a real
 * `minimal-agent` child writes append-only as it works) and distill a
 * {@link Progress} — tool count, billed tokens, and what it's doing right now.
 * This is what makes the fleet widget show real activity instead of zeros.
 *
 * Pure parser (text in, Progress out) + a tolerant tail reader. Reading the
 * child's transcript is observability over a data file (like the result
 * sentinel), not a code dependency on the session store.
 *
 * @module sub-agents/lib/progress
 */

import { type Progress, ZERO_PROGRESS } from "./types.ts"

/** The Anthropic-wire saved usage payload (only the fields we read). */
interface MaybeUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** One parsed session record (only the fields we read; everything else ignored). */
interface MaybeRecord {
  kind?: string
  content?: unknown
  usage?: MaybeUsage
}

/**
 * Normalize a saved `usage` payload into the four billed counters (missing →
 * 0). LOCAL re-declaration of the host's `billedUsageOf` pure helper (source
 * of truth: `src/session-usage.ts`); re-declared here so the plugin imports
 * nothing from the host repo (the decoupling contract). The fleet widget sums
 * `input + output` only — the honest monotonic billed-work number, with
 * cache re-reads excluded (they'd inflate it; see session-tokens cacheRead).
 */
function billedUsageOf(u: MaybeUsage | undefined): {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
} {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheCreate: u?.cache_creation_input_tokens ?? 0,
  }
}

interface MaybeBlock {
  type?: string
  name?: string
  text?: string
  input?: Record<string, unknown>
}

/** A short human phrase for a tool_use block: `Bash: echo hi`, `Read: src/x.ts`. */
function toolActivity(b: MaybeBlock): string {
  const name = b.name ?? "tool"
  const input = b.input ?? {}
  const firstArg =
    (typeof input.command === "string" && input.command) ||
    (typeof input.file_path === "string" && input.file_path) ||
    (typeof input.path === "string" && input.path) ||
    (typeof input.pattern === "string" && input.pattern) ||
    (typeof input.query === "string" && input.query) ||
    ""
  const arg = (firstArg || "").replace(/\s+/g, " ").trim()
  return arg ? `${name}: ${arg}` : name
}

/**
 * Parse a worker's JSONL transcript into live {@link Progress}.
 *
 *  - `tools`  = number of `tool_use` blocks across assistant records.
 *  - `tokens` = sum of (input + output) tokens across assistant `usage`,
 *    read via the shared {@link billedUsageOf} normalizer (the honest billed
 *    total, which grows monotonically).
 *  - `lastTool` / `lastActivity` = the most recent tool (or a text snippet),
 *    so the widget can show "what is it doing".
 */
export function parseProgress(jsonlText: string): Progress {
  let tools = 0
  let tokens = 0
  let lastTool: string | undefined
  let lastActivity: string | undefined

  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let rec: MaybeRecord
    try {
      rec = JSON.parse(trimmed) as MaybeRecord
    } catch {
      continue
    }
    if (rec.kind !== "assistant") continue
    const blocks: MaybeBlock[] = Array.isArray(rec.content) ? (rec.content as MaybeBlock[]) : []
    for (const b of blocks) {
      if (b?.type === "tool_use") {
        tools++
        if (typeof b.name === "string") lastTool = b.name
        lastActivity = toolActivity(b)
      } else if (b?.type === "text" && typeof b.text === "string" && b.text.trim().length > 0) {
        lastActivity = b.text.replace(/\s+/g, " ").trim().slice(0, 60)
      }
    }
    // Reuse the shared billed-usage normalizer so the field names + zero
    // handling match the `--sessions` aggregator. The fleet widget wants a
    // monotonic "billed work" number, so we sum input+output only (cache
    // re-reads would inflate it; see session-tokens.ts cacheRead docstring).
    if (rec.usage) {
      const b = billedUsageOf(rec.usage)
      tokens += b.input + b.output
    }
  }

  if (tools === 0 && tokens === 0 && lastActivity === undefined) return ZERO_PROGRESS
  return {
    tools,
    tokens,
    ...(lastTool ? { lastTool } : {}),
    ...(lastActivity ? { lastActivity } : {}),
  }
}

/**
 * Distill a worker's transcript into its FINAL synthesis: the concatenated text
 * blocks of the LAST assistant message that contains any non-empty text.
 *
 * This is the robust fallback when a worker exits WITHOUT writing a result
 * sentinel. Every agent produces a final assistant message (its closing
 * summary), and the supervisor already reads this same `.jsonl` every tick for
 * progress, so distilling the last text costs nothing extra and does not depend
 * on the model remembering to perform an explicit final action under context
 * pressure. Trailing tool-only turns are skipped (we want the prose, not a tool
 * echo). Returns `undefined` when there is no assistant text at all (a truly
 * silent worker → the supervisor marks it `incomplete`).
 *
 * @param jsonlText - The worker session transcript as raw JSONL text.
 * @param maxChars - Clip the result to this many characters (default 2000) so a
 *   runaway final message can't blow the lead's context. Clipping is marked.
 */
export function parseFinalText(jsonlText: string, maxChars = 2000): string | undefined {
  let last: string | undefined
  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let rec: MaybeRecord
    try {
      rec = JSON.parse(trimmed) as MaybeRecord
    } catch {
      continue
    }
    if (rec.kind !== "assistant") continue
    const blocks: MaybeBlock[] = Array.isArray(rec.content) ? (rec.content as MaybeBlock[]) : []
    const text = blocks
      .filter((b) => b?.type === "text" && typeof b.text === "string")
      .map((b) => (b.text as string).trim())
      .filter((t) => t.length > 0)
      .join("\n\n")
      .trim()
    // Keep the most recent assistant message that actually said something.
    if (text.length > 0) last = text
  }
  if (!last) return undefined
  if (last.length <= maxChars) return last
  return `${last.slice(0, maxChars - 1).trimEnd()}…`
}
