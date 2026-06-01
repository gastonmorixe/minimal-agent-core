/**
 * Token-usage statistics across ALL saved sessions, bucketed by time period
 * and broken down by provider and model.
 *
 * This is the data engine behind the `usage` CLI command and the `/usage`
 * live-area overlay. It reuses the per-turn primitives from
 * `session-usage.ts` (real billed usage vs estimated-from-text) and the
 * provider/pricing metadata in the model registry, so "what did I spend"
 * answers stay consistent with the `--sessions` listing column.
 *
 * Pipeline:
 *   1. {@link scanUsageEvents} reads every `<sid>.jsonl`, emitting one
 *      {@link UsageEvent} per assistant turn (real or estimated, timestamped).
 *   2. {@link aggregateUsage} filters events to a {@link UsagePeriod} window
 *      and folds them into a {@link UsageReport}: totals + per-provider +
 *      per-model breakdowns.
 *
 * Both halves are pure given their inputs (the scanner takes a directory; a
 * file-free `collectSessionEvents` is exposed for tests). No TUI, no clock
 * baked in — the caller passes `nowMs`.
 *
 * @module usage-stats
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import type { CanonicalUsage } from "./llm/canonical-events.ts"
import { findModel } from "./llm/model-registry.ts"
import { calculateUsageCost } from "./llm/pricing.ts"
import { estimateTokensForModel } from "./llm/token-estimate.ts"
import {
  defaultSessionsDir,
  type MetaRecord,
  parseLines,
  type SessionRecord,
} from "./session-store.ts"
import { billedUsageOf } from "./session-usage.ts"

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/** The selectable look-back windows. Each is an independent filter ending "now". */
export type UsagePeriod = "today" | "last-day" | "last-month" | "ytd" | "year" | "all"

/** Ordered list of periods with short display labels, for the interactive switcher. */
export const USAGE_PERIODS: ReadonlyArray<{ id: UsagePeriod; label: string }> = [
  { id: "today", label: "Today" },
  { id: "last-day", label: "Last 24h" },
  { id: "last-month", label: "Last 30d" },
  { id: "ytd", label: "YTD" },
  { id: "year", label: "Last year" },
  { id: "all", label: "All time" },
]

/** Map a free-form CLI token to a {@link UsagePeriod}. Returns null on no match. */
export function parseUsagePeriod(raw: string | undefined): UsagePeriod | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase()
  switch (s) {
    case "today":
    case "day0":
      return "today"
    case "last-day":
    case "lastday":
    case "24h":
    case "1d":
    case "day":
      return "last-day"
    case "last-month":
    case "lastmonth":
    case "month":
    case "30d":
    case "1m":
      return "last-month"
    case "ytd":
    case "year-to-date":
      return "ytd"
    case "year":
    case "1y":
    case "365d":
    case "last-year":
      return "year"
    case "all":
    case "alltime":
    case "all-time":
      return "all"
    default:
      return null
  }
}

/**
 * Inclusive lower bound (epoch ms) for a period's window, given "now".
 * Events with `tsMs >= start` are in the window. `all` returns 0.
 *
 * `today` and `ytd` snap to LOCAL calendar boundaries (midnight, Jan 1);
 * the rolling windows (`last-day`, `last-month`, `year`) subtract a fixed
 * span from `nowMs`.
 */
