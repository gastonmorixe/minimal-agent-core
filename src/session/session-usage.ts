/**
 * Reusable token-usage aggregation for a session.
 *
 * One place computes "how many tokens did this session use", from the
 * append-only session records. It powers the `--sessions` listing column,
 * the sub-agent fleet widget's per-worker token readout, and anything else
 * that needs a session's footprint after the fact.
 *
 * Two sources, mixed per-turn:
 *
 *   1. REAL — for turns with a persisted billed `usage` payload
 *      (`input / output / cache-read / cache-create` from the provider's
 *      `message_start` + `message_delta`), we sum the exact billed counters
 *      and (for cost) use the model's pricing. `estimated` stays false only
 *      when every turn is real.
 *
 *   2. ESTIMATED — for turns lacking billed usage (old sessions, crashes,
 *      providers that do not report usage) we estimate from transcript
 *      text via the model's tokenizer ratio
 *      (`estimateTokensForModel`, provider-scoped when a `provider`
 *      is present on the meta record). Estimated turns contribute 0 to
 *      billed sub-counters and cost, so `costUSD` stays billed-only.
 *
 * Mixing is approximate: a real turn's `input_tokens` already includes
 * the prefix that an adjacent estimated turn re-estimates from its own
 * prompt+assistant text, so `tokens` double-counts the prefix slightly.
 * This is intentional — the headline `tokens` is a magnitude for the
 * `[E]`/`[~]` listing, not a billing meter — and the billed split
 * (`input/output/cacheRead/cacheCreate`) remains exact.
 *
 * @module session-usage
 */

import {
  addUsageCounters,
  hasBilledTokens,
  type UsageCounters,
  type UsageRecord,
  usageCountersOf,
} from "../llm/codec/usage-record.ts"
import type { ContentBlock } from "../llm/messages.ts"
import { findModelForProvider } from "../llm/model-registry.ts"
import { estimateTokensForModel } from "../llm/token-estimate.ts"

import type { AssistantRecord, MetaRecord, SessionRecord } from "./session-store.ts"

/**
 * Aggregated token usage for one session.
 */
export interface SessionUsage {
  /**
   * Headline token count for the session.
   *
   * When `estimated` is false this is the total BILLED tokens
   * (`input + output + cacheRead + cacheCreate`) summed across turns — the
   * real cost driver. When `estimated` is true this is the approximate
   * transcript CONTENT size (no cache re-read inflation). Marked accordingly.
   */
  tokens: number
  /** Cumulative new-input tokens (real path only; 0 when estimated). */
  input: number
  /** Cumulative output tokens. */
  output: number
  /** Cumulative cache-read tokens (real path only; 0 when estimated). */
  cacheRead: number
  /** Cumulative cache-creation tokens (real path only; 0 when estimated). */
  cacheCreate: number
  /**
   * Of {@link cacheCreate}, the 1 hour TTL writes. Optional in the type so
   * hosts that build a `SessionUsage` keep compiling. `computeSessionUsage`
   * always sets it.
   */
  cacheCreate1h?: number
  /** Thinking tokens, already counted in {@link output}. Always set by `computeSessionUsage`. */
  thinking?: number
  /** Billed server web-search calls. Always set by `computeSessionUsage`. */
  webSearchRequests?: number
  /**
   * True when any part of {@link tokens} was estimated rather than read from
   * saved billed usage. Drives the `[E]` / `[R]` marker in listings.
   */
  estimated: boolean
  /** Number of content-bearing assistant turns counted. */
  turns: number
  /** Of {@link turns}, how many carried saved billed usage. */
  realTurns: number
}

/** A zero/empty usage result (no assistant turns). Reported as real (nothing to estimate). */
export const ZERO_SESSION_USAGE: SessionUsage = {
  tokens: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  cacheCreate1h: 0,
  thinking: 0,
  webSearchRequests: 0,
  estimated: false,
  turns: 0,
  realTurns: 0,
}

/** Billed counters of one saved usage record, normalized (missing = 0). */
export type BilledUsage = UsageCounters

/**
 * Normalize a saved usage record into billed counters (missing = 0).
 *
 * The shared primitive for reading a persisted `usage` record, so every
 * consumer (the `--sessions` aggregator, usage stats, anything else) agrees
 * on the field names and zero handling. Pure. Delegates to the codec.
 *
 * @param u - A saved usage record, or `undefined`.
 * @returns The counters. All zero when `u` is absent.
 */
