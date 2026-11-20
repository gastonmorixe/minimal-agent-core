/**
 * Time budgets for perf tests.
 *
 * A shared CI runner (for example macos-latest with 3 vCPU) is much slower
 * and less stable than a developer machine. A local budget that passes with
 * a good margin can fail there for no code cause. Thus a perf test gets its
 * budget from `perfBudgetMs`, which makes the budget 5 times larger on CI.
 * The structural asserts of the test (reads, row counts) stay strict.
 *
 * @module test-utils/perf-budget
 */

/** The budget multiplier on CI. */
export const CI_PERF_BUDGET_FACTOR = 5

/**
 * Give the time budget for a perf test, in milliseconds.
 *
 * @param ms - The local budget.
 * @param env - The environment to read `CI` from. The default is `process.env`.
 * @returns `ms * 5` when `CI` is set to a non-empty value other than
 *   `"false"` or `"0"`. If not, `ms`.
 */
export function perfBudgetMs(ms: number, env: NodeJS.ProcessEnv = process.env): number {
  const ci = env.CI
  const onCi = ci !== undefined && ci !== "" && ci !== "false" && ci !== "0"
  return onCi ? ms * CI_PERF_BUDGET_FACTOR : ms
}
