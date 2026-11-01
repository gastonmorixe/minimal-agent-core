/**
 * Host-facing model rows (WEB-PLUGINS-001).
 *
 * Maps each registered {@link ModelEntry} to a flat {@link ModelRow} that a
 * host can send as JSON (for example, a web `GET /api/models` route). The
 * row holds data only. It has no functions, so it serializes as is.
 *
 * @module adapters/model-view
 */

import type { Capabilities } from "@minimal-agent/core/plugin-api/llm/capabilities"

import { listRegisteredModels, type ModelEntry } from "../llm/model-registry.ts"
import type { MTokRate } from "../llm/pricing.ts"

/** One registered model, as a host shows it. */
export interface ModelRow {
  /** Canonical model id. */
  readonly id: string
  /** Id of the provider that registered the model. */
  readonly providerId: string
  /** Human-readable model name. */
  readonly displayName: string
  /** Max input tokens. Copied from `capabilities.contextWindow`. */
  readonly contextWindow: number
  /** Default per-million-token rates. */
  readonly rates: MTokRate
  /** Full capability record. */
  readonly capabilities: Capabilities
}

/** Map one registry entry to a {@link ModelRow}. */
export function toModelRow(entry: ModelEntry): ModelRow {
  return {
    id: entry.id,
    providerId: entry.providerId,
    displayName: entry.displayName,
    contextWindow: entry.capabilities.contextWindow,
    rates: entry.pricing,
    capabilities: entry.capabilities,
  }
}

/**
 * List every registered model as a {@link ModelRow}, in registration order.
 * Two providers that register the same bare id give two rows.
 */
export function listBootedModels(): ModelRow[] {
  return listRegisteredModels().map(toModelRow)
}
