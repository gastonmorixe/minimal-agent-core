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

import { defaultMediaLimits } from "../media/default-limits.ts"
import type { ResolvedUtilityModel } from "../plugins/host/capabilities.ts"
import {
  DEFAULT_SIDE_MAX_USD_PER_MTOK_OUT,
  DEFAULT_TITLE_MAX_USD_PER_MTOK_IN,
  passesPriceCeilings,
} from "../plugins/host/providers/llm-side.ts"
import type { ModelInfoSnapshot, SubagentModelRecommendation } from "../plugins/types.ts"

import { resolveInputMimeTypes } from "./capabilities.ts"
import {
  findModel,
  findModelForProvider,
  findProvider,
  type ModelEntry,
  resolveModel,
} from "./model-registry.ts"
import { canonicalProviderId } from "./provider-plugin.ts"

/** Short format label of a MIME type (`image/jpeg` to `jpeg`, `text/plain` to `txt`). */
function formatLabel(mime: string): string {
  const sub = mime.split("/")[1] ?? mime
  if (sub === "plain") return "txt"
  if (sub === "mpeg") return mime.startsWith("audio/") ? "mp3" : "mpeg"
  if (sub === "quicktime") return "mov"
  if (sub.startsWith("vnd.openxmlformats-officedocument.")) {
    if (sub.endsWith(".document")) return "docx"
    if (sub.endsWith(".sheet")) return "xlsx"
    if (sub.endsWith(".presentation")) return "pptx"
  }
  return sub
}

/**
 * Accepted input formats per kind, from the model's resolved MIME list (the
 * same list the media gate uses: `inputMimeTypes`, else the provider's
 * `mediaLimits(model)` filtered by the modality flags).
 */
function acceptedInputOf(mimes: readonly string[]): ModelInfoSnapshot["acceptedInput"] {
  const out: ModelInfoSnapshot["acceptedInput"] = {}
  const add = (key: keyof ModelInfoSnapshot["acceptedInput"], mime: string): void => {
    const label = formatLabel(mime)
    const list = out[key] ?? []
    if (!list.includes(label)) list.push(label)
    out[key] = list
  }
  for (const m of mimes) {
    if (m.startsWith("image/")) add("images", m)
    else if (m.startsWith("audio/")) add("audio", m)
    else if (m.startsWith("video/")) add("video", m)
    else add("documents", m)
  }
  return out
}

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
  const limits = findProvider(entry.providerId)?.mediaLimits?.(entry) ?? defaultMediaLimits()
  const acceptedInput = acceptedInputOf(resolveInputMimeTypes(c, limits.acceptedMimeTypes))

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
      ...(entry.pricing.cacheWrite1hUSD !== undefined
        ? { cacheWrite1hPerMTok: entry.pricing.cacheWrite1hUSD }
        : {}),
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

/** Options of {@link resolveUtilityModel}. */
export interface ResolveUtilityModelOptions {
  /**
   * Price ceiling in USD per 1M input tokens (SPEC §4.2 M2). Default
   * {@link DEFAULT_TITLE_MAX_USD_PER_MTOK_IN}. A model with no known price
   * fails; a `0` price (subscription or local) passes.
   */
  maxUsdPerMTokIn?: number
  /**
   * Price ceiling in USD per 1M output tokens (B6). Default
   * {@link DEFAULT_SIDE_MAX_USD_PER_MTOK_OUT}. A model with no known output
   * price fails; a `0` price passes.
   */
  maxUsdPerMTokOut?: number
  /**
   * The model of the session. It is used only when
   * {@link ResolveUtilityModelOptions.allowSessionModel} is true (last step).
   */
  sessionModelId?: string
  /**
   * Opt-in last step: the session model, only when it has structured outputs
   * and passes the price ceiling. Default false: never the session model.
   */
  allowSessionModel?: boolean
}

/** The input and output price ceilings of one resolve call. */
interface Ceilings {
  input: number
  output: number
}

function passesCeiling(entry: ModelEntry, c: Ceilings): boolean {
  return passesPriceCeilings(entry, c.input, c.output)
}

function structuredOf(entry: ModelEntry): ResolvedUtilityModel["structured"] {
  return entry.capabilities?.structuredOutputs === true ? "json_schema" : "none"
}

