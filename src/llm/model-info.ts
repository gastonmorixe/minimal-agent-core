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

import type { ModelInfoSnapshot } from "../plugins/types.ts"

import { resolveModel } from "./model-registry.ts"

/** Standard image input formats accepted by current vision models. */
const IMAGE_FORMATS = ["jpeg", "png", "gif", "webp"]
/** Document formats accepted by document-capable models. */
const DOCUMENT_FORMATS = ["pdf", "txt"]

/**
 * Snapshot the capabilities of `modelId`. When the id is not registered (e.g.
 * a provider plugin isn't loaded), returns a best-effort snapshot with
 * `resolved:false` and conservative defaults so callers always get a value.
 */
export function buildModelInfoSnapshot(modelId: string): ModelInfoSnapshot {
  let entry: ReturnType<typeof resolveModel> | undefined
  try {
    entry = resolveModel(modelId)
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