export function periodStartMs(period: UsagePeriod, nowMs: number): number {
  const DAY = 86_400_000
  switch (period) {
    case "today": {
      const d = new Date(nowMs)
      d.setHours(0, 0, 0, 0)
      return d.getTime()
    }
    case "last-day":
      return nowMs - DAY
    case "last-month":
      return nowMs - 30 * DAY
    case "ytd": {
      const d = new Date(nowMs)
      return new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0).getTime()
    }
    case "year":
      return nowMs - 365 * DAY
    case "all":
      return 0
    default: {
      const _exhaustive: never = period
      throw new Error(`unhandled period: ${_exhaustive}`)
    }
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * One assistant turn's contribution to usage, timestamped and attributed
 * to a model + provider. `estimated` distinguishes the real-billed path
 * (exact counters + cost) from the estimated-from-text fallback (a single
 * `tokens` magnitude, `costUSD: 0`).
 */
export interface UsageEvent {
  /** Epoch ms of the turn (assistant record ts; falls back to session createdAt). */
  tsMs: number
  /** Raw model id from the session meta (may carry a `[1m]` suffix). */
  modelId: string
  /** Resolved provider id, or `"unknown"` for an unregistered model. */
  providerId: string
  /** New input tokens (real path only). */
  input: number
  /** Output tokens (real path only). */
  output: number
  /** Cache-read tokens (real path only). */
  cacheRead: number
  /** Cache-creation tokens (real path only). */
  cacheCreate: number
  /**
   * Headline token count for this turn: the sum of the four billed counters
   * (real path) OR the estimated content size (estimated path).
   */
  tokens: number
  /** True when {@link tokens} was estimated from text, not read from saved usage. */
  estimated: boolean
  /** Exact USD cost (real path, via the model's pricing table). 0 when estimated. */
  costUSD: number
}

/** Flatten record content into estimable text (mirrors session-usage's walk). */
function recordText(rec: SessionRecord): string {
  if (rec.kind === "user" || rec.kind === "assistant" || rec.kind === "tool_result") {
    const content = rec.content
    if (typeof content === "string") return content
    const parts: string[] = []
    for (const b of content) {
      if (b.type === "text") parts.push(b.text)
      else if (b.type === "thinking") parts.push(b.thinking)
      else if (b.type === "tool_use") {
        try {
          parts.push(JSON.stringify(b.input))
        } catch {
          /* ignore */
        }
      } else if (b.type === "tool_result") {
        const inner = b.content
        parts.push(typeof inner === "string" ? inner : "")
      }
    }
    return parts.join("\n")
  }
  return ""
}

/** Parse an ISO timestamp to epoch ms, falling back to `fallbackMs` on garbage. */
function tsToMs(ts: string | undefined, fallbackMs: number): number {
  if (!ts) return fallbackMs
  const t = Date.parse(ts)
  return Number.isFinite(t) ? t : fallbackMs
}

/** True when a usage payload reports at least one non-zero counter. */
function hasRealUsage(u: ReturnType<typeof billedUsageOf>): boolean {
  return u.input > 0 || u.output > 0 || u.cacheRead > 0 || u.cacheCreate > 0
}

/**
 * Produce one {@link UsageEvent} per assistant turn for a single parsed
 * session. Real turns (with saved billed usage) emit exact events; turns
 * lacking usage emit an estimated event whose `tokens` is the estimate of
 * that turn's own output PLUS the non-assistant records since the previous
 * assistant turn (the context that turn consumed). This keeps per-turn
 * timestamps accurate while approximating the session's content footprint.
 *
 * @param records - Parsed records of ONE session (from `parseLines`).
 * @param modelHint - Override the model id (defaults to the meta record's).
 * @returns Per-turn usage events (possibly empty).
 */
export function collectSessionEvents(records: SessionRecord[], modelHint?: string): UsageEvent[] {
  const meta = records.find((r): r is MetaRecord => r.kind === "meta")
  const rawModelId = modelHint ?? meta?.model ?? "unknown"
  const entry = findModel(rawModelId)
  // Normalize to the canonical registered id so aliases merge in the
  // breakdown (e.g. `claude-opus-4-8[1m]` → `claude-opus-4-8`, and the
  // `claude-sonnet-4-5` alias → its dated canonical id). Unregistered /
  // forward-compat ids pass through verbatim.
  const modelId = entry?.id ?? rawModelId
  const providerId = entry?.providerId ?? "unknown"
  const pricing = entry?.pricing
  const createdMs = tsToMs(meta?.createdAt, Date.now())

  const events: UsageEvent[] = []
  // Text accumulated since the last assistant turn (user prompts + tool
  // results), attributed to the NEXT assistant turn on the estimated path.
  let pendingText: string[] = []

  for (const rec of records) {
    if (rec.kind === "assistant") {
      const tsMs = tsToMs(rec.ts, createdMs)
      const billed = billedUsageOf(rec.usage)
      if (hasRealUsage(billed)) {
        const tokens = billed.input + billed.output + billed.cacheRead + billed.cacheCreate
        events.push({
          tsMs,
          modelId,
          providerId,
          input: billed.input,
          output: billed.output,
          cacheRead: billed.cacheRead,
          cacheCreate: billed.cacheCreate,
          tokens,
          estimated: false,
          costUSD: pricing ? costOf(billed, pricing) : 0,
        })
      } else {
        // Estimated: this turn's own text + the context since the last turn.
        const text = [...pendingText, recordText(rec)].join("\n")
        const tokens = estimateTokensForModel(modelId, text)
        events.push({
          tsMs,
          modelId,
          providerId,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheCreate: 0,
          tokens,
          estimated: true,
          costUSD: 0,
        })
      }
      pendingText = []
    } else {
      const t = recordText(rec)
      if (t.length > 0) pendingText.push(t)
    }
  }
  return events
}

/** Exact USD cost of a billed-usage payload at a given pricing rate. */
function costOf(
  billed: ReturnType<typeof billedUsageOf>,
  pricing: NonNullable<ReturnType<typeof findModel>>["pricing"],
): number {
  const usage: CanonicalUsage = {
    inputTokens: billed.input,
    outputTokens: billed.output,
    cacheReadTokens: billed.cacheRead,
    cacheCreationTokens: billed.cacheCreate,
  }
  return calculateUsageCost(usage, pricing).totalUSD
}

/**
 * Scan a sessions directory, reading every `<sid>.jsonl` and emitting all
 * per-turn {@link UsageEvent}s across every session. Skips `index.jsonl`
 * and unreadable / unparseable files (best-effort: one bad file never
 * aborts the scan). Events are returned unsorted; the aggregator filters
 * by timestamp, so order doesn't matter.
 *
 * @param dir - Sessions directory. Defaults to `~/.minimal-agent/sessions`.
 */
export function scanUsageEvents(dir: string = defaultSessionsDir()): UsageEvent[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const events: UsageEvent[] = []
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue
    if (name === "index.jsonl") continue
    try {
      const text = readFileSync(join(dir, name), "utf-8")
      const { records } = parseLines(text)
      events.push(...collectSessionEvents(records))
    } catch {
      // best-effort: skip a vanished / unreadable / malformed file
    }
  }
  return events
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Folded totals for a set of events. */
export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheCreate: number
  /** Sum of {@link UsageEvent.tokens} across the set. */
  tokens: number
  /** Sum of exact USD cost (real events only; estimated contribute 0). */
  costUSD: number
  /** Number of assistant turns counted. */
  turns: number
  /** Of {@link turns}, how many were estimated (no saved billed usage). */
  estimatedTurns: number
}

