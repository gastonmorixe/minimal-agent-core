/**
 * Tool advertisement policy — pure, host-agnostic helpers for the modern SDK.
 *
 * **Advertisement vs dispatch**
 *
 * - *Advertisement* shapes the tools array sent to the model (request body).
 *   That is this module + the {@link ToolAdvertisementFilter} port.
 * - *Dispatch* refuses a tool_use after the model names a tool (mode permissions,
 *   teaching errors). That stays on {@link ModeManager.isToolAllowed} / the
 *   tool executor — never here.
 *
 * Hosts (CLI `--tools` / `--no-tools`, in-process SDK callers, tests) build a
 * {@link ToolNamePolicy} and either:
 *   - pass `toolFilterFromNamePolicy(policy)` into {@link AgentCoreConfig.toolFilter}, or
 *   - call {@link applyToolNamePolicy} directly for banners, digests, legacy loops.
 *
 * @module sdk/tool-filter
 */

import type { ToolAdvertisementFilter, ToolDefinition } from "./ports.ts"

/**
 * Name-based policy for which tools the model may be advertised.
 *
 * - `{ kind: "allow-list", tools }` — only these tool names
 * - `{ kind: "deny-all" }` — no tools (pure Q&A)
 * - `null` — no policy; advertise the full registry
 */
export type ToolNamePolicy =
  | { readonly kind: "allow-list"; readonly tools: readonly string[] }
  | { readonly kind: "deny-all" }
  | null

/**
 * Apply a {@link ToolNamePolicy} to any `{ name }` list (tool defs, banner
 * entries, hash digests). Pure: no I/O, stable order of survivors.
 *
 * @param tools - Candidate tools in registration order
 * @param policy - CLI/SDK name policy, or `null` for pass-through
 * @returns Survivors in the same order as `tools`
 */
export function applyToolNamePolicy<T extends { name: string }>(
  tools: readonly T[],
  policy: ToolNamePolicy,
): T[] {
  if (!policy) return tools as T[]
  if (policy.kind === "deny-all") return []
  if (policy.kind === "allow-list") {
    return tools.filter((t) => policy.tools.includes(t.name))
  }
  // Exhaustiveness for future policy kinds.
  const _exhaustive: never = policy
  return _exhaustive
}

/**
 * Build a {@link ToolAdvertisementFilter} port from a {@link ToolNamePolicy}.
 *
 * Prefer this when wiring {@link AgentCore} so the core depends only on the
 * structural port, not on CLI/mode types.
 */
export function toolFilterFromNamePolicy(policy: ToolNamePolicy): ToolAdvertisementFilter {
  return {
    filter(tools: readonly ToolDefinition[]): ToolDefinition[] {
      return applyToolNamePolicy(tools, policy)
    },
  }
}

/**
 * Whether a single tool name is permitted by a {@link ToolNamePolicy}.
 *
 * Used by dispatch-time gates that need a yes/no without building a filtered
 * array. `null` policy → always permitted.
 */
export function isToolNameAllowed(
  toolName: string,
  policy: ToolNamePolicy,
): { allowed: true } | { allowed: false; reason: "deny-all" | "allow-list" } {
  if (!policy) return { allowed: true }
  if (policy.kind === "deny-all") return { allowed: false, reason: "deny-all" }
  if (policy.kind === "allow-list") {
    return policy.tools.includes(toolName)
      ? { allowed: true }
      : { allowed: false, reason: "allow-list" }
  }
  const _exhaustive: never = policy
  return _exhaustive
}
