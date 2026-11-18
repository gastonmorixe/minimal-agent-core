/**
 * Resolve the two prompt-cache feature flags of the send step.
 *
 * - `cacheAnchor` (F1): a second rolling `cache_control` marker on the
 *   message before the latest assistant message. Default ON. Turn it off
 *   with `--no-cache-anchor`, `MINIMAL_AGENT_CACHE_ANCHOR=0` or the config
 *   key `"cacheAnchor": false`.
 * - `thinkingHistory` (F2): `"strip"` (default, today's rule: drop the
 *   thinking of older assistant turns) or `"keep"` (send the history
 *   append-only, only for keep-all models on the Anthropic Messages wire).
 *
 * Precedence (highest wins), the same as {@link resolveCacheTtl}:
 *
 *     CLI flag   \>   env (MINIMAL_AGENT_CACHE_ANCHOR / MINIMAL_AGENT_THINKING_HISTORY)   \>   config file
 *
 * An unrecognized value at one layer is dropped, and resolution falls
 * through to the next layer.
 *
 * @module cache/cache-flags
 */

/** Where a resolved flag value came from. */
export type CacheFlagSource = "cli" | "env" | "config" | "default"

/** The thinking-history modes. */
export type ThinkingHistoryMode = "strip" | "keep"

/** The default thinking-history mode (today's behavior). */
export const DEFAULT_THINKING_HISTORY: ThinkingHistoryMode = "strip"

/** Narrow a raw value to a {@link ThinkingHistoryMode}, or `undefined`. */
export function normalizeThinkingHistory(raw: string | undefined): ThinkingHistoryMode | undefined {
  if (raw === "strip" || raw === "keep") return raw
  return undefined
}

/**
 * Narrow a raw boolean-ish value (`1|true|on|yes` / `0|false|off|no`, any
 * case) or a boolean to a boolean, or `undefined`.
 */
export function normalizeFlagBoolean(raw: string | boolean | undefined): boolean | undefined {
  if (typeof raw === "boolean") return raw
  const v = raw?.trim().toLowerCase()
  if (v === "1" || v === "true" || v === "on" || v === "yes") return true
  if (v === "0" || v === "false" || v === "off" || v === "no") return false
  return undefined
}

/** Raw inputs of {@link resolveCacheAnchor}. */
export interface ResolveCacheAnchorInput {
  /** `true` when `--cache-anchor` was passed, `false` for `--no-cache-anchor`. */
  cli?: boolean
  /** Raw `MINIMAL_AGENT_CACHE_ANCHOR`. */
  env?: string
  /** Config key `cacheAnchor`. */
  config?: boolean
}

/** The default of the anchor flag when no layer sets it (ON). */
export const DEFAULT_CACHE_ANCHOR = true

/** Pick the effective anchor flag (CLI over env over config, default ON). */
export function resolveCacheAnchor(input: ResolveCacheAnchorInput): {
  enabled: boolean
  source: CacheFlagSource
} {
  if (input.cli !== undefined) return { enabled: input.cli, source: "cli" }
  const env = normalizeFlagBoolean(input.env)
  if (env !== undefined) return { enabled: env, source: "env" }
  if (typeof input.config === "boolean") return { enabled: input.config, source: "config" }
  return { enabled: DEFAULT_CACHE_ANCHOR, source: "default" }
}

/** Raw inputs of {@link resolveThinkingHistory}. */
export interface ResolveThinkingHistoryInput {
  /** Raw `--thinking-history` value. */
  cli?: string
  /** Raw `MINIMAL_AGENT_THINKING_HISTORY`. */
  env?: string
  /** Config key `thinkingHistory`. */
  config?: string
}

/** Pick the effective thinking-history mode (CLI over env over config, default strip). */
export function resolveThinkingHistory(input: ResolveThinkingHistoryInput): {
  mode: ThinkingHistoryMode
  source: CacheFlagSource
} {
  const cli = normalizeThinkingHistory(input.cli)
  if (cli) return { mode: cli, source: "cli" }
  const env = normalizeThinkingHistory(input.env)
  if (env) return { mode: env, source: "env" }
  const config = normalizeThinkingHistory(input.config)
  if (config) return { mode: config, source: "config" }
  return { mode: DEFAULT_THINKING_HISTORY, source: "default" }
}
