/**
 * Onion-style policy middleware around a terminal async action.
 *
 * Composes `before` (may deny / rewrite) → `terminal` → `after` (observe).
 * Unit-testable without AgentCore.
 *
 * @module sdk/with-policy
 */

import { allowDecision, isDenied, type PolicyDecision } from "./lifecycle.ts"

export interface PolicyRunResult<TIn, TOut> {
  decision: PolicyDecision<TIn>
  /** Present only when the terminal ran (before allowed). */
  output?: TOut
}

/**
 * Compose a before/after pair into a single function over an input.
 *
 * - `before` deny → terminal is not called
 * - `before` allow → terminal runs with (possibly rewritten) payload
 * - `after` runs only when terminal completed
 */
export function runWithPolicy<TIn, TOut>(
  before: (input: TIn) => Promise<PolicyDecision<TIn>>,
  terminal: (input: TIn) => Promise<TOut>,
  after?: (input: TIn, output: TOut) => Promise<void> | void,
): (input: TIn) => Promise<PolicyRunResult<TIn, TOut>> {
  return async (input: TIn) => {
    const decision = await before(input)
    if (isDenied(decision)) {
      return { decision }
    }
    const payload = decision.action === "allow" ? decision.payload : input
    const output = await terminal(payload)
    if (after) await after(payload, output)
    return { decision: allowDecision(payload, decision.additionalContext), output }
  }
}
