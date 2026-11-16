/**
 * When a missing text checkout must FAIL instead of skip. Kept apart from
 * `text-fixture-providers.ts` (which loads the plugins at module load), so it
 * can be unit tested with no plugins checkout.
 *
 * @module test-utils/text-fixtures-required
 */

/** An environment to read: `process.env` by default, injectable for tests. */
export type FixtureEnv = Record<string, string | undefined>

/**
 * The setting that makes a missing text checkout fail, as text for the error
 * message: `MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES=1`, or `CI=<value>` with the
 * raw value (any value but empty, `0` or `false`, case and spaces ignored).
 * `null` when neither is set, so the guarded tests skip.
 */
export function textFixturesTrigger(env: FixtureEnv = process.env): string | null {
  if (env.MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES === "1") {
    return "MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES=1"
  }
  const raw = env.CI
  const ci = raw?.trim().toLowerCase()
  if (ci === undefined || ci === "" || ci === "0" || ci === "false") return null
  return `CI=${raw}`
}

/**
 * True when a missing text checkout must FAIL instead of skip:
 * `MINIMAL_AGENT_REQUIRE_TEXT_FIXTURES=1`, or `CI` set (any value but
 * empty, `0` or `false`). See {@link textFixturesTrigger}.
 */
export function textFixturesRequired(env: FixtureEnv = process.env): boolean {
  return textFixturesTrigger(env) !== null
}
