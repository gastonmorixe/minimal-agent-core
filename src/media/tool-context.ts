/**
 * Resolve the media capability context the agent threads into media-aware
 * tools (currently `Read`) for the ACTIVE model.
 *
 * Provider-neutral: it reads the resolved {@link ModelEntry}'s
 * {@link ModalitySupport} from the shared registry and the active provider's
 * `mediaLimits(model)` hook when it exposes one, falling back to the NEUTRAL
 * conservative floor in `./default-limits.ts` (DIP: providers supply their
 * real walls through the hook; core never imports provider modules).
 * Returning a context even for a non-vision model is deliberate : the tool
 * then explains "this model doesn't accept images" instead of decoding a
 * screenshot as UTF-8 mojibake. An unresolved model id yields `undefined`,
 * which keeps the tool on its legacy text-only path (no behavior change for
 * unknown models / older sessions).
 *
 * @module media/tool-context
 */

import { normalizeModelForAPI } from "../client/types.ts"
import { type ModalitySupport, resolveInputMimeTypes } from "../llm/capabilities.ts"
import { findModel, findProvider } from "../llm/model-registry.ts"

import { defaultMediaLimits } from "./default-limits.ts"
import type { MediaLimits } from "./limits.ts"
import type { ReadFileMediaContext } from "./read-file.ts"

/** The media gate of one resolved model: its limits, modality flags and id. */
export interface ModelMediaContext {
  /**
   * The provider's `mediaLimits(model)` (or the neutral floor), with
   * `acceptedMimeTypes` replaced by the model's resolved input list
   * (`resolveInputMimeTypes`).
   */
  limits: MediaLimits
  modalities: ModalitySupport
  /** The registry id of the model. */
  modelId: string
}

/**
 * Resolve the media gate of `modelId` from the shared registry: the
 * provider's `mediaLimits(model)` hook (or the neutral floor) and the model's
 * accepted input MIME types. The single resolver for the tool, submit and
 * paste paths. `undefined` when the id is absent or not registered.
 */
export function resolveModelMediaContext(
  modelId: string | undefined,
): ModelMediaContext | undefined {
  if (!modelId) return undefined
  const entry = findModel(normalizeModelForAPI(modelId))
  if (!entry) return undefined
  const caps = entry.capabilities
  const provider = findProvider(entry.providerId)
  const base = provider?.mediaLimits?.(entry) ?? defaultMediaLimits()
  const accepted = resolveInputMimeTypes(caps, base.acceptedMimeTypes)
  const limits: MediaLimits = { ...base, acceptedMimeTypes: new Set(accepted) }
  return { limits, modalities: caps.modalities, modelId: entry.id }
}

/**
 * Build a {@link ReadFileMediaContext} for `modelId`, or `undefined` when the
 * id can't be resolved in the registry.
 */
export function resolveToolMediaContext(
  modelId: string | undefined,
): ReadFileMediaContext | undefined {
  const ctx = resolveModelMediaContext(modelId)
  if (!ctx) return undefined
  return { modalities: ctx.modalities, limits: ctx.limits, modelId: ctx.modelId }
}
