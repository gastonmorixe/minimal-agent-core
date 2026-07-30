/**
 * Model + provider registries.
 *
 * `ModelEntry` is the per-model record (id, provider id, surface id,
 * capabilities, pricing, display metadata). The registry supports two
 * lookup modes:
 *
 * - **Global** (`findModel(id)`): returns the last-registered entry for
 *   backwards compatibility. Call sites without provider context (legacy
 *   label formatting, stats) use this.
 * - **Scoped** (`findModelForProvider(id, providerId)`): returns the
 *   entry registered by the specified provider. Used at dispatch sites
 *   where the caller knows which provider was selected (agent booted
 *   with `--provider <id>`, REPL `.model` switch). When two providers
 *   register the same bare model ID (e.g. both OpenCode and Wafer claim
 *   `deepseek-v4-flash`), the scoped lookup disambiguates. Without it,
 *   last-write-wins silently routes to the wrong adapter.
 *
 * `ProviderAdapter` instances register themselves separately. `run()`
 * (`src/llm/run.ts`) joins the two: resolve `modelId` → `ModelEntry`,
 * resolve `model.providerId` → `ProviderAdapter`, dispatch.
 *
 * Both registries are module-level singletons. Providers register on
 * import. Models register on import of the provider's `models.ts`.
 * Re-registration with the same (id, providerId) is last-write-wins.
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
 * `vendorIds` is a provider-owned route-name map. Core treats the keys as
 * opaque strings; each plugin decides which route labels it supports.
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
  /** Provider-owned route ids for wire-model selection. */
  vendorIds?: Readonly<Record<string, string>>
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

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

const models = new Map<string, ModelEntry>()
const aliases = new Map<string, string>()

/**
 * Per-model-ID map of provider → entry. Used by
 * {@link findModelForProvider} to disambiguate when two providers
 * register the same bare model ID.
 */
const modelsByProvider = new Map<string, Map<string, ModelEntry>>()

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
  // Global registry: last write wins (backwards compatible for
  // un-scoped callers — they get whichever provider registered last).
  models.set(entry.id, entry)
  // Scoped registry: per-provider entries never collide cross-provider.
  let perModel = modelsByProvider.get(entry.id)
  if (!perModel) {
    perModel = new Map()
    modelsByProvider.set(entry.id, perModel)
  }
  perModel.set(entry.providerId, entry)

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
export function resolveModel(idOrAlias: string, providerId?: string): ModelEntry {
  if (providerId) {
    const entry = findModelForProvider(idOrAlias, providerId)
    if (entry) return entry
    throw new Error(
      `unknown model "${idOrAlias}" for provider "${providerId}". ` +
        `Registered: ${[...models.keys()].sort().join(", ")}`,
    )
  }
  const entry = findModel(idOrAlias)
  if (!entry) {
    throw new Error(
      `unknown model "${idOrAlias}". Registered: ${[...models.keys()].sort().join(", ")}`,
    )
  }
  return entry
}

/**
 * Look up a model by id, scoped to a specific provider. Returns the
 * entry registered by `providerId` when present; otherwise falls back
 * to the global last-write-wins entry. Use this at dispatch sites that
 * have explicit provider context (agent booted with --provider, REPL
 * .model switch).
 *
 * Aliases are resolved through the global alias table (they are
 * provider-independent — an alias like `opus` always maps to one
 * canonical id).
 */
export function findModelForProvider(
  idOrAlias: string,
  providerId: string,
): ModelEntry | undefined {
  // Resolve alias first.
  const directId = aliases.get(idOrAlias) ?? idOrAlias
  // Provider-scoped lookup: only return the entry from THIS provider.
  const perModel = modelsByProvider.get(directId)
  if (perModel) {
    const scoped = perModel.get(providerId)
    if (scoped) return scoped
  }
  // No entry for this provider → not found. Do NOT fall back to
  // another provider's entry: the caller explicitly asked for this
  // provider, and a silent cross-provider return would route to the
  // wrong adapter.
  return undefined
}

/**
 * Like {@link findModelForProvider} but throws on a miss.
 */
export function resolveModelForProvider(idOrAlias: string, providerId: string): ModelEntry {
  const entry = findModelForProvider(idOrAlias, providerId)
  if (!entry) {
    throw new Error(
      `unknown model "${idOrAlias}" for provider "${providerId}". ` +
        `Registered: ${[...models.keys()].sort().join(", ")}`,
    )
  }
  return entry
}

/** Enumerate registered models. Useful for `--list-models`. */
/**
 * Every registered model entry across all providers.
 *
 * Prefer this over iterating the global last-write-wins map: when two
 * providers register the same bare id (e.g. Ollama + OpenCode both ship
 * `kimi-k2.6`), both entries are returned. Callers that need a single
 * unscoped pick still use {@link findModel}.
 */
export function listRegisteredModels(): ModelEntry[] {
  const out: ModelEntry[] = []
  for (const perProvider of modelsByProvider.values()) {
    for (const entry of perProvider.values()) out.push(entry)
  }
  return out
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
  for (const entry of listRegisteredModels()) {
    if (entry.providerId !== providerId) continue
    const tags = entry.tags ?? []
    if (mustHave.every((t) => tags.includes(t))) return entry
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
  modelsByProvider.clear()
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
