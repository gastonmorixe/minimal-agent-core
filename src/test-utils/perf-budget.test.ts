/**
 * `perfBudgetMs` makes the budget larger only on CI.
 *
 * @module test-utils/perf-budget.test
 */

import { describe, expect, it } from "bun:test"

import { CI_PERF_BUDGET_FACTOR, perfBudgetMs } from "./perf-budget.ts"

describe("perfBudgetMs", () => {
  it("keeps the budget when CI is not set", () => {
    expect(perfBudgetMs(200, {})).toBe(200)
  })

  it("keeps the budget when CI is empty, false or 0", () => {
    for (const CI of ["", "false", "0"]) {
      expect(perfBudgetMs(200, { CI })).toBe(200)
    }
  })

  it("scales the budget when CI is set", () => {
    expect(CI_PERF_BUDGET_FACTOR).toBe(5)
    for (const CI of ["true", "1", "yes"]) {
      expect(perfBudgetMs(200, { CI })).toBe(1000)
    }
  })

  it("reads process.env by default", () => {
    const expected = perfBudgetMs(200, process.env)
    expect(perfBudgetMs(200)).toBe(expected)
  })
})
