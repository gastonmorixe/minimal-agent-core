/**
 * Build a live {@link ModelInfoSnapshot} for a model id, reading the shared
 * model registry that provider plugins populate. Provider-agnostic: it does not
 * import or know about any specific provider, it just resolves whatever the
 * registry holds for `modelId`. The host hands a closure over this to the
 * plugin loader so a decoupled `ModelInfo` tool can report the CURRENT model's
 * capabilities (correct across mid-session switches + resume) without importing
 * host internals itself.
 *
 * @module llm/model-info
 */

import type { ModelInfoSnapshot, SubagentModelRecommendation } from "../plugins/types.ts"

import { findModel, findProvider, resolveModel } from "./model-registry.ts"

/** Standard image input formats accepted by current vision models. */
const IMAGE_FORMATS = ["jpeg", "png", "gif", "webp"]
/** Document formats accepted by document-capable models. */
const DOCUMENT_FORMATS = ["pdf", "txt"]

/**
 * Snapshot the capabilities of `modelId`. When the id is not registered (e.g.
 * a provider plugin isn't loaded), returns a best-effort snapshot with
 * `resolved:false` and conservative defaults so callers always get a value.
 */
export function buildModelInfoSnapshot(modelId: string, providerId?: string): ModelInfoSnapshot {
  let entry: ReturnType<typeof resolveModel> | undefined
  try {
    entry = resolveModel(modelId, providerId)
  } catch {
    entry = undefined
  }

  if (!entry) {
    return {
      modelId,
      displayName: modelId || "(unknown)",
      providerId: "unknown",
      surfaceId: "unknown",
      contextWindow: 0,
      maxOutputTokens: 0,
      modalities: { image: false, audio: false, pdf: false, video: false },
      acceptedInput: {},
      thinking: { adaptive: false, extended: false, visible: false, interleaved: false },
      effort: { levels: [], default: "medium" },
      caching: { explicit: false, automatic: false, ttls: [], reportsCacheHits: false },
      tools: { userDefined: false, parallel: false },
      serverTools: [],
      pricing: { inputPerMTok: 0, outputPerMTok: 0, cacheWritePerMTok: 0, cacheReadPerMTok: 0 },
      resolved: false,
    }
  }

  const c = entry.capabilities
  const acceptedInput: ModelInfoSnapshot["acceptedInput"] = {}
  if (c.modalities.image) acceptedInput.images = [...IMAGE_FORMATS]
  if (c.modalities.pdf) acceptedInput.documents = [...DOCUMENT_FORMATS]

  return {
    modelId: entry.id,
    displayName: entry.displayName,
    providerId: entry.providerId,
    surfaceId: entry.surfaceId,
    knowledgeCutoff: entry.knowledgeCutoff,
    contextWindow: c.contextWindow,
    maxOutputTokens: c.maxOutputTokens,
    modalities: { ...c.modalities },
    acceptedInput,
    thinking: { ...c.thinking },
    effort: { levels: [...c.effort.levels], default: c.effort.default },
    caching: {
      explicit: c.caching.explicit,
      automatic: c.caching.automatic,
      ttls: [...c.caching.ttls],
      reportsCacheHits: c.caching.reportsCacheHits,
    },
    tools: { userDefined: c.tools.userDefined, parallel: c.tools.parallel },
    serverTools: [...c.serverTools],
    pricing: {
      inputPerMTok: entry.pricing.inputUSD,
      outputPerMTok: entry.pricing.outputUSD,
      cacheWritePerMTok: entry.pricing.cacheWriteUSD,
      cacheReadPerMTok: entry.pricing.cacheReadUSD,
    },
    resolved: true,
  }
}

/**
 * Ask the provider that owns `modelId` which of ITS models suit each abstract
 * sub-agent role. Provider-agnostic: resolves the model's provider from the
 * shared registry and delegates to that provider's optional
 * `recommendSubagentModels` port. The host hands a closure over this to the
 * plugin loader as `ctx.recommendSubagentModels`, so the delegation plugin maps
 * a worker role → concrete model without importing the registry or any provider.
 *
 * Returns `[]` when the model/provider isn't resolvable or the provider offers
 * no recommendations (the caller then falls back to the lead's own model).
 */
export function buildSubagentModelRecommendations(modelId: string): SubagentModelRecommendation[] {
  const entry = findModel(modelId)
  if (!entry) return []
  const provider = findProvider(entry.providerId)
  if (!provider?.recommendSubagentModels) return []
  try {
    return provider.recommendSubagentModels()
  } catch {
    return []
  }
}
