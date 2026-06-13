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
   * `makeCharRatioEstimator` (in `./token-estimate.ts`) in each
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
 * Neutral, provider-free fallback id used by {@link getDefaultModelId} when
 * the registry is empty AND no default was declared. It is deliberately NOT
 * a provider SKU : core must name no provider token. A boot path that reaches
 * this (no provider plugin activated) has no real model to talk to anyway;
 * the id only has to be a stable non-empty placeholder so downstream lookups
 * degrade predictably (`findModel` returns `undefined`, transports apply their
 * own defaults).
 */
const FALLBACK_MODEL_ID = "default"

/**
 * Optional explicitly-declared default model id. A provider plugin (or config)
 * calls {@link setDefaultModelId} during registration to nominate the model a
 * no-model session should boot with. `null` ⇒ none declared; the resolver then
 * falls back to the first registered model.
 */
let declaredDefaultModelId: string | null = null

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

/**
 * Find the first registered model for `providerId` whose `tags` include EVERY
 * tag in `mustHave`. Insertion order wins (so a provider lists its preferred
 * model first). Returns `undefined` when none match. Used by a provider's
 * `recommendSubagentModels` to pick a role's model from its OWN catalog by tier
 * tag, instead of hardcoding a SKU that could drift on a rename.
 */
export function findModelByTags(
  providerId: string,
  mustHave: readonly string[],
): ModelEntry | undefined {
  for (const m of models.values()) {
    if (m.providerId !== providerId) continue
    const tags = m.tags ?? []
    if (mustHave.every((t) => tags.includes(t))) return m
  }
  return undefined
}

/**
 * Declare the default model a no-model session should boot with. A provider
 * plugin (or config) calls this so the agent entrypoint picks a default
 * without naming a provider SKU in core code. Last write wins; pass `null`
 * to clear the declaration and fall back to the first registered model.
 */
export function setDefaultModelId(id: string | null): void {
  declaredDefaultModelId = id
}

/**
 * Resolve the default model id for a session started with no explicit model.
 *
 * Resolution order (all provider-neutral : core names no SKU):
 *   1. an explicitly declared default ({@link setDefaultModelId}), when still
 *      registered;
 *   2. the FIRST registered model (insertion order : a provider lists its
 *      preferred model first);
 *   3. a neutral placeholder ({@link FALLBACK_MODEL_ID}) when the registry is
 *      empty (no provider activated) : never a provider literal.
 */
export function getDefaultModelId(): string {
  if (declaredDefaultModelId && models.has(declaredDefaultModelId)) {
    return declaredDefaultModelId
  }
  const first = models.keys().next()
  if (!first.done) return first.value
  return FALLBACK_MODEL_ID
}

/** Clear all registrations. Tests only. */
export function clearModelRegistry(): void {
  models.clear()
  aliases.clear()
  declaredDefaultModelId = null
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

const providers = new Map<string, ProviderAdapter>()

/** Registers (or replaces) a provider adapter under its `id`; later registrations win. */
export function registerProvider(adapter: ProviderAdapter): void {
  providers.set(adapter.id, adapter)
}

/** Looks up a provider adapter by id, returning `undefined` when none is registered. */
export function findProvider(id: string): ProviderAdapter | undefined {
  return providers.get(id)
}

/**
 * Like {@link findProvider} but throws on a miss, listing the registered
 * provider ids in the error so a typo is immediately diagnosable.
 */
export function resolveProvider(id: string): ProviderAdapter {
  const p = providers.get(id)
  if (!p) {
    throw new Error(
      `unknown provider "${id}". Registered: ${[...providers.keys()].sort().join(", ")}`,
    )
  }
  return p
}

/** All currently registered provider adapters, in registration order. */
export function listRegisteredProviders(): ProviderAdapter[] {
  return [...providers.values()]
}

/** Empties the provider registry. Intended for test isolation, not production code. */
export function clearProviderRegistry(): void {
  providers.clear()
}
