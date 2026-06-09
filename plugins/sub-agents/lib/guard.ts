/**
 * Spawn guardrail — the pure policy that decides whether a worker may be
 * spawned. This is the self-enforced half of the `subagent.willSpawn` chain
 * hook (Chain of Responsibility): the plugin evaluates its own caps here, and
 * any external listener can still veto on the bus.
 *
 * The whole point (Anthropic's multi-agent lesson): make spawning DELIBERATE.
 * Early multi-agent systems spawned 50 workers for a trivial query and
 * duplicated work. The caps below, plus a teaching refusal the model reads and
 * adapts to, keep a fleet honest.
 *
 * Pure: no IO. Returns a decision value, never throws.
 *
 * @module sub-agents/lib/guard
 */

/** Caps the plugin enforces before launching a worker. */
export interface GuardPolicy {
  /**
   * Maximum nesting depth. A worker's depth is its parent's + 1; the lead is
   * depth 0. `maxDepth: 1` means the lead may spawn workers but workers may NOT
   * spawn workers (the nesting ban that prevents runaway fan-out).
   */
  readonly maxDepth: number
  /** Max simultaneously-active workers per lead. */
  readonly maxConcurrent: number
  /** Max total spawns per lead over the session lifetime. */
  readonly maxTotal: number
  /** Spawnable worker types; `undefined`/empty = any type allowed. */
  readonly allowedTypes?: readonly string[]
}

/** The default policy: lead-only spawning, a modest fleet, generous lifetime. */
export const DEFAULT_POLICY: GuardPolicy = {
  maxDepth: 1,
  maxConcurrent: 8,
  maxTotal: 64,
}

/** The proposed spawn the guard evaluates. */
export interface GuardInput {
  /** The depth the NEW worker would have (parent depth + 1). */
  readonly childDepth: number
  /** Requested worker type (`"inline"` or a definition name). */
  readonly type: string
  /** Currently-active worker count for this lead. */
  readonly activeCount: number
  /** Total worker count ever spawned for this lead. */
  readonly totalCount: number
}

/** A guard verdict. Discriminated so callers handle both arms exhaustively. */
export type GuardDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string }

/**
 * Evaluate the policy against a proposed spawn. Order matters: the most
 * structural violation (nesting) is reported first, then runtime caps, then
 * the type allowlist, so the model gets the most actionable reason.
 */
export function evaluateSpawnGuard(
  input: GuardInput,
  policy: GuardPolicy = DEFAULT_POLICY,
): GuardDecision {
  if (input.childDepth > policy.maxDepth) {
    return {
      allowed: false,
      reason:
        `nesting limit reached (depth ${input.childDepth} > max ${policy.maxDepth}). ` +
        `You are a leaf worker and cannot spawn or delegate. Do not try to hand off ` +
        `this work. Do it yourself in this session with your own tools (Write, Edit, ` +
        `Bash, Read), then call ReportResult to hand back the result. If a unit is ` +
        `genuinely too big for one worker, that is the lead's call to decompose, not yours.`,
    }
  }
  if (input.activeCount >= policy.maxConcurrent) {
    return {
      allowed: false,
      reason:
        `concurrency limit reached (${input.activeCount}/${policy.maxConcurrent} active). ` +
        `Wait for a worker to finish (AgentResult) or stop one (StopAgent) before spawning more.`,
    }
  }
  if (input.totalCount >= policy.maxTotal) {
    return {
      allowed: false,
      reason:
        `total spawn limit reached (${input.totalCount}/${policy.maxTotal} for this session). ` +
        `This cap guards against runaway delegation cost.`,
    }
  }
  const allow = policy.allowedTypes
  if (allow && allow.length > 0 && !allow.includes(input.type)) {
    return {
      allowed: false,
      reason: `worker type "${input.type}" is not in the spawnable allowlist (${allow.join(", ")}).`,
    }
  }
  return { allowed: true }
}
