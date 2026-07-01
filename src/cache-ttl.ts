/**
 * Resolve the cache-control TTL used on the agent's prompt-cache breakpoints.
 *
 * Every ephemeral cache breakpoint the agent sets (the two static
 * system-prompt breakpoints in `src/llm/system-prompt.ts` and the rolling
 * tail breakpoint in `src/agent/cache.ts`) carries a `ttl`. Anthropic accepts
 * exactly two buckets: `"5m"` (the default) and `"1h"`. A longer TTL keeps the
 * cached prefix warm across slower turn cadences at a higher cache-write cost;
 * the shorter one is cheaper to write and is the right default for an
 * interactive session that keeps the prefix hot anyway.
 *
 * Precedence (highest wins), mirroring {@link resolveEffort}:
 *
 *     CLI flag (--cache-ttl)   \>   env (MINIMAL_AGENT_CACHE_TTL)   \>   config file
 *
 * Unlike effort (an opaque server-validated pass-through), the TTL surface is
 * a closed set the wire type enforces (`"5m" | "1h"`), so we DO validate here:
 * an unrecognized value at any layer is dropped, and resolution falls through
 * to the next source (ultimately {@link DEFAULT_CACHE_TTL}). Empty strings are
 * treated as unset (defensive against `MINIMAL_AGENT_CACHE_TTL=`).
 *
 * @module cache-ttl
 */

/** The two TTL buckets Anthropic's `cache_control.ttl` accepts. */
export type CacheTtl = "5m" | "1h"

/** Built-in default TTL for every cache breakpoint the agent sets. */
export const DEFAULT_CACHE_TTL: CacheTtl = "5m"

/** The set of accepted TTL values, in canonical order (for help/error text). */
export const KNOWN_CACHE_TTLS: readonly CacheTtl[] = ["5m", "1h"]

/** Narrow an arbitrary string to a {@link CacheTtl}, or `undefined` if invalid. */
export function normalizeCacheTtl(raw: string | undefined): CacheTtl | undefined {
  if (raw === "5m" || raw === "1h") return raw
  return undefined
}

export type CacheTtlSource = "cli" | "env" | "config" | "default"

export interface ResolveCacheTtlInput {
  /** Raw CLI value (after `--cache-ttl`), or undefined if not passed. */
  cli?: string
  /** Raw env value (`MINIMAL_AGENT_CACHE_TTL`), or undefined. */
  env?: string
  /** Config-file value (from `loadUserConfig`), or undefined. */
  config?: string
}

export interface ResolvedCacheTtl {
  ttl: CacheTtl
  source: CacheTtlSource
}

/**
 * Pick the effective cache TTL with precedence CLI over env over config file,
 * treating empty / unrecognized values as unset at each layer. Always resolves
 * to a concrete {@link CacheTtl}: when nothing valid is set anywhere the result
 * is {@link DEFAULT_CACHE_TTL} with source `"default"`.
 */
export function resolveCacheTtl(input: ResolveCacheTtlInput): ResolvedCacheTtl {
  const cli = normalizeCacheTtl(input.cli)
  if (cli) return { ttl: cli, source: "cli" }
  const env = normalizeCacheTtl(input.env)
  if (env) return { ttl: env, source: "env" }
  const config = normalizeCacheTtl(input.config)
  if (config) return { ttl: config, source: "config" }
  return { ttl: DEFAULT_CACHE_TTL, source: "default" }
}