/** The provider profile fields of a resolved utility model (R11). */
interface UtilityProfile {
  thinkingOff?: boolean
  effort?: ResolvedUtilityModel["effort"]
  stream?: ResolvedUtilityModel["stream"]
}

const EFFORTS: readonly string[] = ["low", "medium", "high"]
const STREAMS: readonly string[] = ["off", "required"]

function toResolved(
  entry: ModelEntry,
  structured: ResolvedUtilityModel["structured"],
  profile: UtilityProfile = {},
): ResolvedUtilityModel {
  return {
    modelId: entry.id,
    providerId: entry.providerId,
    structured,
    ...(profile.thinkingOff !== undefined ? { thinkingOff: profile.thinkingOff } : {}),
    ...(profile.effort !== undefined ? { effort: profile.effort } : {}),
    ...(profile.stream !== undefined ? { stream: profile.stream } : {}),
    ...(entry.pricing ? { pricing: { ...entry.pricing } } : {}),
  }
}

/** The adapter recommendation of the provider (R11), if it resolves and passes the ceiling. */
function fromAdapter(providerId: string, ceiling: Ceilings): ResolvedUtilityModel | undefined {
  const adapter = findProvider(providerId)
  if (!adapter?.recommendUtilityModel) return undefined
  let rec: ReturnType<NonNullable<typeof adapter.recommendUtilityModel>>
  try {
    rec = adapter.recommendUtilityModel()
  } catch {
    return undefined
  }
  if (!rec || typeof rec.modelId !== "string" || rec.modelId === "") return undefined
  const entry = findModelForProvider(rec.modelId, providerId)
  if (!entry || !passesCeiling(entry, ceiling)) return undefined
  const structured = rec.structured === "json_schema" ? "json_schema" : "none"
  return toResolved(entry, structured, {
    ...(typeof rec.thinkingOff === "boolean" ? { thinkingOff: rec.thinkingOff } : {}),
    ...(typeof rec.effort === "string" && EFFORTS.includes(rec.effort)
      ? { effort: rec.effort }
      : {}),
    ...(typeof rec.stream === "string" && STREAMS.includes(rec.stream)
      ? { stream: rec.stream }
      : {}),
  })
}

/**
 * The cheap utility model of `providerId` (SPEC §4.1-4.2), for short side
 * calls such as a session title. Provider-agnostic. The provider owns the
 * choice (SPEC §4.3 R11): ONLY the provider adapter `recommendUtilityModel()`
 * counts. There is no tag fallback: no recommendation ⇒ `undefined` (no
 * title call). The result carries the provider profile (`thinkingOff`,
 * `effort`, `stream`).
 *
 * The candidate must be a model of THIS provider and pass the input and
 * output price ceilings (unknown price fails). The session model is never a
 * fallback, unless `allowSessionModel` is set (then only with structured
 * outputs and under the ceiling). Never throws.
 *
 * @param providerId - The provider id (canonicalized; former ids resolve).
 * @param opts - Price ceiling and the opt-in session model step.
 * @returns The resolved model, or `undefined` when no candidate passes.
 */
export function resolveUtilityModel(
  providerId: string,
  opts: ResolveUtilityModelOptions = {},
): ResolvedUtilityModel | undefined {
  if (typeof providerId !== "string" || providerId === "") return undefined
  try {
    const provider = canonicalProviderId(providerId)
    const ceiling: Ceilings = {
      input: opts.maxUsdPerMTokIn ?? DEFAULT_TITLE_MAX_USD_PER_MTOK_IN,
      output: opts.maxUsdPerMTokOut ?? DEFAULT_SIDE_MAX_USD_PER_MTOK_OUT,
    }
    const adapted = fromAdapter(provider, ceiling)
    if (adapted) return adapted
    if (opts.allowSessionModel && opts.sessionModelId) {
      const entry = findModelForProvider(opts.sessionModelId, provider)
      if (entry && structuredOf(entry) === "json_schema" && passesCeiling(entry, ceiling)) {
        return toResolved(entry, "json_schema")
      }
    }
  } catch {
    // A broken registry or provider id: no utility model.
  }
  return undefined
}
