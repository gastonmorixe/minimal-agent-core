/**
 * Resolve the media capability context the agent threads into media-aware
 * tools (currently `Read`) for the ACTIVE model.
 *
 * Provider-neutral: it reads the resolved {@link ModelEntry}'s
 * {@link ModalitySupport} from the shared registry and the active provider's
 * `mediaLimits(model)` hook when it exposes one, falling back to the Anthropic
 * defaults (the only concrete limits shipped today). Returning a context even
 * for a non-vision model is deliberate : the tool then explains "this model
 * doesn't accept images" instead of decoding a screenshot as UTF-8 mojibake.
 * An unresolved model id yields `undefined`, which keeps the tool on its
 * legacy text-only path (no behavior change for unknown models / older
 * sessions).
 *
 * @module media/tool-context
 */

import { normalizeModelForAPI } from "../client/types.ts"
import { findModel, findProvider } from "../llm/model-registry.ts"

import { anthropicMediaLimits } from "./anthropic.ts"
import type { ReadFileMediaContext } from "./read-file.ts"

/**
 * Build a {@link ReadFileMediaContext} for `modelId`, or `undefined` when the
 * id can't be resolved in the registry.
 */
export function resolveToolMediaContext(
  modelId: string | undefined,
): ReadFileMediaContext | undefined {
  if (!modelId) return undefined
  const entry = findModel(normalizeModelForAPI(modelId))
  if (!entry) return undefined
  const caps = entry.capabilities
  const provider = findProvider(entry.providerId)
  const limits =
    provider?.mediaLimits?.(entry) ?? anthropicMediaLimits({ contextWindow: caps.contextWindow })
  return { modalities: caps.modalities, limits, modelId: entry.id }
}
