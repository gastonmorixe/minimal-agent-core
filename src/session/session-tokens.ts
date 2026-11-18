/**
 * Session-scoped accumulator of provider token usage.
 *
 * Every successful API call returns one {@link UsageRecord}. The canonical
 * transport (`llm/transport/canonical-send.ts`) calls {@link addSessionUsage}
 * with it. The `quota-status` plugin reads
 * {@link getSessionTokens} to render "tokens this session" in the
 * sticky-bottom footer.
 *
 * The process counters are a module-level singleton, scoped to the agent
 * process. Tests `clearSessionTokens()` between cases to prevent state leak.
 * A run in a session scope (`infra/session-scope.ts`) also folds each record
 * into the counter of its own session.
 *
 * @module session-tokens
 */

import { currentSessionScope } from "../infra/session-scope.ts"
import { type UsageRecord, usageCountersOf } from "../llm/codec/usage-record.ts"
import { findModel, findModelForProvider } from "../llm/model-registry.ts"

function shouldIncludeOutputInContextSize(): boolean {
  return outputSharesContextWindow(
    process.env.MINIMAL_AGENT_MODEL ?? "",
    process.env.MINIMAL_AGENT_PROVIDER || undefined,
  )
}

export interface SessionTokens {
  /** New input tokens (not served from cache). Cumulative across turns. */
  input: number
  /** Output (generated) tokens. Cumulative across turns. */
  output: number
  /**
   * Cumulative `cache_read_input_tokens` across all turns.
   *
   * ⚠️ Inherently inflated as a "session footprint" number. Anthropic's
   * cache hits re-serve the SAME cached prefix on every subsequent turn,
   * so summing per-turn `cache_read` ≈ ∫ context_size dt, not "how much
   * cached content exists." Useful for debug / anomaly detection only;
   * for any user-facing display, prefer {@link contextSize}.
   */
  cacheRead: number
  /** Input tokens written to cache (expensive once, then read cheaply). Cumulative. */
  cacheCreate: number
  /** Of {@link cacheCreate}, the writes with the 1 hour TTL. Cumulative. */
  cacheCreate1h: number
  /** Thinking tokens. Already counted in {@link output}. Cumulative. */
  thinking: number
  /** Billed server web-search calls. Cumulative. */
  webSearchRequests: number
  /**
   * Sum of all four cumulative fields.
   *
   * ⚠️ Inherits the inflation from {@link cacheRead}. Kept for backwards
   * compatibility / debug — do NOT use as a user-facing "tokens this
   * session" number. Use {@link contextSize} instead.
   */
  total: number
  /** Number of API responses contributing to these totals. */
  turns: number
  /**
   * Latest turn's footprint in the model's context window. For
   * Anthropic-style models (`outputTokensShareContextWindow: false`) this
   * is `input + cacheRead + cacheCreate` (prefill size). For OpenAI-style
   * models that share the window it also includes `output` so the bar
   * reflects `prompt_tokens + completion_tokens` as a single budget.
   *
   * Replace-not-accumulate semantics — overwritten on every
   * {@link addSessionUsage} / {@link addSessionEstimatedUsage} call.
   * The `quota-status` footer renders `contextSize / contextWindow`.
   */
  contextSize: number
  /**
   * True when {@link contextSize} was derived from an estimate rather
   * than billed provider `usage` (provider omitted `usage`, offline
   * transcript fallback). Renderers may show a `~` marker.
   */
  contextSizeEstimated: boolean
}

function zeroTotals(): SessionTokens {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheCreate: 0,
    cacheCreate1h: 0,
    thinking: 0,
    webSearchRequests: 0,
    total: 0,
    turns: 0,
    contextSize: 0,
    contextSizeEstimated: false,
  }
}

/**
 * One set of token counters. The process has one ({@link getSessionTokens}).
 * A session scope (`infra/session-scope.ts`) has one more for its session
 * only, so a process with many sessions can give each one its own totals.
 */