export function billedUsageOf(u: UsageRecord | undefined): BilledUsage {
  return usageCountersOf(u)
}

const hasUsage = hasBilledTokens

/**
 * Flatten a record's content into plain text for estimation. Walks string
 * content and `text` / `thinking` blocks, tool-use input JSON, and
 * tool-result bodies — everything that contributes to the token footprint.
 */
function recordText(rec: SessionRecord): string {
  switch (rec.kind) {
    case "user":
      return blocksText(rec.content)
    case "assistant":
      return blocksText(rec.content)
    case "tool_result":
      return blocksText(rec.content)
    default:
      return ""
  }
}

/** Extract estimable text from string-or-blocks content. */
function blocksText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content
  const parts: string[] = []
  for (const b of content) {
    switch (b.type) {
      case "text":
        parts.push(b.text)
        break
      case "thinking":
        parts.push(b.thinking)
        break
      case "tool_use":
        // The serialized input is part of what the model produced / the API
        // counted. JSON.stringify is a fair proxy for its token weight.
        try {
          parts.push(JSON.stringify(b.input))
        } catch {
          // ignore unserializable input
        }
        break
      case "tool_result":
        parts.push(blocksText(b.content))
        break
      default:
        // image / document / redacted_thinking: no estimable text
        break
    }
  }
  return parts.join("\n")
}

/** Find the model id from the session's meta record, if present. */
function modelIdFromRecords(records: SessionRecord[]): string | undefined {
  const meta = records.find((r): r is MetaRecord => r.kind === "meta")
  return meta?.model
}

/**
 * Compute the token usage of a session from its records.
 *
 * The `opts` bag accepts `modelId`, which overrides the model used for
 * estimation. Defaults to the `meta` record's model. Only consulted on
 * the estimated path.
 *
 * @param records - Parsed session records (from `parseLines`). Order-independent.
 * @returns Aggregated {@link SessionUsage}.
 */
export function computeSessionUsage(
  records: SessionRecord[],
  opts: { modelId?: string } = {},
): SessionUsage {
  const assistantTurns = records.filter((r): r is AssistantRecord => r.kind === "assistant")
  if (assistantTurns.length === 0) return { ...ZERO_SESSION_USAGE }

  let billed: UsageCounters = billedUsageOf(undefined)
  let realTurns = 0
  for (const turn of assistantTurns) {
    if (hasUsage(turn.usage)) {
      billed = addUsageCounters(billed, billedUsageOf(turn.usage))
      realTurns += 1
    }
  }
  const { input, output, cacheRead, cacheCreate } = billed

  const allReal = realTurns === assistantTurns.length
  if (allReal) {
    return {
      tokens: input + output + cacheRead + cacheCreate,
      ...billed,
      estimated: false,
      turns: assistantTurns.length,
      realTurns,
    }
  }

  // Mixed path: keep real totals for turns with billed usage, estimate
  // missing turns from transcript text so one missing payload does not
  // discard every real counter. Estimated turns contribute 0 to the
  // billed sub-counters and their cost stays 0 (callers rely on that).
  const modelId = opts.modelId ?? modelIdFromRecords(records)
  const providerId = records.find((r): r is MetaRecord => r.kind === "meta")?.provider
  let estimatedTokens = 0
  let pendingText: string[] = []
  const estimateForText = (text: string): number => {
    if (providerId && modelId) {
      const scoped = findModelForProvider(modelId, providerId)
      if (scoped?.estimateTokens) return scoped.estimateTokens(text)
    }
    return estimateTokensForModel(modelId, text)
  }
  for (const rec of records) {
    if (rec.kind === "assistant") {
      const has = hasUsage(rec.usage)
      if (!has) {
        const text = [...pendingText, recordText(rec)].join("\n")
        if (text.length > 0) estimatedTokens += estimateForText(text)
      }
      pendingText = []
    } else {
      const t = recordText(rec)
      if (t.length > 0) pendingText.push(t)
    }
  }
  return {
    tokens: input + output + cacheRead + cacheCreate + estimatedTokens,
    ...billed,
    estimated: true,
    turns: assistantTurns.length,
    realTurns,
  }
}
