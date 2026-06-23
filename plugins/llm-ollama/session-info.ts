/**
 * Ollama Cloud session metadata for the status bar.
 *
 * Ollama's native chat protocol does not return rate-limit / quota headers
 * (billing is subscription/account-level, not per-window), so this provider has
 * no quota windows to surface. {@link fetchOllamaSessionInfo} returns `{}` and
 * the host backfills the context window + compact model label from the registry.
 *
 * The adapter still accumulates token usage from each completed stream so the
 * footer can show per-session token totals; that lives in module-local state
 * here, read-only to the host.
 *
 * @module llm/providers/ollama/session-info
 */

import type {
  ProviderSessionContext,
  ProviderSessionInfo,
} from "@minimal-agent/plugin-api/llm/provider-plugin"

/** Accumulated usage from this session's Ollama responses. */
let sessionUsage: {
  inputTokens: number
  outputTokens: number
  at: number
} | null = null

/**
 * Accumulate token usage from a completed response. Called by the adapter after
 * each successful stream. Non-throwing.
 */
export function accumulateOllamaUsage(usage: { inputTokens: number; outputTokens: number }): void {
  if (sessionUsage) {
    sessionUsage.inputTokens += usage.inputTokens
    sessionUsage.outputTokens += usage.outputTokens
    sessionUsage.at = Date.now()
  } else {
    sessionUsage = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      at: Date.now(),
    }
  }
}

/** Read accumulated session usage. */
export function getOllamaSessionUsage(): typeof sessionUsage {
  return sessionUsage
}

/** Reset accumulated usage. Tests call this between cases so fixtures don't leak. */
export function clearOllamaSessionUsage(): void {
  sessionUsage = null
}

/**
 * Resolve Ollama Cloud session metadata for the status bar. Ollama reports no
 * quota windows, so this returns `{}` (context-only); the host synthesizes the
 * context-window + label segment from the registry. Cache-only, never throws,
 * honors `ctx.signal` trivially.
 */
export async function fetchOllamaSessionInfo(
  ctx: ProviderSessionContext,
): Promise<ProviderSessionInfo | null> {
  if (ctx.signal?.aborted) return {}
  return {}
}
