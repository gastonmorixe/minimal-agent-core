/**
 * The time limit rules of the Bash tool: the one source for the executor
 * (`tools.ts`) and for a host that shows the limit of a running call.
 * Pure: no I/O, no execution engine.
 *
 * @module tools/bash-timeout
 */

/** The time limit of a Bash call that gives no `timeout`. */
export const BASH_DEFAULT_TIMEOUT_MS = 120_000

/** The largest time limit of a Bash call. A larger `timeout` becomes this value. */
export const BASH_MAX_TIMEOUT_MS = 600_000

/** The time limit of one Bash call. */
export interface BashTimeout {
  readonly timeoutMs: number
  /** True when the input was more than {@link BASH_MAX_TIMEOUT_MS}. */
  readonly clamped: boolean
}

/**
 * The time limit for the `timeout` input of a Bash call. A Bash call always
 * has a limit.
 *
 * - Missing, not a finite number, or `<= 0`: {@link BASH_DEFAULT_TIMEOUT_MS}.
 * - More than {@link BASH_MAX_TIMEOUT_MS}: the maximum, with `clamped: true`.
 * - If not, the value with no change.
 *
 * @param input - The `timeout` value of the tool input, in milliseconds.
 */
export function resolveBashTimeout(input: unknown): BashTimeout {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return { timeoutMs: BASH_DEFAULT_TIMEOUT_MS, clamped: false }
  }
  if (input > BASH_MAX_TIMEOUT_MS) return { timeoutMs: BASH_MAX_TIMEOUT_MS, clamped: true }
  return { timeoutMs: input, clamped: false }
}
