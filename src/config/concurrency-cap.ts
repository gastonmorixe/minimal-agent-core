/**
 * Resolve the concurrency cap: the largest number of tool calls that run at
 * the same time in a wave.
 *
 * Precedence (highest wins):
 *
 *     env (MINIMAL_AGENT_MAX_CONCURRENT_TOOL_CALLS)   \>   config (maxConcurrentToolCalls)   \>   default
 *
 * There is no CLI flag. A valid value is an integer of 1 or more. An invalid value at
 * a layer is ignored, and the resolution goes to the next layer. An empty env
 * value counts as not set. The value 1 gives the serial loop: each call runs
 * alone.
 *
 * Pure: the caller passes the env and config values.
 *
 * @module config/concurrency-cap
 */

/** The env name of the concurrency cap. */
export const MAX_CONCURRENT_TOOL_CALLS_ENV = "MINIMAL_AGENT_MAX_CONCURRENT_TOOL_CALLS"

/** The built-in default of the concurrency cap (1 = the serial loop). */
export const DEFAULT_MAX_CONCURRENT_TOOL_CALLS = 1

/** Where the resolved concurrency cap came from. */
export type MaxConcurrentToolCallsSource = "env" | "config" | "default"

/** The raw inputs of {@link resolveMaxConcurrentToolCalls}. */
export interface ResolveMaxConcurrentToolCallsInput {
  /** Raw env value (`MINIMAL_AGENT_MAX_CONCURRENT_TOOL_CALLS`), or undefined. */
  env?: string
  /** Config value (`UserConfig.maxConcurrentToolCalls`), or undefined. */
  config?: unknown
}

/** The resolved concurrency cap and its source. */
export interface ResolvedMaxConcurrentToolCalls {
  value: number
  source: MaxConcurrentToolCallsSource
}

/**
 * Give a config value as a concurrency cap, or `undefined` when it is not an
 * integer number of 1 or more. A string is not a valid config value.
 */
export function normalizeMaxConcurrentToolCalls(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 ? raw : undefined
}

/**
 * Give an env value as a concurrency cap, or `undefined` when it is not a
 * decimal integer of 1 or more (for example "4"). Spaces at the ends are ignored.
 */
export function parseMaxConcurrentToolCallsEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\s*\d+\s*$/.test(raw)) return undefined
  return normalizeMaxConcurrentToolCalls(Number(raw.trim()))
}

/**
 * Pick the concurrency cap: env over config over
 * {@link DEFAULT_MAX_CONCURRENT_TOOL_CALLS}. An invalid value at a layer is
 * ignored.
 */
export function resolveMaxConcurrentToolCalls(
  input: ResolveMaxConcurrentToolCallsInput,
): ResolvedMaxConcurrentToolCalls {
  const env = parseMaxConcurrentToolCallsEnv(input.env)
  if (env !== undefined) return { value: env, source: "env" }
  const config = normalizeMaxConcurrentToolCalls(input.config)
  if (config !== undefined) return { value: config, source: "config" }
  return { value: DEFAULT_MAX_CONCURRENT_TOOL_CALLS, source: "default" }
}
