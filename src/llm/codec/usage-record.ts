/**
 * The persisted per-response token usage record, and its codec.
 *
 * One provider response (one API request) gets one {@link UsageRecord}. It is
 * written on `AssistantRecord.usage` in the session JSONL, returned on
 * `StreamedResponse.usage`, and folded into the live session totals.
 *
 * The field names follow the Anthropic Messages `usage` object. That is the
 * on-disk shape since the first session file, so old sessions stay readable.
 * Every field is optional: a reader must treat a missing field as 0.
 *
 * Breakdowns the provider reports:
 *
 * 1. Input is three disjoint counters: `input_tokens` (uncached),
 *    `cache_read_input_tokens`, `cache_creation_input_tokens`.
 * 2. `cache_creation` splits the cache writes by TTL (5m and 1h are priced
 *    differently). Its two values add up to `cache_creation_input_tokens`.
 * 3. `output_tokens_details.thinking_tokens` is the part of `output_tokens`
 *    spent on thinking. It is a SUBSET of `output_tokens`, never extra.
 * 4. `server_tool_use.web_search_requests` counts billed server searches.
 *
 * No provider reports tokens per content block (text vs tool_use) or per user
 * turn. See research/2026-11-15-anthropic-token-usage-breakdown.
 *
 * @module llm/codec/usage-record
 */

import type { CanonicalUsage } from "../canonical-events.ts"

/** Token usage of one provider response, as persisted. */
export interface UsageRecord {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  /** Cache writes by TTL. Sums to `cache_creation_input_tokens`. */
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
  /** Output detail. `thinking_tokens` is part of `output_tokens`. */
  output_tokens_details?: {
    thinking_tokens?: number
  }
  /** Billed server-side tool calls. */
  server_tool_use?: {
    web_search_requests?: number
  }
}

/** A {@link UsageRecord} with every counter resolved (missing = 0). */
export interface UsageCounters {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  /** Cache writes with the 1 hour TTL. The rest of `cacheCreate` is 5 minute. */
  cacheCreate1h: number
  /** Thinking tokens. Already counted in `output`. */
  thinking: number
  webSearchRequests: number
}

/** All-zero {@link UsageCounters}. */
export const ZERO_USAGE_COUNTERS: Readonly<UsageCounters> = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheCreate: 0,
  cacheCreate1h: 0,
  thinking: 0,
  webSearchRequests: 0,
})

/**
 * Map a canonical usage snapshot to the persisted record. Only counters the
 * provider reported are written, so an absent field stays absent on disk.
 */
export function usageRecordFromCanonical(u: CanonicalUsage): UsageRecord {
  const rec: UsageRecord = {
    input_tokens: u.inputTokens,
    output_tokens: u.outputTokens,
  }
  if (u.cacheReadTokens !== undefined) rec.cache_read_input_tokens = u.cacheReadTokens
  if (u.cacheCreationTokens !== undefined) rec.cache_creation_input_tokens = u.cacheCreationTokens
  const split = u.cacheBreakdown
  if (split && (split.fiveMinute !== undefined || split.oneHour !== undefined)) {
    rec.cache_creation = {}
    if (split.fiveMinute !== undefined)
      rec.cache_creation.ephemeral_5m_input_tokens = split.fiveMinute
    if (split.oneHour !== undefined) rec.cache_creation.ephemeral_1h_input_tokens = split.oneHour
  }
  if (u.reasoningTokens !== undefined) {
    rec.output_tokens_details = { thinking_tokens: u.reasoningTokens }
  }
  if (u.webSearchRequests !== undefined) {
    rec.server_tool_use = { web_search_requests: u.webSearchRequests }
  }
  return rec
}

/** Map a persisted record back to a canonical usage snapshot (for pricing). */
export function usageRecordToCanonical(rec: UsageRecord): CanonicalUsage {
  const u: CanonicalUsage = {
    inputTokens: rec.input_tokens ?? 0,
    outputTokens: rec.output_tokens ?? 0,
  }
  if (rec.cache_read_input_tokens !== undefined) u.cacheReadTokens = rec.cache_read_input_tokens
  if (rec.cache_creation_input_tokens !== undefined) {
    u.cacheCreationTokens = rec.cache_creation_input_tokens
  }
  if (rec.cache_creation) {
    u.cacheBreakdown = {
      fiveMinute: rec.cache_creation.ephemeral_5m_input_tokens,
      oneHour: rec.cache_creation.ephemeral_1h_input_tokens,
    }
  }
  const thinking = rec.output_tokens_details?.thinking_tokens
  if (thinking !== undefined) u.reasoningTokens = thinking
  const searches = rec.server_tool_use?.web_search_requests
  if (searches !== undefined) u.webSearchRequests = searches
  return u
}

/** Resolve a persisted record to plain counters. `undefined` gives all zeros. */
export function usageCountersOf(rec: UsageRecord | undefined): UsageCounters {
  if (!rec) return { ...ZERO_USAGE_COUNTERS }
  return {
    input: rec.input_tokens ?? 0,
    output: rec.output_tokens ?? 0,
    cacheRead: rec.cache_read_input_tokens ?? 0,
    cacheCreate: rec.cache_creation_input_tokens ?? 0,
    cacheCreate1h: rec.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    thinking: rec.output_tokens_details?.thinking_tokens ?? 0,
    webSearchRequests: rec.server_tool_use?.web_search_requests ?? 0,
  }
}

/** Add two counter sets. */
export function addUsageCounters(a: UsageCounters, b: UsageCounters): UsageCounters {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreate: a.cacheCreate + b.cacheCreate,
    cacheCreate1h: a.cacheCreate1h + b.cacheCreate1h,
    thinking: a.thinking + b.thinking,
    webSearchRequests: a.webSearchRequests + b.webSearchRequests,
  }
}

/**
 * True when the record reports any billed token. Thinking and the cache
 * split are sub-counts of other fields, so they are not checked.
 */
export function hasBilledTokens(rec: UsageRecord | undefined): rec is UsageRecord {
  if (!rec) return false
  return (
    (rec.input_tokens ?? 0) > 0 ||
    (rec.output_tokens ?? 0) > 0 ||
    (rec.cache_read_input_tokens ?? 0) > 0 ||
    (rec.cache_creation_input_tokens ?? 0) > 0
  )
}
