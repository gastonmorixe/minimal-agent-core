/**
 * The prompt-cache policy of the send step (F1, F2, F2b), kept out of
 * {@link AgentCore} (max-lines budget).
 *
 * - F1 `cacheAnchor`: pass `anchor: true` to the rolling-breakpoint helper.
 *   Default ON: only an explicit `false` turns it off.
 * - F2 `thinkingHistory: "keep"`: do not strip older thinking, but ONLY when
 *   the model's capability data says it keeps all prior thinking
 *   (`capabilities.priorThinking === "keep-all"`) AND its wire takes explicit
 *   per-block cache markers (`capabilities.caching.explicit`). Core stays
 *   provider-neutral: the wire gate is data. Only the first-party Anthropic
 *   Messages provider plugin sets `priorThinking: "keep-all"`, so every other
 *   model (OpenAI shape, Ollama, Cursor, opencode, older Claude) keeps
 *   today's strip, whatever the flag.
 * - F2b: a 400 that rejects the kept thinking ("cannot be modified", or an
 *   invalid thinking `signature`) latches strip mode for the rest of the
 *   session. The send step then resends the same turn once with the strip.
 *
 * @module sdk/cache-send-policy
 */

import type { RollingCacheOptions } from "../agent/cache.ts"
import type { ThinkingHistoryMode } from "../cache/cache-flags.ts"
import type { Diagnostics } from "../diagnostics/hub.ts"

import { lookupModelEntry } from "./run-temperature.ts"

/** Per-session cache flags and the F2b latch. One object per {@link AgentCore}. */
export interface CacheSendState {
  readonly anchor: boolean
  readonly thinkingHistory: ThinkingHistoryMode
  /** Set by F2b after a thinking rejection: strip for the rest of the session. */
  stripLatched: boolean
}

/**
 * Build the state from the core config. The anchor defaults ON (undefined is
 * ON, only `false` is off). The thinking history defaults to strip.
 */
export function createCacheSendState(config: {
  cacheAnchor?: boolean
  thinkingHistory?: ThinkingHistoryMode
}): CacheSendState {
  return {
    anchor: config.cacheAnchor !== false,
    thinkingHistory: config.thinkingHistory === "keep" ? "keep" : "strip",
    stripLatched: false,
  }
}

/**
 * True when this send may keep the thinking of older turns: the flag is
 * `"keep"`, no F2b latch, and the model is a keep-all model on a wire with
 * explicit cache markers.
 */
export function keepsThinkingHistory(
  state: CacheSendState | undefined,
  model: string,
  providerId: string | undefined,
): boolean {
  if (!state || state.thinkingHistory !== "keep" || state.stripLatched) return false
  // No cross-provider lookup: an unknown provider keeps today's strip.
  if (providerId === undefined || providerId === "") return false
  const entry = lookupModelEntry(model, providerId)
  if (!entry || entry.capabilities.caching.explicit !== true) return false
  return entry.capabilities.priorThinking === "keep-all"
}

/** The options for `withRollingCacheBreakpoint` of one send. */
export function rollingCacheOptions(
  state: CacheSendState | undefined,
  keepThinking: boolean,
): RollingCacheOptions {
  const out: RollingCacheOptions = {}
  // No state (a caller without a core config) gets the default: anchor ON.
  if (state?.anchor !== false) out.anchor = true
  if (keepThinking) out.keepThinking = true
  return out
}

/** HTTP status of a thrown provider error, when it carries one. */
function errorStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) return undefined
  const e = err as { status?: unknown; opts?: { status?: unknown }; message?: unknown }
  if (typeof e.status === "number") return e.status
  if (typeof e.opts?.status === "number") return e.opts.status
  const m = typeof e.message === "string" ? /\bAPI (\d{3})\b/.exec(e.message) : null
  return m ? Number(m[1]) : undefined
}

/** The error text of a thrown value. */
export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message
  return typeof err === "string" ? err : String(err)
}

/**
 * True for an HTTP 400 that rejects thinking blocks: "... `thinking` or
 * `redacted_thinking` blocks ... cannot be modified", or a `signature` error
 * that also names thinking (a signature error that is not about thinking is
 * not matched).
 */
export function isThinkingHistoryRejection(err: unknown): boolean {
  if (errorStatus(err) !== 400) return false
  const text = errorText(err)
  if (/thinking/i.test(text) && /cannot be modified/i.test(text)) return true
  return /`?signature`?/i.test(text) && /thinking/i.test(text)
}

/** Max length of the server error text in the F2b warn. */
const WARN_ERROR_MAX_CHARS = 300

/** The error text cut to {@link WARN_ERROR_MAX_CHARS} characters. */
function truncateErrorText(text: string): string {
  return text.length <= WARN_ERROR_MAX_CHARS ? text : `${text.slice(0, WARN_ERROR_MAX_CHARS)}…`
}

/**
 * F2b. After a failed send that kept the thinking history: when the error is
 * a thinking rejection, latch strip mode, warn once, and return true (the
 * caller resends the same turn once). Else return false.
 */
export function latchStripAfterRejection(
  state: CacheSendState | undefined,
  err: unknown,
  diagnostics: Diagnostics,
  model: string,
): boolean {
  if (!state || state.stripLatched || !isThinkingHistoryRejection(err)) return false
  state.stripLatched = true
  diagnostics.warn(
    "cache.thinking-fallback",
    `kept thinking history rejected; retrying with strip for this session: ${truncateErrorText(errorText(err))}`,
    { model },
  )
  return true
}