export class SessionTokenCounter {
  private totals: SessionTokens = zeroTotals()

  /**
   * Make a counter with every total at zero.
   *
   * @param includeOutput - True when the output tokens share the context
   *   window of the live model. Read at each usage record, so a model switch
   *   takes effect at once. Default: the model of the process env.
   */
  constructor(private readonly includeOutput: () => boolean = shouldIncludeOutputInContextSize) {}

  /** Fold one response's usage record into the totals. No-op on `undefined`. */
  addUsage(u: UsageRecord | undefined): void {
    if (!u) return
    const c = usageCountersOf(u)
    const totals = this.totals
    totals.input += c.input
    totals.output += c.output
    totals.cacheRead += c.cacheRead
    totals.cacheCreate += c.cacheCreate
    totals.cacheCreate1h += c.cacheCreate1h
    totals.thinking += c.thinking
    totals.webSearchRequests += c.webSearchRequests
    // Thinking and the 1h split are sub-counts, so they are not added again.
    totals.total += c.input + c.output + c.cacheRead + c.cacheCreate
    totals.turns += 1
    // Replace-not-accumulate: this is the LATEST turn's footprint.
    // Anthropic-style models count only the input side (prefill);
    // OpenAI-style models share the window with output, so we include it.
    const prefill = c.input + c.cacheRead + c.cacheCreate
    totals.contextSize = this.includeOutput() ? prefill + c.output : prefill
    totals.contextSizeEstimated = false
  }

  /** Record an estimated turn (see {@link addSessionEstimatedUsage}). */
  addEstimated(estimatedTokens: number): void {
    if (!Number.isFinite(estimatedTokens) || estimatedTokens <= 0) return
    const n = Math.ceil(estimatedTokens)
    this.totals.total += n
    this.totals.turns += 1
    this.totals.contextSize = n
    this.totals.contextSizeEstimated = true
  }

  /** A copy of the totals, safe to mutate. */
  snapshot(): SessionTokens {
    return { ...this.totals }
  }

  /** Reset every counter to zero. */
  clear(): void {
    this.totals = zeroTotals()
  }
}

/** True when the output tokens of `modelId` share its context window. */
export function outputSharesContextWindow(modelId: string, providerId?: string): boolean {
  const id = modelId.replace(/\[(1|2)m\]/gi, "")
  if (!id) return false
  const entry = providerId ? (findModelForProvider(id, providerId) ?? findModel(id)) : findModel(id)
  return entry?.capabilities.outputTokensShareContextWindow === true
}

const processCounter = new SessionTokenCounter()

/**
 * Fold one response's usage record into the process totals, and into the
 * totals of the current session scope when a scoped run is in progress.
 * No-op on `undefined`.
 */
export function addSessionUsage(u: UsageRecord | undefined): void {
  processCounter.addUsage(u)
  currentSessionScope()?.tokens.addUsage(u)
}

/**
 * Record an estimated turn when the provider omitted `usage` (ollama,
 * cursor, generic gateways). Keeps the live context bar from staying
 * at 0% while the transcript grows. Also goes to the current session scope.
 *
 * `estimatedTokens` should already be scoped to the active model
 * (via `estimateTokensForModel` / provider `estimateTokens`).
 */
export function addSessionEstimatedUsage(estimatedTokens: number): void {
  processCounter.addEstimated(estimatedTokens)
  currentSessionScope()?.tokens.addEstimated(estimatedTokens)
}

/**
 * Snapshot of the process-wide token totals (a defensive copy, safe to
 * mutate). In a process with many sessions this is the sum of all of them:
 * read the session scope counter for one session.
 */
export function getSessionTokens(): SessionTokens {
  return processCounter.snapshot()
}

/**
 * Resets every process counter to zero. Called when a new session starts (or
 * a resume re-seeds usage) so totals never leak across sessions.
 */
export function clearSessionTokens(): void {
  processCounter.clear()
}
