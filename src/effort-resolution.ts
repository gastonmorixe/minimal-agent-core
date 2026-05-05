/**
 * Resolve the `effort` (output_config.effort) setting from the three sources
 * we accept, with precedence:
 *
 *     CLI flag (--effort / -e)   >   env (MINIMAL_AGENT_EFFORT)   >   config file
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
 *  Not used for validation — the wire value is whatever the user passed. */
export const KNOWN_EFFORT: readonly string[] = ["low", "medium", "high", "max"]

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
