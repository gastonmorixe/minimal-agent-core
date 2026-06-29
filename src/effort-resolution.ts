/**
 * Resolve the `effort` (output_config.effort) setting from the three sources
 * we accept, with precedence:
 *
 *     CLI flag (--effort / -e)   \>   env (MINIMAL_AGENT_EFFORT)   \>   config file
 *
 * Pass-through philosophy: we do NOT validate the value. Whatever the user
 * passes is forwarded verbatim to `output_config.effort` on the wire. The
 * server is the source of truth on which effort levels are accepted; if a
 * value is rejected we surface the server's error rather than second-guess
 * here. This makes the flag forward-compatible with new effort levels
 * (e.g. `"ultra"`, `"insane"`) without a client-side release.
 *
 * Empty strings are treated as "unset" (defensive against
 * `MINIMAL_AGENT_EFFORT=`).
 *
 * The returned `source` lets the startup banner show provenance:
 * `(--effort)`, `(env)`, or `(config)`. `undefined` source means no effort
 * was set anywhere and the caller should fall back to the model default.
 */

export type Effort = string
/** Documentation-only list of levels known to the server at time of writing.
 *  Not used for validation — the wire value is whatever the user passed.
 *
 *  Per-model availability (as of 2026-05-28):
 *  - `low` / `medium` / `high`: opus-4-5+, opus-4-6, opus-4-7, opus-4-8, sonnet-4-6
 *  - `xhigh`: opus-4-7, opus-4-8 only (claude-code's REPL default for opus tier)
 *  - `max`:   opus-4-5+ only (gated by user subscription tier)
 *
 *  Sonnet 4.5 and haiku 4.5 reject `effort` outright with a 400. */
export const KNOWN_EFFORT: readonly string[] = ["low", "medium", "high", "xhigh", "max"]

export type EffortSource = "cli" | "env" | "config"

export interface ResolveEffortInput {
  /** Raw CLI value (after `--effort` or `-e`), or undefined if not passed. */
  cli?: string
  /** Raw env value (`MINIMAL_AGENT_EFFORT`), or undefined. */
  env?: string
  /** Config-file value (from `loadUserConfig`), or undefined. */
  config?: string
}

export interface ResolvedEffort {
  effort: Effort | undefined
  source: EffortSource | undefined
}

/**
 * Pick the effective effort value with precedence CLI over env over config
 * file, treating empty strings as unset. No validation is performed: the winning
 * raw string is forwarded to the server verbatim, and both value and source
 * come back `undefined` when nothing was set anywhere.
 */
export function resolveEffort(input: ResolveEffortInput): ResolvedEffort {
  if (input.cli !== undefined && input.cli !== "") {
    return { effort: input.cli, source: "cli" }
  }
  if (input.env !== undefined && input.env !== "") {
    return { effort: input.env, source: "env" }
  }
  if (input.config !== undefined && input.config !== "") {
    return { effort: input.config, source: "config" }
  }
  return { effort: undefined, source: undefined }
}

// ---------------------------------------------------------------------------
// Model-capability validation (startup-time, before the first request)
// ---------------------------------------------------------------------------

/** Result of validating a resolved effort against a model's declared levels. */
export interface EffortValidation {
  ok: boolean
  /** Human-readable reason when `ok` is false. */
  reason?: string
}

/**
 * Check whether `effort` is compatible with `modelEffortLevels`.
 *
 * Pure: no I/O, no globals. Call this at startup so a misconfigured effort
 * (e.g. `--effort low` on a model whose levels are `["high", "max"]`) fails
 * fast with a clear message instead of surfacing as a cryptic
 * "unsupported capabilities: effort" on the first request.
 *
 * When `effort` is `undefined` the model default applies, so validation
 * always passes. When the model declares no effort levels at all (a cheap /
 * fast-tier model), any explicit effort is a hard error.
 */
export function validateEffortForModel(
  effort: string | undefined,
  modelEffortLevels: readonly string[],
): EffortValidation {
  if (effort === undefined) return { ok: true }
  if (modelEffortLevels.length === 0) {
    return {
      ok: false,
      reason: `effort "${effort}" was requested but this model does not support reasoning effort`,
    }
  }
  if (!modelEffortLevels.includes(effort)) {
    return {
      ok: false,
      reason: `effort "${effort}" is not supported by this model (supported: ${modelEffortLevels.join(", ")})`,
    }
  }
  return { ok: true }
}