/** A named breakdown row (per provider or per model) with its totals. */
export interface UsageBreakdownRow {
  /** Provider id or model id. */
  key: string
  totals: UsageTotals
}

/** Full usage report for one period: totals + provider + model breakdowns. */
export interface UsageReport {
  period: UsagePeriod
  /** Window lower bound (epoch ms); 0 for `all`. */
  startMs: number
  /** "Now" the report was computed against (epoch ms). */
  nowMs: number
  totals: UsageTotals
  /** Per-provider rows, sorted by tokens descending. */
  byProvider: UsageBreakdownRow[]
  /** Per-model rows, sorted by tokens descending. */
  byModel: UsageBreakdownRow[]
  /** True when ANY counted turn was estimated. Drives the `[E]`/mixed marker. */
  estimated: boolean
}

function emptyTotals(): UsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    tokens: 0,
    costUSD: 0,
    turns: 0,
    estimatedTurns: 0,
  }
}

function foldInto(acc: UsageTotals, e: UsageEvent): void {
  acc.input += e.input
  acc.output += e.output
  acc.cacheRead += e.cacheRead
  acc.cacheCreate += e.cacheCreate
  acc.tokens += e.tokens
  acc.costUSD += e.costUSD
  acc.turns += 1
  if (e.estimated) acc.estimatedTurns += 1
}

function rowsFromMap(m: Map<string, UsageTotals>): UsageBreakdownRow[] {
  return [...m.entries()]
    .map(([key, totals]) => ({ key, totals }))
    .sort((a, b) => b.totals.tokens - a.totals.tokens || a.key.localeCompare(b.key))
}

/**
 * Filter `events` to the `period` window (relative to `nowMs`) and fold them
 * into a {@link UsageReport}: grand totals plus per-provider and per-model
 * breakdown rows (each sorted by tokens descending).
 */
export function aggregateUsage(
  events: UsageEvent[],
  period: UsagePeriod,
  nowMs: number = Date.now(),
): UsageReport {
  const startMs = periodStartMs(period, nowMs)
  const totals = emptyTotals()
  const byProvider = new Map<string, UsageTotals>()
  const byModel = new Map<string, UsageTotals>()

  for (const e of events) {
    if (e.tsMs < startMs) continue
    foldInto(totals, e)
    const p = byProvider.get(e.providerId) ?? emptyTotals()
    foldInto(p, e)
    byProvider.set(e.providerId, p)
    const m = byModel.get(e.modelId) ?? emptyTotals()
    foldInto(m, e)
    byModel.set(e.modelId, m)
  }

  return {
    period,
    startMs,
    nowMs,
    totals,
    byProvider: rowsFromMap(byProvider),
    byModel: rowsFromMap(byModel),
    estimated: totals.estimatedTurns > 0,
  }
}

/**
 * Convenience: compute reports for EVERY period from one scan, so the
 * interactive overlay can switch periods without re-reading disk.
 *
 * @param events - All events (from {@link scanUsageEvents}).
 * @param nowMs - "Now".
 * @returns A map keyed by period id.
 */
export function aggregateAllPeriods(
  events: UsageEvent[],
  nowMs: number = Date.now(),
): Record<UsagePeriod, UsageReport> {
  const out = {} as Record<UsagePeriod, UsageReport>
  for (const { id } of USAGE_PERIODS) out[id] = aggregateUsage(events, id, nowMs)
  return out
}
