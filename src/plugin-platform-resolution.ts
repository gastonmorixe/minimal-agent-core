/**
 * Resolve the EFFECTIVE platform the plugin loader gates `platforms`
 * whitelists against, with precedence:
 *
 *     CLI flag (--platform)   \>   env (MINIMAL_AGENT_PLATFORM)   \>   detected
 *
 * The detected platform comes from `process.platform` via
 * {@link detectPlatform}. A user-supplied override (env or CLI) is run
 * through {@link normalizePlatform}, which forgives aliases (`darwin`,
 * `unix`, `win32`, …) and accepts the `all` bypass that disables platform
 * gating for the session. An unrecognized override is ignored (falls
 * through to the next source) and reported via `source: "invalid"` so the
 * caller can warn.
 *
 * Pure: the only impurity is the default `detectPlatform()` reading
 * `process.platform`, which the caller can override for tests. Mirrors
 * {@link resolveEffort} / {@link resolvePluginEnabledOverrides}.
 *
 * @module plugin-platform-resolution
 */

import {
  detectPlatform,
  type NormalizedPlatform,
  normalizePlatform,
} from "@minimal-agent/plugin-api/utils/platform"

/** Where the effective platform value came from (for banner/provenance). */
export type PlatformSource = "cli" | "env" | "detected"

export interface ResolveEffectivePlatformInput {
  /** Raw CLI value (after `--platform`), or undefined if not passed. */
  cli?: string
  /** Raw env value (`MINIMAL_AGENT_PLATFORM`), or undefined. */
  env?: string
  /** The host's detected platform. Defaults to {@link detectPlatform}. */
  detected?: NormalizedPlatform
}

export interface ResolvedEffectivePlatform {
  /** The platform (or `all` bypass) the loader should gate against. */
  platform: NormalizedPlatform
  /** Which source won. */
  source: PlatformSource
  /**
   * A raw override string that could NOT be normalized, if any. Present
   * only when an env/CLI value was supplied but unrecognized; the caller
   * may warn and the resolution falls through to the next source.
   */
  invalid?: string
}

/**
 * Pick the effective platform with precedence CLI over env over detected.
 * Empty strings are treated as unset. Unrecognized override tokens are
 * skipped (and reported via {@link ResolvedEffectivePlatform.invalid}),
 * never throwing — gating must always resolve to a usable platform.
 */
export function resolveEffectivePlatform(
  input: ResolveEffectivePlatformInput,
): ResolvedEffectivePlatform {
  const detected = input.detected ?? detectPlatform()

  // CLI wins, then env. Track the first unrecognized token for the warning.
  let invalid: string | undefined
  for (const [raw, source] of [
    [input.cli, "cli"],
    [input.env, "env"],
  ] as const) {
    if (raw === undefined || raw.trim() === "") continue
    const norm = normalizePlatform(raw)
    if (norm === null) {
      if (invalid === undefined) invalid = raw
      continue
    }
    return invalid !== undefined ? { platform: norm, source, invalid } : { platform: norm, source }
  }

  return invalid !== undefined
    ? { platform: detected, source: "detected", invalid }
    : { platform: detected, source: "detected" }
}
