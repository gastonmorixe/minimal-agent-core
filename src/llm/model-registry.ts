/**
 * Model + provider registries.
 *
 * `ModelEntry` is the per-model record (id, provider id, surface id,
 * capabilities, pricing, display metadata). The registry is a flat
 * map keyed by canonical id. Aliases (`claude-opus-4-8[1m]`, dated
 * variants) resolve to the same entry.
 *
 * `ProviderAdapter` instances register themselves separately. `run()`
 * (`src/llm/run.ts`) joins the two: resolve `modelId` → `ModelEntry`,
 * resolve `model.providerId` → `ProviderAdapter`, dispatch.
 *
 * Both registries are module-level singletons. Providers register on
 * import. Models register on import of the provider's `models.ts`.
 * Re-registration with the same id is a no-op (last-write-wins is a
 * common Node-test hazard); call `clearModelRegistry()` /
 * `clearProviderRegistry()` between tests.
 *
 * @module llm/model-registry
 */

import type { Capabilities } from "./capabilities.ts"
import type { MTokRate } from "./pricing.ts"
import type { ProviderAdapter, SurfaceId } from "./provider.ts"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-model record. One entry per canonical id; aliases listed
 * separately. `pricing` is the default rate; some models override at
 * runtime when `speed:"fast"` or other knobs flip.
 *
 * `vendorIds` is the per-deployment-vendor name map (Anthropic-only
 * concept right now : `firstParty`, `bedrock`, `vertex`, `foundry`,
 * `anthropicAws`, `mantle`, `gateway`).
 */
export interface ModelEntry {
  id: string
  aliases?: ReadonlyArray<string>
  providerId: string
  surfaceId: SurfaceId
  displayName: string
  /** ISO 8601 date or "YYYY-MM" string. Informational. */
  knowledgeCutoff?: string
  /** Tags for grouping (e.g. `["opus", "1m-context", "production"]`). */
  tags?: ReadonlyArray<string>
  capabilities: Capabilities
  pricing: MTokRate
  /** Per-cloud-vendor model ids (Anthropic-only today). */
  vendorIds?: Partial<Record<VendorRoute, string>>
  /**
   * Optional override: pick a different pricing rate based on the
   * request (e.g. Anthropic `speed:"fast"` switches Opus 4.8 to the
   * `cx1` rate). Called per-request by the cost calculator.
   */
  pricingForRequest?: (req: import("./canonical-request.ts").CanonicalRequest) => MTokRate
  /**
   * Optional token estimator for this model's tokenizer family. Returns the
   * approximate token count of a piece of text. Used when no billed `usage`
   * was persisted (old sessions, crashes, providers that don't report
   * usage) so a listing can still show a "tokens this session" magnitude,
   * marked as estimated. Built via
   * {@link import("./token-estimate.ts").makeCharRatioEstimator} in each
   * provider's `models.ts`. When absent, callers fall back to the default
   * chars-per-token ratio (see `estimateTokensForModel`).
   */
  estimateTokens?: import("./token-estimate.ts").TokenEstimator
}

/**
 * Per-cloud routing destination. Mirrors the claude-code constant
 * shapes (`fi_.firstParty`, `fi_.bedrock`, etc).
 */
export type VendorRoute =
  | "firstParty"
  | "bedrock"
  | "vertex"
  | "foundry"
  | "anthropicAws"
  | "mantle"
  | "gateway"

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

const models = new Map<string, ModelEntry>()
const aliases = new Map<string, string>()

/**
 * Add or replace a model entry. Throws when `id` collides with an
 * existing alias (and vice versa) to surface registration bugs early.
 */
export function registerModel(entry: ModelEntry): void {
  if (aliases.has(entry.id)) {
    throw new Error(
      `model id "${entry.id}" collides with an existing alias pointing to "${aliases.get(entry.id)}"`,
    )
  }
  models.set(entry.id, entry)
  if (entry.aliases) {
    for (const alias of entry.aliases) {
      if (alias === entry.id) continue
      if (models.has(alias)) {
        throw new Error(`alias "${alias}" collides with an existing model id`)
      }
      aliases.set(alias, entry.id)
    }
  }
}

/**
 * Look up a model by id or alias. Returns `undefined` when not registered.
 */
export function findModel(idOrAlias: string): ModelEntry | undefined {
  const direct = models.get(idOrAlias)
  if (direct) return direct
  const aliasedTo = aliases.get(idOrAlias)
  if (aliasedTo) return models.get(aliasedTo)
  return undefined
}

/**
 * Look up a model by id or alias. Throws when not registered. Use this
 * at dispatch sites where "unknown model" is a programmer error.
 */
export function resolveModel(idOrAlias: string): ModelEntry {
  const entry = findModel(idOrAlias)
  if (!entry) {
    throw new Error(
      `unknown model "${idOrAlias}". Registered: ${[...models.keys()].sort().join(", ")}`,
    )
  }
  return entry
}

/** Enumerate registered models. Useful for `--list-models`. */
export function listRegisteredModels(): ModelEntry[] {
  return [...models.values()]
}

/** Clear all registrations. Tests only. */
export function clearModelRegistry(): void {
  models.clear()
  aliases.clear()
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

const providers = new Map<string, ProviderAdapter>()

export function registerProvider(adapter: ProviderAdapter): void {
  providers.set(adapter.id, adapter)
}

export function findProvider(id: string): ProviderAdapter | undefined {
  return providers.get(id)
}

export function resolveProvider(id: string): ProviderAdapter {
  const p = providers.get(id)
  if (!p) {
    throw new Error(
      `unknown provider "${id}". Registered: ${[...providers.keys()].sort().join(", ")}`,
    )
  }
  return p
}

export function listRegisteredProviders(): ProviderAdapter[] {
  return [...providers.values()]
}

export function clearProviderRegistry(): void {
  providers.clear()
}
