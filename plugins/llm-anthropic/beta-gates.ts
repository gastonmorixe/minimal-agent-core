/**
 * Shared MODEL-gated beta-flag decisions for the Anthropic wire builders.
 *
 * Refactor Wave 2a: both transports' flag assemblers used to hand-mirror
 * these decisions ("this MUST mirror the canonical transport's test"
 * comments in each), and every new-model wire bug so far (the fable-5
 * context-1m P0, the duplicated opus-4-8 interleaved gate) came from that
 * split. This module is the single source of truth for the decisions that
 * depend on WHICH model is addressed; the per-request-kind set composition
 * stays in each builder (unified later, at the transport flip).
 *
 * Resolution order: model registry capabilities when the id is registered
 * (or aliased, incl. `[1m]` suffixes); otherwise a conservative substring
 * fallback that preserves the legacy behavior for unregistered ids.
 *
 * Lives in the PROVIDER PLUGIN: Anthropic logic belongs here, never in
 * core. The legacy `src/headers.ts` importing from this plugin is an
 * acknowledged inversion that exists only because headers.ts itself is
 * misplaced Anthropic code awaiting dissolution (Wave 4); the entire
 * legacy module migrates here, at which point the import collapses to a
 * plugin-internal one. Do NOT read this as license for core → plugin
 * imports elsewhere.
 *
 * @module llm/providers/anthropic/beta-gates
 */

import { findModel } from "../../src/llm/model-registry.ts"

/**
 * Should requests for `modelId` carry `context-1m-2025-08-07`?
 *
 * True when the id opts in via the client-side `[1m]` suffix, when the
 * registered model's context window is 1M+, or (unregistered fallback)
 * when the id belongs to a known 1M-native family. The fallback list
 * mirrors what the legacy builder shipped (opus 4.6/4.7/4.8, sonnet 4.6,
 * fable 5) so unregistered/early-boot callers keep today's behavior.
 *
 * Historical caveat (T-f51m29): pre-overage accounts 429 on sonnet long
 * context ("Extra usage is required..."); `parseModelUnavailableError`
 * catches that shape and reopens the model picker.
 */
export function wants1mContext(modelId: string | undefined): boolean {
  if (!modelId) return false
  if (/\[1m\]/i.test(modelId)) return true
  const entry = findModel(modelId)
  if (entry) return entry.capabilities.contextWindow >= 1_000_000
  return (
    modelId.includes("opus-4-6") ||
    modelId.includes("opus-4-7") ||
    modelId.includes("opus-4-8") ||
    modelId.includes("sonnet-4-6") ||
    modelId.includes("sonnet-5") ||
    modelId.includes("fable-5")
  )
}

/**
 * Should `interleaved-thinking-2025-05-14` be OMITTED for `modelId`?
 *
 * Opus 4.8 only: under this beta it emits huge parallel tool batches whose
 * mid-turn thinking hallucinates same-turn tool results and spirals
 * (wire-proven; TODOS.md T-7c3f02). The gate is id-based on purpose: the
 * pathology tracks the MODEL, and no capability field expresses it.
 * Fable-5 (the 4.8 capability twin) currently KEEPS the beta pending the
 * T-fab1e5 wire test; extend the match here (one place now) if it shares
 * the behavior. `MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING=1` overrides
 * for experiments.
 */
export function omitsInterleavedThinking(modelId: string | undefined): boolean {
  if (process.env.MINIMAL_AGENT_FORCE_INTERLEAVED_THINKING === "1") return false
  return !!modelId && modelId.includes("opus-4-8")
}
